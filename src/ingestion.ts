import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
} from "@aws-sdk/client-bedrock-agent";
import { ArtifactStore, sha256 } from "./artifacts.js";
import {
  sourceSchema,
  type Source,
  type SourceType,
  type ArtifactRef,
} from "./contracts.js";
export interface Publication {
  document: ArtifactRef;
  metadata: ArtifactRef;
  provenance: ArtifactRef;
  sourceType: SourceType;
}
export class GuardrailScreen {
  constructor(
    private runtime: BedrockRuntimeClient,
    private id: string,
    private version: string,
  ) {
    if (!id || !version || version === "DRAFT")
      throw Error("Published guardrail version required");
  }
  async screen(text: string) {
    const result = await this.runtime.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: this.id,
        guardrailVersion: this.version,
        source: "INPUT",
        content: [{ text: { text } }],
      }),
    );
    if (result.action !== "NONE")
      throw Error("Ingestion screening failed closed");
  }
}
export class Ingestor {
  constructor(
    private sources: ArtifactStore,
    private artifacts: ArtifactStore,
    private screening: { screen(text: string): Promise<void> },
    private allowedOrigins: readonly string[],
  ) {}
  async publish(
    input: Source,
    raw: Uint8Array,
    format: "md" | "txt" | "js",
  ): Promise<Publication> {
    const source = sourceSchema.parse(input);
    if (!this.allowedOrigins.includes(new URL(source.url).origin))
      throw Error("Source origin not allowed");
    if (
      source.sourceType !== "guideline" &&
      !/^[a-f0-9]{40}$/.test(source.version)
    )
      throw Error("Technical sources require full pinned commit");
    if (sha256(raw) !== source.sourceHash) throw Error("Source hash mismatch");
    if (!["md", "txt", "js"].includes(format))
      throw Error("Export unsupported format to reviewed text first");
    if (
      /(^|[\/_. -])(golden|patients?|prompts?|decisions?|credentials?|secrets?|fixtures?|mcp)([\/_. -]|$)/i.test(
        source.path,
      )
    )
      throw Error("Excluded source category");
    const original = new TextDecoder("utf-8", { fatal: true })
      .decode(raw)
      .replace(/\r\n?/g, "\n");
    // Sections are explicitly prepared by a reviewer, keeping tables whole. No arbitrary slicing.
    if (
      !original.trim() ||
      Buffer.byteLength(original) > 6000 ||
      /\x00/.test(original)
    )
      throw Error("Prepare a nonempty section of at most 6000 UTF-8 bytes");
    if (
      /AKIA[A-Z0-9]{16}|-----BEGIN .*PRIVATE KEY-----|\b(?:password|api[_-]?key|taskToken)\s*[:=]/i.test(
        original,
      )
    )
      throw Error("Credential-like content rejected");
    const text =
      format === "js"
        ? `Source: ${source.path}\nCommit: ${source.version}\n\n\x60\x60\x60javascript\n${original}\n\x60\x60\x60\n`
        : original;
    await this.screening.screen(JSON.stringify(source) + "\n" + text);
    const docHash = sha256(text);
    const key = `${source.sourceType}/${source.sourceId}/${source.version}/${docHash}.txt`;
    // Write immutable raw provenance outside the KB, then the prepared document. No ingestion job starts until sidecar succeeds.
    const rawRef = await this.artifacts.putArtifact(
      `docs/${source.sourceId}/${source.version}/${source.sourceHash}.raw`,
      raw,
      "application/octet-stream",
    );
    const provenance = await this.artifacts.putArtifact(
      `docs/${source.sourceId}/${source.version}/${docHash}.json`,
      Buffer.from(
        JSON.stringify({
          source,
          rawRef,
          exportFormat: format,
          documentHash: docHash,
        }),
      ),
      "application/json",
    );
    const document = await this.sources.putArtifact(
      key,
      Buffer.from(text),
      "text/plain",
    );
    const metadataAttributes = {
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      version: source.version,
      section: source.section,
      sourceHash: source.sourceHash,
      documentHash: document.sha256,
      versionId: document.versionId,
      ...(source.workflow ? { workflow: source.workflow } : {}),
      ...(source.page ? { page: source.page } : {}),
      ...(source.tableId ? { tableId: source.tableId } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(metadataAttributes)) > 1024)
      throw Error("S3 Vectors metadata exceeds 1KB");
    const metadata = await this.sources.putArtifact(
      key + ".metadata.json",
      Buffer.from(JSON.stringify({ metadataAttributes })),
      "application/json",
    );
    return { document, metadata, provenance, sourceType: source.sourceType };
  }
}
export class IngestionJobs {
  constructor(
    private client: BedrockAgentClient,
    private kbId: string,
    private dataSources: Record<SourceType, string>,
    private sources: ArtifactStore,
    private artifacts: ArtifactStore,
  ) {}
  async start(
    type: SourceType,
    publications: Publication[],
    requestId: string,
  ) {
    if (
      !/^[A-Za-z0-9_-]{33,128}$/.test(requestId) ||
      !publications.length ||
      publications.some((p) => p.sourceType !== type)
    )
      throw Error("Invalid ingestion batch/token");
    for (const p of publications) {
      await this.sources.getArtifactVersion(p.document);
      await this.sources.getArtifactVersion(p.metadata);
      await this.artifacts.getArtifactVersion(p.provenance);
    }
    const batch = await this.artifacts.putArtifact(
      `reports/ingestion/${requestId}/batch.json`,
      Buffer.from(JSON.stringify(publications)),
      "application/json",
    );
    const result = await this.client.send(
      new StartIngestionJobCommand({
        knowledgeBaseId: this.kbId,
        dataSourceId: this.dataSources[type],
        clientToken: requestId,
        description: `batch ${batch.key}`,
      }),
    );
    await this.artifacts.putArtifact(
      `reports/ingestion/${requestId}/started.json`,
      Buffer.from(
        JSON.stringify({
          batch,
          knowledgeBaseId: this.kbId,
          dataSourceId: this.dataSources[type],
          ingestionJobId: result.ingestionJob?.ingestionJobId,
        }),
      ),
      "application/json",
    );
    return result.ingestionJob;
  }
  async status(type: SourceType, jobId: string) {
    const job = (
      await this.client.send(
        new GetIngestionJobCommand({
          knowledgeBaseId: this.kbId,
          dataSourceId: this.dataSources[type],
          ingestionJobId: jobId,
        }),
      )
    ).ingestionJob;
    if (!job) throw Error("Missing ingestion status");
    const bytes = Buffer.from(JSON.stringify(job));
    await this.artifacts.putArtifact(
      `reports/ingestion/${jobId}/status/${sha256(bytes)}.json`,
      bytes,
      "application/json",
    );
    return job;
  }
}
