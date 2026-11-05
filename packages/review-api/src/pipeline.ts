import { DescribeExecutionCommand, GetExecutionHistoryCommand, ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { z } from "zod";
import { snapshotBundleSchema, snapshotHash, type DocumentRepository, type HumanContext, type WorkflowRepository } from "@vera/workflow-data";
import { HttpError } from "./auth.js";
import type { ArtifactIO } from "./artifacts.js";

const uuid = z.string().uuid();
const goldenCase = z.object({
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  action: z.enum(["refer_urgently", "home_care_advice", "treat_at_home", "follow_up"]),
  followUp: z.object({ dueInDays: z.number().int().nonnegative(), openForDays: z.number().int().nonnegative() }).nullable().optional(),
}).strict();
const startInput = z.object({
  requestId: uuid,
  pathway: z.string().trim().min(1).max(200),
  requestText: z.string().trim().min(1).max(2000),
  documentId: uuid.optional(),
  baselineChangeId: uuid.optional(),
  goldenCases: z.array(goldenCase).max(100).optional(),
}).strict().refine(v => !(v.documentId && v.baselineChangeId));
const decision = z.object({
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), buildId: z.string().min(1).max(128),
  decisionId: uuid, idempotencyKey: uuid, decision: z.enum(["approve", "reject"]),
  notes: z.string().max(8000).optional(), acknowledgedFlagIds: z.array(z.string()).max(100).default([]),
}).strict();

