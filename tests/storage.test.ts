import { test } from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { ArtifactStore, sha256 } from "../src/artifacts.js";
import { Ingestor, GuardrailScreen, IngestionJobs } from "../src/ingestion.js";
import { RetrievalService } from "../src/retrieval.js";
import type { AuthorizedContext, Source } from "../src/contracts.js";
function fixture() {
  const objects = new Map<string, any[]>();
  const calls: any[] = [];
  const client = {
    send: async (command: any) => {
      calls.push(command);
      const i = command.input;
      const id = i.Bucket + "/" + i.Key;
      if (command.constructor.name === "PutObjectCommand") {
        if (objects.has(id))
          throw Object.assign(Error("exists"), { name: "PreconditionFailed" });
        const entry = {
          bytes: Uint8Array.from(i.Body),
          VersionId: "version-1",
          ContentType: i.ContentType,
          ServerSideEncryption: i.ServerSideEncryption,
          SSEKMSKeyId: i.SSEKMSKeyId,
        };
        objects.set(id, [entry]);
        return { VersionId: entry.VersionId };
      }
      const entry = objects
        .get(id)
        ?.find((v) => !i.VersionId || v.VersionId === i.VersionId);
      if (!entry) throw Error("Not found");
      return {
        ...entry,
        Body: { transformToByteArray: async () => entry.bytes },
      };
    },
  } as unknown as S3Client;
  const artifacts = new ArtifactStore(client, "artifacts", "key");
  const sources = new ArtifactStore(client, "sources", "key", [
    "guideline/",
    "cht-docs/",
    "reference-config/",
  ]);
  return { objects, calls, artifacts, sources, client };
}
const body = Buffer.from("Public section with a complete table.");
const source: Source = {
  sourceType: "guideline",
  sourceId: "example",
  version: "edition-1",
  section: "Section A",
  path: "guideline.md",
  url: "https://www.cdc.gov/example",
  sourceHash: sha256(body),
  public: true,
  reviewedBy: "reviewer",
  reviewedAt: "2026-11-03T12:00:00Z",
  purpose: "reference-document",
};
const allowed = { screen: async (_: string) => {} };
const context: AuthorizedContext = {
  changeId: "change-1",
  snapshotId: "snapshot-1",
  requestId: "request-1",
  grants: [
    {
      sourceType: "guideline",
      sourceId: "example",
      version: "edition-1",
      sourceHash: sha256(body),
    },
  ],
};
async function retrievalFixture() {
  const f = fixture();
  const ingest = new Ingestor(f.sources, f.artifacts, allowed, [
    "https://www.cdc.gov",
  ]);
  const pub = await ingest.publish(source, body, "md");
  const meta = JSON.parse(
    Buffer.from(await f.sources.getArtifactVersion(pub.metadata)).toString(),
  ).metadataAttributes;
  const hit = {
    content: { text: body.toString() },
    location: { s3Location: { uri: `s3://sources/${pub.document.key}` } },
    metadata: meta,
    score: 0.8,
  };
  const queries: any[] = [];
  let audits = 0;
  const runtime = {
    send: async (c: any) => {
      queries.push(c.input);
      return { retrievalResults: [hit] };
    },
  } as unknown as BedrockAgentRuntimeClient;
  const audit = {
    record: async () => {
      audits++;
    },
  };
  const service = new RetrievalService(
    runtime,
    "kb",
    f.sources,
    f.artifacts,
    audit,
    allowed,
  );
  return { ...f, hit, queries, audit, service, getAudits: () => audits };
}
test("conditional KMS upload returns exact reference; equal retries are idempotent", async () => {
  const f = fixture();
  const ref = await f.artifacts.putArtifact(
    "snapshots/c/s/logic.json",
    body,
    "text/plain",
  );
  assert.equal(ref.sha256, sha256(body));
  assert.equal(f.calls[0].input.IfNoneMatch, "*");
  assert.equal(f.calls[0].input.ServerSideEncryption, "aws:kms");
  assert.deepEqual(
    await f.artifacts.putArtifact(ref.key, body, "text/plain"),
    ref,
  );
  assert.deepEqual(
    await f.artifacts.getArtifactVersion(ref),
    Uint8Array.from(body),
  );
  await assert.rejects(
    f.artifacts.putArtifact(ref.key, Buffer.from("changed"), "text/plain"),
    /conflict/,
  );
});
test("tampered contents, wrong bucket and unversioned references are rejected", async () => {
  const f = fixture();
  const ref = await f.artifacts.putArtifact("docs/a/v/x", body, "text/plain");
  await assert.rejects(
    f.artifacts.getArtifactVersion({ ...ref, bucket: "other" }),
    /bucket/,
  );
  await assert.rejects(
    f.artifacts.getArtifactVersion({ ...ref, versionId: "null" }),
  );
  f.objects.get("artifacts/" + ref.key)![0].bytes = Buffer.from("corrupted");
  await assert.rejects(f.artifacts.getArtifactVersion(ref), /checksum/);
});
test("unsafe keys and ingestion prefixes cannot be written through artifact API", async () => {
  const f = fixture();
  for (const key of ["kb-source/x", "reports/../x", "reports//x"])
    await assert.rejects(f.artifacts.putArtifact(key, body, "text/plain"));
  assert.equal(f.calls.length, 0);
});
test("prior release manifest resolves exact bytes and detects corruption", async () => {
  const f = fixture();
  const release = await f.artifacts.putArtifact(
    "builds/c/old/app.json",
    body,
    "text/plain",
  );
  const manifest = await f.artifacts.putArtifact(
    "builds/c/old/manifest.json",
    Buffer.from(JSON.stringify([release])),
    "application/json",
  );
  assert.deepEqual(await f.artifacts.verifyManifest(manifest), [release]);
  f.objects.get("artifacts/" + release.key)![0].bytes = Buffer.from("wrong");
  await assert.rejects(f.artifacts.verifyManifest(manifest), /checksum/);
});
test("screening failure occurs before any S3 write", async () => {
  const f = fixture();
  const ingest = new Ingestor(
    f.sources,
    f.artifacts,
    {
      screen: async () => {
        throw Error("blocked");
      },
    },
    ["https://www.cdc.gov"],
  );
  await assert.rejects(ingest.publish(source, body, "md"), /blocked/);
  assert.equal(f.calls.length, 0);
});
test("rejects forbidden categories, source hash changes and unpinned technical docs", async () => {
  const f = fixture();
  const i = new Ingestor(f.sources, f.artifacts, allowed, [
    "https://www.cdc.gov",
  ]);
  for (const path of [
    "golden-cases.md",
    "patient.json",
    "prompts.txt",
    "credentials.txt",
    "mcp.txt",
  ])
    await assert.rejects(i.publish({ ...source, path }, body, "md"));
  await assert.rejects(
    i.publish({ ...source, sourceHash: "0".repeat(64) }, body, "md"),
    /hash/,
  );
  await assert.rejects(
    i.publish(
      { ...source, sourceType: "cht-docs", version: "main" },
      body,
      "md",
    ),
    /commit/,
  );
  assert.equal(f.calls.length, 0);
});
test("sidecar pins document version and missing page/table stay absent", async () => {
  const f = await retrievalFixture();
  const evidence = await f.service.retrieveEvidence(
    context,
    "public section",
    "guideline",
  );
  assert.equal(evidence[0].sourceS3Ref.versionId, "version-1");
  assert.equal(evidence[0].page, undefined);
  assert.equal(evidence[0].tableId, undefined);
  assert.equal(f.getAudits(), 1);
  assert.deepEqual(
    f.queries[0].retrievalConfiguration.vectorSearchConfiguration.filter
      .andAll[2],
    { equals: { key: "version", value: "edition-1" } },
  );
});
test("unauthorized source type never reaches Bedrock", async () => {
  const f = await retrievalFixture();
  await assert.rejects(
    f.service.retrieveEvidence(context, "tasks", "reference-config"),
    /Unauthorized/,
  );
  assert.equal(f.queries.length, 0);
});
test("filter mismatch fails closed even if Bedrock returns a hit", async () => {
  const f = await retrievalFixture();
  f.hit.metadata.version = "edition-2";
  await assert.rejects(
    f.service.retrieveEvidence(context, "public", "guideline"),
    /filter mismatch/,
  );
  assert.equal(f.getAudits(), 0);
});
test("missing provenance, altered citation text and wrong location fail closed", async () => {
  for (const mutate of [
    (h: any) => delete h.metadata.sourceHash,
    (h: any) => (h.content.text = "invented"),
    (h: any) => (h.location.s3Location.uri = "s3://other/doc"),
  ]) {
    const f = await retrievalFixture();
    mutate(f.hit);
    await assert.rejects(
      f.service.retrieveEvidence(context, "public", "guideline"),
    );
    assert.equal(f.getAudits(), 0);
  }
});
test("audit failure prevents delivery of retrieved evidence", async () => {
  const f = await retrievalFixture();
  f.audit.record = async () => {
    throw Error("audit unavailable");
  };
  await assert.rejects(
    f.service.retrieveEvidence(context, "public", "guideline"),
    /audit unavailable/,
  );
});

