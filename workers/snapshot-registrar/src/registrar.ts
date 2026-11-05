import { z } from "zod";
import { parseLogicModel } from "@vera/schemas";
import {
  canonicalJson,
  digestSchema,
  idSchema,
  sha256,
  snapshotBundleSchema,
  snapshotHash,
  WorkflowDataError,
  type ArtifactRef,
  type HumanContext,
  type SnapshotBundle,
  type WorkflowRepository,
} from "@vera/workflow-data";
import { artifactRefSchema } from "@vera/artifact-storage/contracts";

/**
 * Snapshot registration (pipeline-orchestrator Req 2.6, logic-model-snapshots
 * Req 8–9): after Draft or Change Planner, turn the agent's output into one
 * immutable Snapshot_Bundle, store its exact bytes in the artifact bucket, and
 * make it the change's current snapshot in workflow-data.
 *
 * - First snapshot of a change: `createDraft`. Later ones (after a rejection):
 *   `registerRevision`, bound to the hash being replaced.
 * - The Author (`authorId`) is the program officer who submitted the request,
 *   so workflow-data's separation-of-duties check stops them approving it.
 * - Idempotent: a retry for the same content returns the already-registered
 *   snapshot; the artifact write is a conditional immutable put.
 * - workflow-data computes the snapshotHash itself and verifies the stored
 *   bytes before writing any record. Nothing here is approved or applied.
 */

/** The prompt-context pin returned by PromptContextBuilder.prepare() (DraftContext output). */
const SourcePinSchema = z
  .object({
    sourceId: idSchema,
    version: z.string().min(1),
    sourceHash: digestSchema,
    sourceS3Ref: artifactRefSchema,
    provenanceRef: artifactRefSchema,
  })
  .strict();

const Common = {
  changeId: idSchema,
  runId: idSchema,
  tenant: idSchema,
  /** $$.Execution.Id: the execution that will own the change in workflow-data. */
  executionArn: z.string().min(1),
  /** From Intake's StructuredSpec, which copies it from the Review UI's verified identity. */
  submittedBy: z.object({ role: z.literal("program_officer"), userId: z.string().min(1) }).strict(),
  pathway: z.string().min(1).max(200),
};

export const RegisterRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...Common,
      kind: z.literal("draft"),
      /** Drafting Agent output ($.draft.output). */
      logicModel: z.unknown(),
      /** DraftContext output: the guideline pin and the context receipt the model saw. */
      context: z.object({ source: SourcePinSchema, evidenceRef: artifactRefSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...Common,
      kind: z.literal("change_plan"),
      /** Change Planner output ($.changePlan.output); it already carries the full bundle. */
      plan: z
        .object({
          changeId: idSchema,
          snapshotId: idSchema,
          snapshotHash: digestSchema,
          approvalStatus: z.literal("unapproved"),
          hashInputs: z.unknown(),
        })
        .passthrough(),
    })
    .strict(),
]);
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/** Values the bundle needs for a new pathway; edits take them from their baseline bundle. */
export interface RegistrarConfig {
  /** Snapshot_Bundle format version. */
  schemaVersion: string;
  goldenCaseVersion: string;
  compilerVersion: string;
  /** `sha256:` digest of the pinned medicmobile/cht-app-ide image. */
  toolchainImageDigest: string;
}

export interface RegistrarDeps {
  repo: WorkflowRepository;
  artifacts: { putArtifact(key: string, body: Uint8Array, contentType: string): Promise<ArtifactRef> };
  config: RegistrarConfig;
}

export interface Registration {
  snapshotId: string;
  snapshotHash: string;
  pathwayId: string;
  artifact: ArtifactRef;
  registration: "created" | "revised" | "already_registered";
}

export type RegisterResult =
  | { ok: true; output: Registration }
  | { ok: false; failure: { code: string; message: string } };

/** Thrown when workflow-data is still delivering a callback for this change; safe to retry. */
export class RegistrarBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrarBusy";
  }
}

/** Baseline revision recorded for a first draft of a pathway (no earlier snapshot). */
export const NEW_PATHWAY_BASELINE = "new-pathway";

/**
 * workflow-data pathway id from the pathway name. Deterministic, so every
 * snapshot and every later edit of the same pathway shares one id (rejected-rule
 * history is scoped by it), and a revision can never change it.
 */
export function pathwayIdFor(pathway: string): string {
  const slug = pathway
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!slug) throw new RegistrationRefused("INVALID_PATHWAY", "Pathway name has no letters or digits");
  return slug;
}

class RegistrationRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function buildDraftBundle(req: Extract<RegisterRequest, { kind: "draft" }>, config: RegistrarConfig) {
  const parsed = parseLogicModel(req.logicModel);
  if (!parsed.success) throw new RegistrationRefused("INVALID_LOGIC_MODEL", "Drafting output is not a valid LogicModel");
  // authoring-agents Req 4.1: the draft must be for the requested pathway.
  if (parsed.data.pathway !== req.pathway) {
    throw new RegistrationRefused("PATHWAY_MISMATCH", "Drafted LogicModel pathway differs from the request pathway");
  }
  // The model's snapshotId/snapshotHash are never trusted: code assigns the id
  // from the content, and workflow-data computes the hash.
  const { snapshotId: _modelId, snapshotHash: _modelHash, ...content } = parsed.data;
  const snapshotId = `d-${sha256(canonicalJson(content)).slice(0, 24)}`;
  const bundle: SnapshotBundle = {
    schemaVersion: config.schemaVersion,
    baselineRevision: NEW_PATHWAY_BASELINE,
    spec: JSON.parse(JSON.stringify({ ...content, snapshotId })),
    evidenceVersions: [
      {
        sourceId: req.context.source.sourceId,
        version: req.context.source.version,
        sha256: req.context.source.sourceHash,
        sourceS3Ref: req.context.source.sourceS3Ref,
      },
    ],
    // Legacy field name: the exact prompt-context receipt the model was given.
    retrievalEvidenceRefs: [req.context.evidenceRef],
    goldenCaseVersion: config.goldenCaseVersion,
    compilerVersion: config.compilerVersion,
    toolchainImageDigest: config.toolchainImageDigest,
  };
  return { snapshotId, bundle };
}

function buildPlanBundle(req: Extract<RegisterRequest, { kind: "change_plan" }>) {
  const plan = req.plan;
  if (plan.changeId !== req.changeId) throw new RegistrationRefused("CHANGE_MISMATCH", "ChangePlan is for a different change");
  const parsed = snapshotBundleSchema.safeParse(plan.hashInputs);
  if (!parsed.success) throw new RegistrationRefused("INVALID_BUNDLE", "ChangePlan hashInputs is not a valid Snapshot_Bundle");
  // The planner computed the hash; recompute it rather than trust it.
  if (snapshotHash(parsed.data) !== plan.snapshotHash) {
    throw new RegistrationRefused("HASH_MISMATCH", "ChangePlan snapshotHash does not match its hashInputs");
  }
  if (parsed.data.spec.snapshotId !== plan.snapshotId) {
    throw new RegistrationRefused("SNAPSHOT_ID_MISMATCH", "ChangePlan snapshotId differs from its proposed LogicModel");
  }
  return { snapshotId: plan.snapshotId, bundle: parsed.data };
}

export async function registerSnapshot(body: unknown, deps: RegistrarDeps): Promise<RegisterResult> {
  const input = RegisterRequestSchema.safeParse(body);
  if (!input.success) {
    return {
      ok: false,
      failure: {
        code: "INVALID_REQUEST",
        message: `Invalid registration request: ${input.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`,
      },
    };
  }
  const req = input.data;
  // The Author of every snapshot in this change is the requesting program officer.
  const author: HumanContext = { tenantId: req.tenant, subject: req.submittedBy.userId, groups: ["program_officer"] };

  try {
    const pathwayId = pathwayIdFor(req.pathway);
    const { snapshotId, bundle } = req.kind === "draft" ? buildDraftBundle(req, deps.config) : buildPlanBundle(req);
    const hash = snapshotHash(bundle);

    const existing = await deps.repo.getChange(author, req.changeId).catch((err) => {
      if (err instanceof Error && err.name === "WorkflowDataError" && (err as WorkflowDataError).code === "NOT_FOUND") return undefined;
      throw err;
    });
    if (existing?.snapshotHash === hash) {
      // Same content as the current snapshot. That is a retry only while the
      // change is still a fresh draft; after a rejection it means the re-draft
      // reproduced the rejected snapshot, which must not go back to review.
      if (existing.state !== "draft") {
        return {
          ok: false,
          failure: {
            code: "UNCHANGED_SNAPSHOT",
            message: `The new draft is identical to the current snapshot (change state ${existing.state}); nothing was registered`,
          },
        };
      }
      // Retry of a registration that already committed.
      return {
        ok: true,
        output: { snapshotId: existing.snapshotId, snapshotHash: hash, pathwayId: existing.pathwayId, artifact: existing.artifact, registration: "already_registered" },
      };
    }

    const artifact = await deps.artifacts.putArtifact(
      `snapshots/${req.changeId}/${snapshotId}.json`,
      Buffer.from(canonicalJson(bundle), "utf8"),
      "application/json",
    );
    const draftInput = { changeId: req.changeId, pathwayId, snapshotId, executionArn: req.executionArn, bundle, artifact };
    const row = existing
      ? await deps.repo.registerRevision(author, { ...draftInput, expectedHash: existing.snapshotHash })
      : await deps.repo.createDraft(author, draftInput);
    return {
      ok: true,
      output: { snapshotId, snapshotHash: row.snapshotHash, pathwayId, artifact, registration: existing ? "revised" : "created" },
    };
  } catch (err) {
    if (err instanceof RegistrationRefused) return { ok: false, failure: { code: err.code, message: err.message } };
    if (err instanceof Error && err.name === "WorkflowDataError") {
      const code = (err as WorkflowDataError).code;
      // The rejection callback for this change is still being finalized: retry shortly.
      if (code === "BUSY") throw new RegistrarBusy(err.message);
      // e.g. UNCHANGED_SNAPSHOT (a re-draft identical to the rejected one), INVALID_REVISION, CONFLICT.
      return { ok: false, failure: { code, message: err.message } };
    }
    throw err;
  }
}