export class PipelineService {
  private readonly executionPrefix: string;
  private startWindow = { expires: 0, requests: 0 };
  constructor(private sfn: SFNClient, private arn: string, private repo: WorkflowRepository,
    private documents: DocumentRepository, private artifacts: ArtifactIO, private screen: (text: string) => Promise<void>) {
    this.executionPrefix = arn.replace(":stateMachine:", ":execution:") + ":";
  }
  async start(ctx: HumanContext, body: unknown) {
    if (!ctx.groups.includes("program_officer")) throw new HttpError(403, "DEMO_ROLE", "Choose the officer persona to start a change.");
    const input = startInput.parse(body);
    const now = Date.now();
    if (now >= this.startWindow.expires) this.startWindow = { expires: now + 60_000, requests: 0 };
    if (this.startWindow.requests >= 8) throw new HttpError(429, "DEMO_RATE_LIMIT", "The shared preview can start eight runs per minute. Try again shortly.");
    this.startWindow.requests++;
    const baseline = input.baselineChangeId ? await this.repo.getChange(ctx, input.baselineChangeId) : undefined;
    if (baseline && !baseline.contentDecisionKey) throw new HttpError(409, "BASELINE_REQUIRED", "Select a baseline with a current content approval.");
    const baselineBundle = baseline ? await this.readBaseline(ctx, baseline) : undefined;
    const document = input.documentId ? await this.documents.get(ctx, input.documentId) : undefined;
    await this.screen(JSON.stringify([input.pathway, input.requestText, input.goldenCases]));
    const payload = {
      changeId: input.requestId,
      tenant: ctx.tenantId,
      request: {
        changeId: input.requestId,
        requestKind: baseline ? "plain_language_edit" : document ? "guideline_upload" : "pathway_pick",
        requestText: input.requestText,
        pathway: baselineBundle?.spec.pathway ?? input.pathway,
        guideline: baselineBundle?.spec.guideline ?? { name: document?.filename ?? "Synthetic triage protocol", version: String(document?.version ?? 1) },
        ...(baseline ? { baselineSnapshotHash: baseline.snapshotHash, editText: input.requestText } : {}),
        submittedBy: { role: "program_officer", userId: ctx.subject },
      },
      preview: { document: document?.artifact, baselineChangeId: baseline?.changeId, goldenCases: input.goldenCases },
    };
    const serialized = JSON.stringify(payload);
    try {
      await this.sfn.send(new StartExecutionCommand({ stateMachineArn: this.arn, name: input.requestId, input: serialized }));
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "ExecutionAlreadyExists") throw e;
      const existing = await this.sfn.send(new DescribeExecutionCommand({ executionArn: this.executionPrefix + input.requestId }));
      if (existing.input !== serialized) throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "This request ID already names a different pipeline run.");
    }
    return { changeId: input.requestId };
  }
  private async readBaseline(ctx: HumanContext, baseline: Awaited<ReturnType<WorkflowRepository["getChange"]>>) {
    const snapshot = await this.repo.getSnapshot(ctx, baseline.changeId, baseline.snapshotId);
    const bundle = snapshotBundleSchema.parse(JSON.parse(Buffer.from(await this.artifacts.getArtifactVersion(snapshot.artifact)).toString()));
    if (snapshotHash(bundle) !== baseline.snapshotHash) throw new HttpError(409, "BASELINE_MISMATCH", "The approved baseline failed its integrity check.");
    return bundle;
  }
  async list(ctx: HumanContext) {
    const page = await this.sfn.send(new ListExecutionsCommand({ stateMachineArn: this.arn, maxResults: 20 }));
    const items = await Promise.all((page.executions ?? []).map(async (run) => {
      const row = await this.repo.read(this.repo.tables.changes, run.name!, "META");
      return { changeId: run.name!, status: run.status, state: row?.tenantId === ctx.tenantId ? row.state : undefined, startedAt: run.startDate };
    }));
    return { items };
  }
  async read(ctx: HumanContext, id: string) {
    uuid.parse(id);
    const executionArn = this.executionPrefix + id;
    const run = await this.sfn.send(new DescribeExecutionCommand({ executionArn }));
    const input = JSON.parse(run.input ?? "{}");
    if (input.tenant !== ctx.tenantId) throw new HttpError(404, "NOT_FOUND", "Pipeline run not found.");
    const history = await this.sfn.send(new GetExecutionHistoryCommand({ executionArn, reverseOrder: true, includeExecutionData: false, maxResults: 50 }));
    const stage = history.events?.find((event) => event.stateEnteredEventDetails)?.stateEnteredEventDetails?.name;
    const row = await this.repo.read(this.repo.tables.changes, id, "META");
    const build = row?.latestBuildId ? await this.repo.read(this.repo.tables.changes, id, `BUILD#${row.latestBuildId}`) : undefined;
    const test = row?.latestTestId ? await this.repo.read(this.repo.tables.changes, id, row.latestTestId) : undefined;
    return { changeId: id, title: input.request?.pathway, status: run.status, stage, error: run.error,
      state: row?.state, snapshotHash: row?.snapshotHash, buildId: row?.latestBuildId,
      artifactDigest: build?.artifactDigest, testSummary: test?.summary, historyFlags: row?.historyFlags ?? [],
      releaseReady: run.status === "SUCCEEDED" && row?.state === "deployed",
      chtProjectReady: run.status === "SUCCEEDED" && row?.state === "deployed" && Boolean(build?.compilerVersion?.startsWith("vera-preview-cht-")),
    };
  }
  async decide(ctx: HumanContext, id: string, body: unknown) {
    const input = decision.parse(body);
    await this.screen(input.notes ?? "");
    return this.repo.recordDecision(ctx, { ...input, changeId: id, gate: "deploy" });
  }
  async release(ctx: HumanContext, id: string, format: "json" | "cht" = "json") {
    const row = await this.repo.getChange(ctx, id);
    if (row.state !== "deployed") throw new HttpError(409, "RELEASE_PENDING", "The preview artifact is awaiting release.");
    const build = await this.repo.read(this.repo.tables.changes, id, `BUILD#${row.latestBuildId}`);
    if (!build || build.snapshotHash !== row.snapshotHash) throw new HttpError(409, "RELEASE_MISMATCH", "The released artifact does not match the snapshot.");
    const manifest = await this.artifacts.getArtifactVersion(build.artifacts);
    if (format === "json") return manifest;
    const { chtProject } = JSON.parse(Buffer.from(manifest).toString());
    if (!chtProject) throw new HttpError(404, "CHT_PROJECT_UNAVAILABLE", "This release contains a preview artifact only.");
    return this.artifacts.getArtifactVersion(chtProject);
  }
}
