import { ArtifactStore } from "../src/artifacts.js";
import { PromptContextBuilder } from "../src/prompt-context.js";
import type {
  ArtifactRef,
  PublishedSource,
  PromptContextRequest,
  PromptMode,
} from "../src/contracts.js";
import {
  snapshotBundleSchema,
  type SnapshotBundle,
} from "../packages/workflow-data/src/model.js";

/** Backend reserves the real workflow identity and validates the author separately. */
export async function registerSnapshot(
  artifacts: ArtifactStore,
  input: { changeId: string; snapshotId: string; bundle: SnapshotBundle },
  register: (input: {
    changeId: string;
    snapshotId: string;
    bundle: SnapshotBundle;
    artifact: ArtifactRef;
  }) => Promise<void>,
) {
  const bundle = snapshotBundleSchema.parse(input.bundle);
  const artifact = await artifacts.putArtifact(
    `snapshots/${input.changeId}/${input.snapshotId}/logic.json`,
    Buffer.from(JSON.stringify(bundle)),
    "application/json",
  );
  await artifacts.getArtifactVersion(artifact);
  await register({ ...input, bundle, artifact }); // The closure calls createDraft/registerRevision with verified human/execution context.
  return artifact; // A registration error leaves an orphan, never an approved state.
}
/** Server-side pre-inference step, never an agent-facing Gateway search tool. */
export async function buildPromptContext(
  builder: PromptContextBuilder,
  trustedContext: PromptContextRequest,
  mode: PromptMode,
  source: PublishedSource,
) {
  return builder.prepare(trustedContext, mode, source);
}
export async function rollbackStaging(
  artifacts: ArtifactStore,
  priorApprovedManifest: ArtifactRef,
) {
  const refs = await artifacts.verifyManifest(priorApprovedManifest);
  const staged = [];
  for (const ref of refs)
    staged.push({ ref, bytes: await artifacts.getArtifactVersion(ref) });
  return staged; // Deployer separately checks exact approval/target revision and verifies actual CHT state.
}
