import { randomUUID } from "node:crypto";
import { ArtifactStore } from "../src/artifacts.js";
import { RetrievalService } from "../src/retrieval.js";
import type { ArtifactRef, AuthorizedContext } from "../src/contracts.js";
export async function registerSnapshot(
  artifacts: ArtifactStore,
  register: (input: {
    changeId: string;
    snapshotId: string;
    artifact: ArtifactRef;
  }) => Promise<void>,
) {
  const changeId = randomUUID(),
    snapshotId = randomUUID();
  const artifact = await artifacts.putArtifact(
    `snapshots/${changeId}/${snapshotId}/logic.json`,
    Buffer.from(JSON.stringify({ schemaVersion: 1, synthetic: true })),
    "application/json",
  );
  await artifacts.getArtifactVersion(artifact); // Yash must verify this before conditional registration.
  await register({ changeId, snapshotId, artifact }); // Failure leaves an unregistered object, never an approved state.
  return artifact;
}
export async function gatewayTool(
  service: RetrievalService,
  trustedContext: AuthorizedContext,
  input: {
    query: string;
    sourceType: "guideline" | "cht-docs" | "reference-config";
  },
) {
  // Identity/policy checked by Gateway + backend; trustedContext is loaded from the pinned snapshot.
  return service.retrieveEvidence(
    trustedContext,
    input.query,
    input.sourceType,
  );
}
export async function rollbackStaging(
  artifacts: ArtifactStore,
  priorApprovedManifest: ArtifactRef,
) {
  // Build/deploy owner checks approval and expected target revision; stage bytes BEFORE the no-network container.
  const refs = await artifacts.verifyManifest(priorApprovedManifest);
  const staged = [];
  for (const ref of refs)
    staged.push({ ref, bytes: await artifacts.getArtifactVersion(ref) });
  return staged;
}
