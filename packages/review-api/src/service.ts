import { z } from "zod";
import {
  canonicalJson,
  snapshotBundleSchema,
  snapshotHash,
  WorkflowDataError,
  type HumanContext,
  type AuthoringRecord,
  type AuthoringRepository,
  type WorkflowRepository,
} from "@vera/workflow-data";
import { sha256 } from "@vera/artifact-storage";
import { requirementsSchema } from "@vera/review-model/data/request";
import { buildLogicModel } from "@vera/review-model/data/stubGenerator";
import { reviewDisplaySchema } from "@vera/review-model/data/display-schema";
import { runChecks } from "@vera/review-model/data/checks";
import type { LogicModel } from "@vera/review-model/types/logic-model";
import type { ArtifactIO } from "./artifacts.js";
import { HttpError } from "./auth.js";

const id = z.string().uuid();
export const saveSchema = z
  .object({
    requestId: id,
    expectedVersion: z.number().int().nonnegative().max(1_000_000),
    draft: requirementsSchema,
  })
  .strict();
export const decisionSchema = z
  .object({
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    decisionId: id,
    idempotencyKey: id,
    decision: z.enum(["approve", "reject"]),
    notes: z.string().max(8000).optional(),
  })
  .strict();
export const draftSummary = (r: AuthoringRecord) => ({
  changeId: r.changeId,
  title: r.title,
  authorId: r.authorId,
  version: r.version,
  revisionId: r.revisionId,
  contentHash: r.contentHash,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
export const safeEvent = (r: Record<string, unknown>) =>
  Object.fromEntries(
    [
      "type",
      "actorId",
      "createdAt",
      "snapshotHash",
      "version",
      "contentHash",
      "decisionId",
    ]
      .filter((k) => r[k] !== undefined)
      .map((k) => [k, r[k]]),
  );

export class ReviewService {
  constructor(
    readonly authoring: AuthoringRepository,
    readonly workflow: WorkflowRepository,
    private artifacts: ArtifactIO,
    private screen: (text: string) => Promise<void>,
  ) {}
  async save(ctx: HumanContext, changeId: string | undefined, body: unknown) {
    const input = saveSchema.parse(body);
    const draft = input.draft;
    if (!ctx.groups.includes("program_officer"))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Only program officers can save drafts.",
      );
    if (!changeId && input.expectedVersion !== 0)
      throw new HttpError(
        409,
        "CONFLICT",
        "A new draft must start at version zero.",
      );
    changeId ??= input.requestId;
    const model = buildLogicModel(draft, input.expectedVersion + 1);
    model.snapshotId = input.requestId;
    const checks = runChecks(model);
    const envelope = {
      schemaVersion: 1,
      tenantId: ctx.tenantId,
      changeId,
      authorId: ctx.subject,
      revisionId: input.requestId,
      version: input.expectedVersion + 1,
      draft,
      model,
      checks,
    };
    const bytes = Buffer.from(canonicalJson(envelope));
    const contentHash = sha256(bytes);
    // A confirmed identical retry remains readable even if screening is temporarily down.
    try {
      const prior = await this.authoring.get(ctx, changeId, input.requestId);
      if (prior.contentHash !== contentHash || prior.authorId !== ctx.subject)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This save request was already used for different content.",
        );
      return this.readDraft(ctx, changeId, input.requestId);
    } catch (error) {
      if (!(error instanceof WorkflowDataError && error.code === "NOT_FOUND"))
        throw error;
    }
    await this.screen(bytes.toString());
    let artifact;
    try {
      artifact = await this.artifacts.putArtifact(
        `snapshots/authoring/${ctx.tenantId}/${changeId}/${input.requestId}.json`,
        bytes,
        "application/json",
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Immutable key conflict")
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This save request was already used for different content.",
        );
      throw error;
    }
    const row = await this.authoring.save(ctx, {
      changeId,
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      title: draft.pathway,
      artifact,
      contentHash: sha256(bytes),
    });
    return this.readDraft(ctx, row.changeId, row.revisionId);
  }
  async readDraft(ctx: HumanContext, changeId: string, revisionId?: string) {
    const row = await this.authoring.get(ctx, changeId, revisionId);
    const bytes = await this.artifacts.getArtifactVersion(row.artifact);
    if (sha256(bytes) !== row.contentHash)
      throw new HttpError(
        409,
        "INTEGRITY_ERROR",
        "Saved draft failed its integrity check.",
      );
    const envelope = JSON.parse(Buffer.from(bytes).toString());
    if (
      envelope.tenantId !== ctx.tenantId ||
      envelope.changeId !== row.changeId ||
      envelope.authorId !== row.authorId ||
      envelope.revisionId !== row.revisionId ||
      envelope.version !== row.version
    )
      throw new HttpError(
        409,
        "INTEGRITY_ERROR",
        "Saved draft identity mismatch.",
      );
    const draft = requirementsSchema.parse(envelope.draft);
    return {
      ...draftSummary(row),
      draft,
      model: envelope.model as LogicModel,
      checks: runChecks(envelope.model),
      kind: "authoring" as const,
    };
  }
  async readReview(ctx: HumanContext, changeId: string) {
    const row = await this.workflow.getChange(ctx, changeId);
    const snapshot = await this.workflow.getSnapshot(
      ctx,
      changeId,
      row.snapshotId,
    );
    const bytes = await this.artifacts.getArtifactVersion(snapshot.artifact);
    const bundle = snapshotBundleSchema.parse(
      JSON.parse(Buffer.from(bytes).toString()),
    );
    if (
      snapshotHash(bundle) !== row.snapshotHash ||
      snapshot.snapshotHash !== row.snapshotHash
    )
      throw new HttpError(
        409,
        "INTEGRITY_ERROR",
        "Workflow snapshot failed its integrity check.",
      );
    const raw = bundle.spec as any;
    // Only representation changes (title/options); conditions/actions are passed through unchanged.
    const model: LogicModel = {
      ...raw,
      snapshotId: row.snapshotId,
      snapshotHash: row.snapshotHash,
      pathway:
        typeof raw.pathway === "string"
          ? { id: row.pathwayId, title: raw.pathway }
          : raw.pathway,
      inputs: Array.isArray(raw.inputs)
        ? raw.inputs.map((i: any) => ({
            ...i,
            ...(i.options && !i.choices ? { choices: i.options } : {}),
          }))
        : [],
      rules: raw.rules ?? [],
    };
    const supported = reviewDisplaySchema.safeParse(model).success;
    let checks: ReturnType<typeof runChecks> = [];
    try {
      if (supported) checks = runChecks(model);
    } catch {
      /* Raw snapshot remains available for unsupported models. */
    }
    let validation: unknown = null;
    if (row.validationReport)
      validation = JSON.parse(
        Buffer.from(
          await this.artifacts.getArtifactVersion(row.validationReport),
        ).toString(),
      );
    const canRender = Boolean(
      supported &&
      checks.length &&
      checks.find((c) => c.id === "display")?.status === "pass",
    );
    const roleAllowed = row.requiresClinician
      ? ctx.groups.includes("clinician")
      : ctx.groups.some((g) => g === "clinician" || g === "program_reviewer");
    const gateOpen = row.state === "content_review";
    const canDecide = gateOpen && roleAllowed && ctx.subject !== row.authorId;
    return {
      kind: "workflow" as const,
      changeId,
      model,
      rawSpec: bundle.spec,
      snapshotHash: row.snapshotHash,
      state: row.state,
      authorId: row.authorId,
      checks,
      validation,
      historyFlags: row.historyFlags ?? [],
      canRender,
      canReject: canDecide,
      canApprove:
        canDecide &&
        canRender &&
        validation !== null &&
        !checks.some((c) => c.status === "problem") &&
        !row.openAmbiguities &&
        !(model.flags ?? []).some((f) => f.type === "ambiguity" && !f.resolved),
      decisionReason: !gateOpen
        ? "The workflow is not waiting for content review."
        : !roleAllowed
          ? "Your role cannot decide this review."
          : ctx.subject === row.authorId
            ? "The author needs a different reviewer."
            : !canRender
              ? "This snapshot contains logic this screen cannot display faithfully."
              : validation === null
                ? "The validation report is unavailable."
                : "",
      decisions: await this.workflow.listDecisions(ctx, changeId),
    };
  }
  async decide(ctx: HumanContext, changeId: string, body: unknown) {
    const input = decisionSchema.parse(body);
    const row = await this.workflow.getChange(ctx, changeId);
    // Let the repository reconcile completed identical retries using its durable receipt.
    if (row.state === "content_review") {
      const review = await this.readReview(ctx, changeId);
      if (input.decision === "approve" && !review.canApprove)
        throw new HttpError(
          409,
          "REVIEW_BLOCKED",
          review.decisionReason ||
            "Resolve the check failures before approval.",
        );
      await this.screen(input.notes ?? "");
    }
    return this.workflow.recordDecision(ctx, {
      changeId,
      gate: "content",
      ...input,
    });
  }
}