test("Guardrail requires published version and rejects intervention or missing action", async () => {
  const runtime = await import("@aws-sdk/client-bedrock-runtime");
  for (const action of ["GUARDRAIL_INTERVENED", undefined]) {
    const client = {
      send: async () => ({ action }),
    } as unknown as InstanceType<typeof runtime.BedrockRuntimeClient>;
    assert.throws(
      () => new GuardrailScreen(client, "guardrail", "DRAFT"),
      /Published/,
    );
    await assert.rejects(
      new GuardrailScreen(client, "guardrail", "1").screen("text"),
      /failed closed/,
    );
  }
});
test("ingestion job validates complete receipts before starting and persists status", async () => {
  const f = fixture();
  const publication = await new Ingestor(f.sources, f.artifacts, allowed, [
    "https://www.cdc.gov",
  ]).publish(source, body, "md");
  const { BedrockAgentClient } = await import("@aws-sdk/client-bedrock-agent");
  const calls: any[] = [];
  const client = {
    send: async (c: any) => {
      calls.push(c.input);
      return {
        ingestionJob: {
          ingestionJobId: "job1",
          status:
            c.constructor.name === "StartIngestionJobCommand"
              ? "STARTING"
              : "COMPLETE",
          statistics: { numberOfDocumentsFailed: 0 },
        },
      };
    },
  } as unknown as InstanceType<typeof BedrockAgentClient>;
  const jobs = new IngestionJobs(
    client,
    "kb",
    { guideline: "ds1", "cht-docs": "ds2", "reference-config": "ds3" },
    f.sources,
    f.artifacts,
  );
  const broken = {
    ...publication,
    metadata: { ...publication.metadata, versionId: "missing" },
  };
  await assert.rejects(jobs.start("guideline", [broken], "a".repeat(40)));
  assert.equal(calls.length, 0);
  await jobs.start("guideline", [publication], "b".repeat(40));
  await jobs.start("guideline", [publication], "b".repeat(40)); // same token + receipt safely recover
  const job = await jobs.status("guideline", "job1");
  assert.equal(job.status, "COMPLETE");
  assert.equal(calls[0].clientToken, "b".repeat(40));
  assert.ok(
    [...f.objects.keys()].some((k) =>
      k.startsWith("artifacts/reports/ingestion/job1/status/"),
    ),
  );
});
test("same edition with a different source hash is rejected", async () => {
  const f = await retrievalFixture();
  f.hit.metadata.sourceHash = "0".repeat(64);
  await assert.rejects(
    f.service.retrieveEvidence(context, "public", "guideline"),
    /filter mismatch/,
  );
});
test("sample catalog hashes match the exact downloaded section bytes", async () => {
  const { readFile } = await import("node:fs/promises");
  const catalog = JSON.parse(
    await readFile("examples/sources/catalog.json", "utf8"),
  );
  assert.equal(catalog.length, 3);
  for (const entry of catalog)
    assert.equal(
      sha256(await readFile("examples/sources/" + entry.file)),
      entry.sourceHash,
    );
});
