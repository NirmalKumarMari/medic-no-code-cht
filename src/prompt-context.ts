import { ArtifactStore, sha256 } from "./artifacts.js";
import {
  artifactRefSchema,
  sourceSchema,
  type PublishedSource,
  type PromptContextRequest,
  type PromptContextAudit,
  type PromptMode,
} from "./contracts.js";
import { exportText } from "./sources.js";

/** Internal pre-inference step. No model-invoked tools, search, embeddings or ranking. */
export class PromptContextBuilder {
  constructor(
    private artifacts: ArtifactStore,
    private audit: PromptContextAudit,
    private screening: { screen(text: string): Promise<void> },
  ) {}
  async prepare(
    context: PromptContextRequest,
    mode: PromptMode,
    input: PublishedSource,
  ) {
    for (const id of [
      context.tenantId,
      context.changeId,
      context.snapshotId,
      context.requestId,
    ])
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))
        throw Error("Invalid context identity");
    if (!["drafting", "change_planner"].includes(mode))
      throw Error("Invalid prompt mode");
    const source = sourceSchema.parse(input.source);
    if (
      source.sourceType !== (mode === "drafting" ? "guideline" : "cht-primer")
    )
      throw Error("Prompt source type mismatch");
    const document = artifactRefSchema.parse(input.document),
      provenance = artifactRefSchema.parse(input.provenance);
    const receipt = JSON.parse(
      Buffer.from(await this.artifacts.getArtifactVersion(provenance)).toString(
        "utf8",
      ),
    );
    if (
      receipt.schemaVersion !== 1 ||
      JSON.stringify(sourceSchema.parse(receipt.source)) !==
        JSON.stringify(source) ||
      JSON.stringify(artifactRefSchema.parse(receipt.document)) !==
        JSON.stringify(document)
    )
      throw Error("Source provenance mismatch");
    const rawRef = artifactRefSchema.parse(receipt.rawRef);
    const raw = await this.artifacts.getArtifactVersion(rawRef);
    if (sha256(raw) !== source.sourceHash)
      throw Error("Original source hash mismatch");
    const text = Buffer.from(
      await this.artifacts.getArtifactVersion(document),
    ).toString("utf8");
    if (text !== exportText(raw, source, receipt.exportFormat))
      throw Error("Source export mismatch");
    // Screen the actual full context before use, not just its first upload.
    await this.screening.screen(JSON.stringify(source) + "\n" + text);
    const sourcePin = {
      sourceId: source.sourceId,
      version: source.version,
      sourceHash: source.sourceHash,
      sourceS3Ref: document,
      provenanceRef: provenance,
    };
    const contextHash = sha256(
      JSON.stringify({ mode, source: sourcePin, text }),
    );
    const evidenceRef = await this.artifacts.putArtifact(
      `reports/${context.changeId}/context/${context.snapshotId}/${context.requestId}.json`,
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          context,
          mode,
          contextHash,
          source: sourcePin,
          text,
        }),
      ),
      "application/json",
    );
    await this.audit.record({ context, contextHash, evidenceRef });
    return { text, contextHash, source: sourcePin, evidenceRef };
  }
}
