import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type RetrievalFilter,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { ArtifactStore, sha256 } from "./artifacts.js";
import {
  type AuthorizedContext,
  type Evidence,
  type SourceType,
  sourceTypeSchema,
  sha256Schema,
} from "./contracts.js";
export interface RetrievalAudit {
  record(event: {
    context: AuthorizedContext;
    queryHash: string;
    evidenceRef: import("./contracts.js").ArtifactRef;
  }): Promise<void>;
}
export class RetrievalService {
  constructor(
    private runtime: BedrockAgentRuntimeClient,
    private kbId: string,
    private sources: ArtifactStore,
    private artifacts: ArtifactStore,
    private audit: RetrievalAudit,
    private screening: { screen(text: string): Promise<void> },
  ) {}
  async retrieveEvidence(
    context: AuthorizedContext,
    query: string,
    sourceType: SourceType,
  ): Promise<Evidence[]> {
    sourceTypeSchema.parse(sourceType);
    if (
      !query.trim() ||
      query.length > 1000 ||
      !context.changeId ||
      !context.snapshotId ||
      !context.requestId
    )
      throw Error("Invalid retrieval request");
    const grants = context.grants.filter((g) => g.sourceType === sourceType);
    if (!grants.length || grants.length > 20)
      throw Error("Unauthorized source");
    for (const grant of grants) sha256Schema.parse(grant.sourceHash);
    await this.screening.screen(query);
    const alternatives: RetrievalFilter[] = grants.map((g) => ({
      andAll: [
        { equals: { key: "sourceType", value: g.sourceType } },
        { equals: { key: "sourceId", value: g.sourceId } },
        { equals: { key: "version", value: g.version } },
        { equals: { key: "sourceHash", value: g.sourceHash } },
        ...(g.workflow
          ? [{ equals: { key: "workflow", value: g.workflow } }]
          : []),
      ],
    }));
    const response = await this.runtime.send(
      new RetrieveCommand({
        knowledgeBaseId: this.kbId,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 8,
            filter:
              alternatives.length === 1
                ? alternatives[0]
                : { orAll: alternatives },
          },
        },
      }),
    );
    const evidence: Evidence[] = [];
    for (const hit of response.retrievalResults ?? []) {
      const m = hit.metadata ?? {};
      if (
        !grants.some(
          (g) =>
            m.sourceType === g.sourceType &&
            m.sourceId === g.sourceId &&
            m.version === g.version &&
            m.sourceHash === g.sourceHash &&
            (!g.workflow || m.workflow === g.workflow),
        )
      )
        throw Error("Unresolved provenance: filter mismatch");
      for (const field of [
        "sourceId",
        "version",
        "section",
        "sourceHash",
        "documentHash",
        "versionId",
      ])
        if (typeof m[field] !== "string" || !m[field])
          throw Error(`Unresolved provenance: ${field}`);
      const key = `${sourceType}/${m.sourceId}/${m.version}/${m.documentHash}.txt`;
      if (
        hit.location?.s3Location?.uri !==
          `s3://${this.sources.bucket}/${key}` ||
        !hit.content?.text
      )
        throw Error("Unresolved citation location/text");
      if (!/^[a-f0-9]{64}$/.test(String(m.sourceHash)))
        throw Error("Invalid source hash");
      const sourceS3Ref = {
        bucket: this.sources.bucket,
        key,
        versionId: String(m.versionId),
        sha256: String(m.documentHash),
        contentType: "text/plain",
      };
      const exactText = Buffer.from(
        await this.sources.getArtifactVersion(sourceS3Ref),
      ).toString("utf8");
      if (hit.content.text.trim() !== exactText.trim())
        throw Error("Citation does not match pinned section");
      if (
        m.page !== undefined &&
        (!Number.isInteger(m.page) || Number(m.page) < 1)
      )
        throw Error("Invalid page provenance");
      if (m.tableId !== undefined && typeof m.tableId !== "string")
        throw Error("Invalid table provenance");
      evidence.push({
        text: hit.content.text,
        sourceId: String(m.sourceId),
        version: String(m.version),
        section: String(m.section),
        sourceHash: String(m.sourceHash),
        sourceS3Ref,
        score: hit.score,
        ...(m.page !== undefined ? { page: Number(m.page) } : {}),
        ...(m.tableId !== undefined ? { tableId: String(m.tableId) } : {}),
      });
    }
    const queryHash = sha256(query);
    const evidenceRef = await this.artifacts.putArtifact(
      `reports/${context.changeId}/retrieval/${context.snapshotId}/${context.requestId}.json`,
      Buffer.from(JSON.stringify({ context, query, evidence })),
      "application/json",
    );
    // Await durable audit indexing. A failed audit prevents returning evidence to agents.
    await this.audit.record({ context, queryHash, evidenceRef });
    console.info(
      JSON.stringify({
        event: "retrieval.complete",
        changeId: context.changeId,
        snapshotId: context.snapshotId,
        requestId: context.requestId,
        queryHash,
        evidenceRef,
        resultCount: evidence.length,
      }),
    );
    return evidence;
  }
}
