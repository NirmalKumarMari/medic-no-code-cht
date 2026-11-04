import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { ArtifactStore, sha256 } from "../src/artifacts.js";
import { SourcePublisher } from "../src/sources.js";
import { GuardrailScreen } from "../src/screening.js";
import { PromptContextBuilder } from "../src/prompt-context.js";
import type { Source, PromptContextRequest } from "../src/contracts.js";
function fixture() {
  const objects = new Map<string, any[]>(),
    calls: any[] = [];
  const client = {
    send: async (command: any) => {
      calls.push(command);
      const i = command.input,
        id = i.Bucket + "/" + i.Key;
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
        ?.find((v) => !i.VersionId || i.VersionId === v.VersionId);
      if (!entry) throw Error("Not found");
      return {
        ...entry,
        Body: { transformToByteArray: async () => entry.bytes },
      };
    },
  } as unknown as S3Client;
  return {
    objects,
    calls,
    client,
    artifacts: new ArtifactStore(client, "artifacts", "key"),
  };
}
const body = Buffer.from(
  "Public guideline: a complete table and the surrounding text.",
);
const source: Source = {
  sourceType: "guideline",
  sourceId: "example",
  version: "edition-1",
  section: "Full guideline",
  path: "guideline.md",
  url: "https://www.cdc.gov/example",
  sourceHash: sha256(body),
  public: true,
  reviewedBy: "reviewer",
  reviewedAt: "2026-11-04T18:00:00Z",
  purpose: "reference-document",
};
const allowed = { screen: async (_: string) => {} };
const context: PromptContextRequest = {
  tenantId: "demo",
  changeId: "change-1",
  snapshotId: "snapshot-1",
  requestId: "request-1",
};
async function promptFixture() {
  const f = fixture();
  const publisher = new SourcePublisher(f.artifacts, allowed, [
    "https://www.cdc.gov",
  ]);
  const published = await publisher.publish(source, body, "md");
  let audits = 0;
  const audit = {
    record: async (_: any) => {
      audits++;
    },
  };
  return {
    ...f,
    publisher,
    published,
    audit,
    builder: new PromptContextBuilder(f.artifacts, audit, allowed),
    getAudits: () => audits,
  };
}
test("immutable KMS upload returns exact version/hash; equal retry succeeds and different content fails", async () => {
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
  await assert.rejects(
    f.artifacts.putArtifact(ref.key, Buffer.from("changed"), "text/plain"),
    /conflict/,
  );
});
test("version, bucket, content-type, encryption and byte corruption are rejected", async () => {
  const f = fixture();
  const ref = await f.artifacts.putArtifact(
    "docs/source/a.txt",
    body,
    "text/plain",
  );
  for (const patch of [
    { bucket: "other" },
    { versionId: "missing" },
    { contentType: "text/html" },
    { sha256: "0".repeat(64) },
  ])
    await assert.rejects(f.artifacts.getArtifactVersion({ ...ref, ...patch }));
  await assert.rejects(
    f.artifacts.getArtifactVersion({ ...ref, versionId: "null" }),
  );
  f.objects.get("artifacts/" + ref.key)![0].SSEKMSKeyId = "other-key";
  await assert.rejects(f.artifacts.getArtifactVersion(ref));
});
test("unsafe keys and unsupported prefixes cannot be written", async () => {
  const f = fixture();
  for (const key of ["outside/x", "reports/../x", "reports//x"])
    await assert.rejects(f.artifacts.putArtifact(key, body, "text/plain"));
});
test("rollback manifest resolves pinned bytes and detects child corruption", async () => {
  const f = fixture();
  const child = await f.artifacts.putArtifact(
    "builds/c/b/file.json",
    body,
    "text/plain",
  );
  const manifest = await f.artifacts.putArtifact(
    "builds/c/b/manifest.json",
    Buffer.from(JSON.stringify([child])),
    "application/json",
  );
  assert.deepEqual(await f.artifacts.verifyManifest(manifest), [child]);
  f.objects.get("artifacts/" + child.key)![0].bytes = Buffer.from("corrupted");
  await assert.rejects(f.artifacts.verifyManifest(manifest));
});
test("source screening failure happens before any S3 write", async () => {
  const f = fixture();
  const p = new SourcePublisher(
    f.artifacts,
    {
      screen: async () => {
        throw Error("screen blocked");
      },
    },
    ["https://www.cdc.gov"],
  );
  await assert.rejects(p.publish(source, body, "md"), /screen blocked/);
  assert.equal(f.calls.length, 0);
});
test("source publication rejects excluded data, unpinned technical sources and altered hashes", async () => {
  const f = fixture();
  const p = new SourcePublisher(f.artifacts, allowed, ["https://www.cdc.gov"]);
  for (const path of [
    "golden-cases.md",
    "patient.json",
    "prompts.txt",
    "credentials.txt",
    "mcp.txt",
  ])
    await assert.rejects(p.publish({ ...source, path }, body, "md"));
  await assert.rejects(
    p.publish({ ...source, sourceHash: "0".repeat(64) }, body, "md"),
  );
  await assert.rejects(
    p.publish(
      { ...source, sourceType: "cht-docs", version: "main" },
      body,
      "md",
    ),
  );
  assert.equal(f.calls.length, 0);
});
test("whole guideline larger than old chunk size is retained without splitting or truncation", async () => {
  const f = fixture(),
    full = Buffer.from("Public text and complete tables.\n".repeat(400));
  const pub = await new SourcePublisher(f.artifacts, allowed, [
    "https://www.cdc.gov",
  ]).publish({ ...source, sourceHash: sha256(full) }, full, "txt");
  const result = await new PromptContextBuilder(
    f.artifacts,
    { record: async () => {} },
    allowed,
  ).prepare(context, "drafting", pub);
  assert.equal(result.text, full.toString());
  assert.ok(![...f.objects.keys()].some((k) => k.endsWith(".metadata.json")));
});
test("drafting receives the exact full guideline and durable context receipt before use", async () => {
  const f = await promptFixture();
  const r = await f.builder.prepare(context, "drafting", f.published);
  assert.equal(r.text, body.toString());
  assert.equal(f.getAudits(), 1);
  assert.equal(r.source.sourceS3Ref.versionId, "version-1");
  const receipt = JSON.parse(
    Buffer.from(await f.artifacts.getArtifactVersion(r.evidenceRef)).toString(),
  );
  assert.equal(receipt.text, r.text);
  assert.equal(receipt.contextHash, r.contextHash);
  assert.ok(!("score" in r));
});
test("same inputs recover the context receipt; reused request ID with changed content fails", async () => {
  const f = await promptFixture();
  const first = await f.builder.prepare(context, "drafting", f.published);
  assert.deepEqual(
    await f.builder.prepare(context, "drafting", f.published),
    first,
  );
  const changed = Buffer.from("Updated full public guideline.");
  const pub = await f.publisher.publish(
    { ...source, version: "edition-2", sourceHash: sha256(changed) },
    changed,
    "txt",
  );
  await assert.rejects(f.builder.prepare(context, "drafting", pub), /conflict/);
});
test("planner receives an explicitly reviewed primer and cannot silently use a guideline instead", async () => {
  const f = await promptFixture();
  await assert.rejects(
    f.builder.prepare(context, "change_planner", f.published),
    /type mismatch/,
  );
  const text = Buffer.from(
    "Curated conventions: use the pinned configuration and preserve form identifiers.",
  );
  const pub = await f.publisher.publish(
    {
      ...source,
      sourceType: "cht-primer",
      sourceId: "primer",
      version: "primer-v1",
      path: "cht-conventions.md",
      section: "Full primer",
      sourceHash: sha256(text),
    },
    text,
    "txt",
  );
  assert.equal(
    (await f.builder.prepare(context, "change_planner", pub)).text,
    text.toString(),
  );
  await assert.rejects(
    f.builder.prepare(context, "drafting", pub),
    /type mismatch/,
  );
});
test("forged source identity or version cannot replace published provenance", async () => {
  const f = await promptFixture();
  for (const patch of [
    { version: "wrong" },
    { sourceHash: "0".repeat(64) },
    { section: "invented section" },
  ])
    await assert.rejects(
      f.builder.prepare(context, "drafting", {
        ...f.published,
        source: { ...source, ...patch },
      }),
      /provenance mismatch/,
    );
});
test("wrong document version, tampered raw content and altered exports fail closed", async () => {
  for (const which of ["version", "raw", "document"]) {
    const f = await promptFixture();
    if (which === "version") f.published.document.versionId = "absent";
    else {
      const key =
        which === "raw"
          ? [...f.objects.keys()].find((k) => k.endsWith(".raw"))!
          : "artifacts/" + f.published.document.key;
      f.objects.get(key)![0].bytes = Buffer.from("changed");
    }
    await assert.rejects(f.builder.prepare(context, "drafting", f.published));
    assert.equal(f.getAudits(), 0);
  }
});
test("the actual prompt context is screened again; blocked input is never returned", async () => {
  const f = await promptFixture();
  const builder = new PromptContextBuilder(f.artifacts, f.audit, {
    screen: async () => {
      throw Error("blocked context");
    },
  });
  await assert.rejects(
    builder.prepare(context, "drafting", f.published),
    /blocked context/,
  );
  assert.equal(f.getAudits(), 0);
});
test("audit failure prevents context being returned to the model caller", async () => {
  const f = await promptFixture();
  f.audit.record = async () => {
    throw Error("audit unavailable");
  };
  await assert.rejects(
    f.builder.prepare(context, "drafting", f.published),
    /audit unavailable/,
  );
});
test("invalid context paths and invalid source encoding cannot become prompt content", async () => {
  const f = await promptFixture();
  await assert.rejects(
    f.builder.prepare(
      { ...context, tenantId: "../other" },
      "drafting",
      f.published,
    ),
  );
  const raw = Uint8Array.from([0xff, 0xfe]);
  await assert.rejects(
    f.publisher.publish({ ...source, sourceHash: sha256(raw) }, raw, "txt"),
  );
});
test("Guardrail requires numeric published version and rejects interventions or missing action", async () => {
  const { BedrockRuntimeClient } =
    await import("@aws-sdk/client-bedrock-runtime");
  for (const action of ["GUARDRAIL_INTERVENED", undefined]) {
    const client = {
      send: async () => ({ action }),
    } as unknown as InstanceType<typeof BedrockRuntimeClient>;
    for (const version of ["DRAFT", "0", "not-a-version"])
      assert.throws(() => new GuardrailScreen(client, "id", version));
    await assert.rejects(
      new GuardrailScreen(client, "id", "1").screen("text"),
      /failed closed/,
    );
  }
});
test("existing sample catalog still matches its public source bytes; no samples are uploaded by tests", async () => {
  const catalog = JSON.parse(
    await readFile("examples/sources/catalog.json", "utf8"),
  );
  for (const entry of catalog)
    assert.equal(
      sha256(await readFile("examples/sources/" + entry.file)),
      entry.sourceHash,
    );
});
