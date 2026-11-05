import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { ArtifactStore } from "@vera/artifact-storage";
import { WorkflowRepository, s3SnapshotVerifier, tablesFromEnvironment } from "@vera/workflow-data";
import { RegistrarBusy, registerSnapshot, type RegistrarDeps } from "./registrar.js";

/**
 * POST /register — called by the Step Functions RegisterDraft / RegisterPlan
 * states through invoke-worker.
 *
 * Answers 200 with `{ ok: true, output }` or `{ ok: false, failure }`. Only
 * service-level problems are non-2xx: 401 bad worker token, 503 busy (the state
 * machine retries), 500 unexpected error. Error bodies never include SDK
 * errors or request content.
 */
export function createApp(run: (body: unknown) => ReturnType<typeof registerSnapshot>, token?: string) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.get("/healthz", async () => ({ status: "ok", worker: "snapshot-registrar" }));
  app.post("/register", async (request, reply) => {
    if (token) {
      const a = Buffer.from(request.headers.authorization ?? "");
      const b = Buffer.from(`Bearer ${token}`);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    try {
      return await run(request.body);
    } catch (err) {
      if (err instanceof RegistrarBusy) return reply.code(503).send({ error: "BUSY" });
      return reply.code(500).send({ error: "REGISTRAR_FAILED" });
    }
  });
  return app;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8084);
  const token = process.env.WORKER_AUTH_TOKEN;
  if (host !== "127.0.0.1" && host !== "::1" && (!token || token.length < 32)) {
    throw new Error("Non-loopback listener requires WORKER_AUTH_TOKEN of at least 32 characters");
  }
  const digest = required("TOOLCHAIN_IMAGE_DIGEST");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("TOOLCHAIN_IMAGE_DIGEST must be sha256:<64 hex>");
  const region = process.env.AWS_REGION ?? "us-west-2";
  const bucket = required("ARTIFACT_BUCKET");
  const s3 = new S3Client({ region });
  const deps: RegistrarDeps = {
    repo: new WorkflowRepository({
      client: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
      tables: tablesFromEnvironment(),
      verifySnapshot: s3SnapshotVerifier(s3, bucket),
    }),
    artifacts: new ArtifactStore(s3, bucket, required("KMS_KEY_ARN")),
    config: {
      schemaVersion: process.env.SNAPSHOT_SCHEMA_VERSION ?? "1",
      goldenCaseVersion: required("GOLDEN_CASE_VERSION"),
      compilerVersion: required("COMPILER_VERSION"),
      toolchainImageDigest: digest,
    },
  };
  const app = createApp((body) => registerSnapshot(body, deps), token);
  await app.listen({ host, port });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void app.close());
}
