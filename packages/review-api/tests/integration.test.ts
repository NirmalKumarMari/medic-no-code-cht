import { DocumentsService } from "../src/documents.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  AuthoringRepository,
  DocumentRepository,
  WorkflowRepository,
  sha256,
} from "@vera/workflow-data";
import { exampleDraft } from "@vera/review-model/data/drafts";
import { buildLogicModel } from "@vera/review-model/data/stubGenerator";
import {
  createTables,
  makeHarness,
  author,
  clinician,
  bundle,
} from "../../workflow-data/tests/harness.js";
import { createApp } from "../src/app.js";
import { HttpError, cognitoAuthenticator } from "../src/auth.js";
import { LocalArtifacts } from "../src/artifacts.js";
import { ReviewService } from "../src/service.js";

let fixture: Awaited<ReturnType<typeof createTables>>;
let directory: string;
let artifacts: LocalArtifacts;
let service: ReviewService;
let app: ReturnType<typeof createApp>;
const people = {
  officer: author,
  clinician,
  outsider: { ...author, tenantId: "other-tenant" },
};
before(async () => {
  fixture = await createTables(`review-api-${randomUUID()}`);
  directory = await mkdtemp(join(tmpdir(), "vera-review-"));
  artifacts = new LocalArtifacts(directory);
  const repo = new WorkflowRepository({
    ...fixture,
    verifySnapshot: async () => {
      throw Error("API must not create workflow snapshots");
    },
  });
  service = new ReviewService(
    new AuthoringRepository(fixture.client, fixture.tables),
    repo,
    artifacts,
    async () => {},
  );
  app = createApp({
    service,
    documents: new DocumentsService(
      new DocumentRepository(fixture.client, fixture.tables),
      artifacts,
      async () => {},
    ),
    mode: "local",
    origins: ["http://localhost:5173"],
    authConfig: { mode: "local" },
    authenticate: async (request) => {
      const person =
        people[
          request.headers.authorization?.replace(
            "Bearer ",
            "",
          ) as keyof typeof people
        ];
      if (!person)
        throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
      return {
        subject: person.subject,
        groups: person.groups,
        tenants: [person.tenantId],
      };
    },
  });
});
after(async () => {
  await app?.close();
  fixture?.client.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const headers = (person = "officer") => ({ authorization: `Bearer ${person}` });
const create = () => ({
  requestId: randomUUID(),
  expectedVersion: 0,
  draft: exampleDraft(),
});
async function save(body = create()) {
  const result = await app.inject({
    method: "POST",
    url: "/api/drafts",
    headers: headers(),
    payload: body,
  });
  assert.equal(result.statusCode, 200, result.body);
  return { body, saved: result.json() };
}

test("save, fresh-service reload and same-request retries persist one version and one audit event", async () => {
  const { body, saved } = await save();
  const second = await app.inject({
    method: "POST",
    url: "/api/drafts",
    headers: headers(),
    payload: body,
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().contentHash, saved.contentHash);
  const restart = new ReviewService(
    new AuthoringRepository(fixture.client, fixture.tables),
    service.workflow,
    new LocalArtifacts(directory),
    async () => {},
  );
  const loaded = await restart.readDraft(author, saved.changeId);
  assert.deepEqual(loaded.draft, body.draft);
  assert.deepEqual(loaded.model, saved.model);
  const audit = await app.inject({
    url: `/api/drafts/${saved.changeId}/audit`,
    headers: headers(),
  });
  assert.equal(audit.json().items.length, 1);
  const workflowRow = await fixture.client.send(
    new GetCommand({
      TableName: fixture.tables.changes,
      Key: { changeId: saved.changeId, sk: "META" },
    }),
  );
  assert.equal(workflowRow.Item, undefined);
  for (const TableName of [fixture.tables.approvals, fixture.tables.tokens]) {
    const scan = await fixture.client.send(
      new ScanCommand({ TableName, Select: "COUNT" }),
    );
    assert.equal(scan.Count, 0);
  }
});
test("authoring revisions preserve old bytes, reject stale saves and never create workflow approvals", async () => {
  const { saved, body } = await save();
  const revision = {
    ...body,
    requestId: randomUUID(),
    expectedVersion: 1,
    draft: { ...body.draft, pathway: "Revised synthetic pathway" },
  };
  const next = await app.inject({
    method: "PUT",
    url: `/api/drafts/${saved.changeId}`,
    headers: headers(),
    payload: revision,
  });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().version, 2);
  const old = await app.inject({
    url: `/api/drafts/${saved.changeId}?revisionId=${body.requestId}`,
    headers: headers(),
  });
  assert.equal(old.json().contentHash, saved.contentHash);
  const stale = await app.inject({
    method: "PUT",
    url: `/api/drafts/${saved.changeId}`,
    headers: headers(),
    payload: { ...revision, requestId: randomUUID() },
  });
  assert.equal(stale.statusCode, 409);
  const approval = await app.inject({
    method: "POST",
    url: `/api/reviews/${saved.changeId}/decisions`,
    headers: headers("clinician"),
    payload: {
      snapshotHash: saved.contentHash,
      decision: "approve",
      decisionId: randomUUID(),
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(approval.statusCode, 404);
});
test("identities and tenants are server-owned; roles, extra fields and cross-tenant reads are rejected", async () => {
  assert.equal((await app.inject({ url: "/api/drafts" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/drafts",
        headers: headers("clinician"),
        payload: create(),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/drafts",
        headers: headers(),
        payload: { ...create(), authorId: "forged", groups: ["clinician"] },
      })
    ).statusCode,
    400,
  );
  const { saved } = await save();
  assert.equal(
    (
      await app.inject({
        url: `/api/drafts/${saved.changeId}`,
        headers: headers("outsider"),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/drafts",
        headers: { ...headers(), "x-tenant-id": "other-tenant" },
      })
    ).statusCode,
    403,
  );
  const cursor = Buffer.from(
    JSON.stringify({
      changeId: saved.changeId,
      sk: "AUTHORING#META",
      inbox: "other-tenant#authoring",
    }),
  ).toString("base64url");
  assert.equal(
    (
      await app.inject({
        url: `/api/drafts?cursor=${cursor}`,
        headers: headers(),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/drafts",
        headers: { ...headers(), origin: "https://untrusted.example" },
      })
    ).statusCode,
    403,
  );
});
test("tampered artifact bytes fail visibly and do not become a successful review", async () => {
  const { saved } = await save();
  await writeFile(join(directory, saved.contentHash), "tampered");
  const result = await app.inject({
    url: `/api/drafts/${saved.changeId}`,
    headers: headers(),
  });
  assert.equal(result.statusCode, 503);
  assert.ok(!result.body.includes(directory));
});
test("invalid form structure and forged choice comparisons are rejected server-side", async () => {
  const payload = create();
  payload.draft.rules[0].conditions[0].questionKey = "missing";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/drafts",
        headers: headers(),
        payload,
      })
    ).statusCode,
    400,
  );
  const bad = create();
  bad.draft.questions[0].type = "yes_no";
  bad.draft.rules[0].conditions[0].op = "gte";
  bad.draft.rules[0].conditions[0].value = "yes";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/drafts",
        headers: headers(),
        payload: bad,
      })
    ).statusCode,
    400,
  );
});
test("real workflow content decisions keep snapshot binding, role separation and durable callback receipts", async () => {
  const h = makeHarness(fixture.client, fixture.tables);
  const spec = buildLogicModel(exampleDraft(), 1);
  const clinicalBundle = { ...bundle, spec: JSON.parse(JSON.stringify(spec)) };
  const f = await h.create(clinicalBundle);
  const report = h.ref({ fixture: "validation" });
  await h.repo.recordValidation(f.worker, {
    changeId: f.changeId,
    snapshotHash: f.hash,
    passed: true,
    requiresClinician: true,
    openAmbiguities: 0,
    report,
  });
  await h.open(f, "content");
  const workflowArtifacts = {
    ...artifacts,
    putArtifact: artifacts.putArtifact.bind(artifacts),
    getArtifactVersion: async (ref: { sha256: string }) => {
      for (const value of [clinicalBundle, { fixture: "validation" }]) {
        const bytes = Buffer.from(JSON.stringify(value));
        if (sha256(bytes) === ref.sha256) return bytes;
      }
      throw Error("Missing test artifact");
    },
  };
  const workflowService = new ReviewService(
    service.authoring,
    h.repo,
    workflowArtifacts,
    async () => {},
  );
  const review = await workflowService.readReview(clinician, f.changeId);
  assert.equal(review.canApprove, true);
  assert.equal(review.snapshotHash, f.hash);
  const input = {
    snapshotHash: f.hash,
    decision: "approve",
    notes: "Synthetic test only",
    decisionId: randomUUID(),
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(workflowService.decide(author, f.changeId, input));
  await assert.rejects(
    workflowService.decide(clinician, f.changeId, {
      ...input,
      snapshotHash: "0".repeat(64),
    }),
  );
  await workflowService.decide(clinician, f.changeId, input);
  await workflowService.decide(clinician, f.changeId, input);
  assert.equal((await h.repo.listDecisions(clinician, f.changeId)).length, 1);
  const result = await workflowService.readReview(clinician, f.changeId);
  assert.equal(result.state, "content_approved");
  assert.equal(result.canApprove, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("synthetic-token"));
  assert.ok(!serialized.includes("taskToken"));
});
test("Cognito authenticator rejects missing and malformed bearer tokens", async () => {
  const authenticate = cognitoAuthenticator(
    "us-west-2_Fixture",
    "fixture-client",
    {},
  );
  await assert.rejects(
    authenticate({ headers: {} } as any),
    (e: any) => e.status === 401,
  );
  await assert.rejects(
    authenticate({ headers: { authorization: "Bearer forged" } } as any),
    (e: any) => e.status === 401,
  );
});

test("renderer rejects hidden clinical action fields and mismatched choice aliases", async () => {
  const { reviewDisplaySchema } =
    await import("@vera/review-model/data/display-schema");
  const model = buildLogicModel(exampleDraft(), 1);
  assert.equal(reviewDisplaySchema.safeParse(model).success, true);
  assert.equal(
    reviewDisplaySchema.safeParse({
      ...model,
      rules: model.rules.map((r, i) =>
        i ? r : { ...r, then: { ...r.then, hiddenDose: 10 } },
      ),
    }).success,
    false,
  );
  assert.equal(
    reviewDisplaySchema.safeParse({
      ...model,
      inputs: [
        {
          id: "choice",
          type: "select_one",
          label: "Choose",
          choices: ["a", "b"],
          options: ["a", "c"],
        },
      ],
    }).success,
    false,
  );
});

test("an idempotency ID reused for altered draft bytes fails and preserves the stored version", async () => {
  const { body, saved } = await save();
  const result = await app.inject({
    method: "POST",
    url: "/api/drafts",
    headers: headers(),
    payload: { ...body, draft: { ...body.draft, pathway: "Altered content" } },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    (await service.readDraft(author, saved.changeId)).contentHash,
    saved.contentHash,
  );
});

test("PDF uploads preserve original bytes and every S3-style version; cross-tenant reads are refused", async () => {
  const documentId = randomUUID(),
    requestId = randomUUID();
  const pdf = Buffer.from(
    "%PDF-1.4\nSynthetic storage verification only\n%%EOF",
  );
  const uploadHeaders = {
    ...headers(),
    "content-type": "application/pdf",
    "x-filename": encodeURIComponent("synthetic-guideline.pdf"),
    "x-request-id": requestId,
    "x-document-version": "0",
  };
  let r = await app.inject({
    method: "POST",
    url: `/api/documents/${documentId}`,
    headers: uploadHeaders,
    payload: pdf,
  });
  assert.equal(r.statusCode, 200, r.body);
  const v1 = r.json();
  assert.equal(v1.version, 1);
  assert.equal(v1.artifact.sha256, sha256(pdf));
  r = await app.inject({
    method: "POST",
    url: `/api/documents/${documentId}`,
    headers: uploadHeaders,
    payload: pdf,
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().version, 1);
  const nextId = randomUUID(),
    next = Buffer.from(
      "%PDF-1.4\nRevised synthetic storage verification\n%%EOF",
    );
  r = await app.inject({
    method: "POST",
    url: `/api/documents/${documentId}`,
    headers: {
      ...uploadHeaders,
      "x-request-id": nextId,
      "x-document-version": "1",
    },
    payload: next,
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().version, 2);
  r = await app.inject({
    url: `/api/documents/${documentId}/file?revisionId=${requestId}`,
    headers: headers(),
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.rawPayload, pdf);
  r = await app.inject({
    url: `/api/documents/${documentId}/versions`,
    headers: headers(),
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().items.length, 2);
  assert.equal(
    (
      await app.inject({
        url: `/api/documents/${documentId}/file`,
        headers: headers("outsider"),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/documents/${randomUUID()}`,
        headers: { ...uploadHeaders, "x-request-id": randomUUID() },
        payload: Buffer.from("not a PDF"),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/documents/${randomUUID()}`,
        headers: {
          ...uploadHeaders,
          ...headers("clinician"),
          "x-request-id": randomUUID(),
        },
        payload: pdf,
      })
    ).statusCode,
    403,
  );
});
