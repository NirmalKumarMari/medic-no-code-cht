import { SFNClient } from "@aws-sdk/client-sfn";
import { PipelineService } from "./pipeline.js";
import { resolve } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ArtifactStore, GuardrailScreen } from "@vera/artifact-storage";
import {
  AuthoringRepository,
  DocumentRepository,
  WorkflowRepository,
  tablesFromEnvironment,
} from "@vera/workflow-data";
import { z } from "zod";
import { createApp } from "./app.js";
import { cognitoAuthenticator, HttpError, type Authenticate } from "./auth.js";
import { LocalArtifacts, type ArtifactIO } from "./artifacts.js";
import { HistoryService } from "./history.js";
import { DocumentsService } from "./documents.js";
import { ReviewService } from "./service.js";

const env = process.env;
function required(name: string) {
  const v = env[name];
  if (!v) throw Error(`Missing ${name}`);
  return v;
}
const previewArn = env.REVIEW_PIPELINE_ARN;
const mode = z.enum(["local", "aws"]).parse(env.REVIEW_MODE ?? "aws");
const region = env.AWS_REGION ?? "us-west-2";
const host = env.REVIEW_HOST ?? "127.0.0.1";
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(env.REVIEW_PORT ?? 3001);
const endpoint =
  mode === "local"
    ? (env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:18000")
    : undefined;
if (
  mode === "local" &&
  (!["localhost", "127.0.0.1", "::1"].includes(host) ||
    !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint!))
)
  throw Error("Local mode requires loopback-only API and DynamoDB endpoints");
if (mode === "aws" && env.DYNAMODB_ENDPOINT)
  throw Error("AWS mode does not accept a DynamoDB endpoint override");
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region,
    endpoint,
    ...(mode === "local"
      ? {
          credentials: {
            accessKeyId: "localdevelopment",
            secretAccessKey: "localdevelopment",
          },
        }
      : {}),
  }),
  { marshallOptions: { removeUndefinedValues: true } },
);
const tables = tablesFromEnvironment(
  mode === "local" ? { WORKFLOW_TABLE_PREFIX: "vera-ui-local" } : env,
);
let artifacts: ArtifactIO;
let authenticate: Authenticate;
let screen: (text: string) => Promise<void>;
let authConfig: Parameters<typeof createApp>[0]["authConfig"];
if (mode === "local") {
  artifacts = new LocalArtifacts(
    resolve(env.REVIEW_LOCAL_ARTIFACT_DIR ?? ".local/review-artifacts"),
  );
  authenticate = async () => ({
    subject: "local-program-officer",
    groups: ["program_officer"],
    tenants: ["local-workshop"],
  });
  screen = async (text) => {
    if (/AKIA[A-Z0-9]{16}|-----BEGIN .*PRIVATE KEY-----/i.test(text))
      throw new HttpError(
        422,
        "SCREENING_REJECTED",
        "Remove credential-like text before saving",
      );
  };
  authConfig = { mode: "local" };
} else {
  const bucket = required("WORKFLOW_ARTIFACT_BUCKET");
  artifacts = new ArtifactStore(
    new S3Client({ region }),
    bucket,
    required("KMS_KEY_ARN"),
  );
  const authMode = z.enum(["cognito", "demo"]).parse(env.REVIEW_AUTH_MODE ?? "demo");
  if (authMode === "demo") {
    const tenant = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).parse(env.REVIEW_DEMO_TENANT ?? "workshop-049197632966");
    authenticate = async (request) => {
      const persona = previewArn ? request.headers["x-demo-persona"] : undefined;
      const group = persona === "clinician" || persona === "it_deploy" ? persona : "program_officer";
      return { subject: `demo-${group.replaceAll("_", "-")}`, groups: [group], tenants: [tenant] };
    };
    authConfig = { mode: "demo", ...(previewArn ? { pipeline: true } : {}) };
  } else {
  const domain = new URL(required("COGNITO_DOMAIN"));
  if (
    domain.protocol !== "https:" ||
    domain.pathname !== "/" ||
    domain.username ||
    domain.password ||
    domain.search ||
    domain.hash
  )
    throw Error("COGNITO_DOMAIN must be an HTTPS origin");
  const memberships = z
    .record(
      z.string(),
      z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)).min(1),
    )
    .parse(JSON.parse(required("REVIEW_TENANT_MEMBERSHIPS")));
  authenticate = cognitoAuthenticator(
    required("COGNITO_USER_POOL_ID"),
    required("COGNITO_CLIENT_ID"),
    memberships,
  );
  authConfig = { mode: "cognito", domain: domain.origin, clientId: required("COGNITO_CLIENT_ID") };
  }
  const guardrail = new GuardrailScreen(
    new BedrockRuntimeClient({ region }),
    required("GUARDRAIL_ID"),
    required("GUARDRAIL_VERSION"),
  );
  screen = async (text) => {
    if (!text.trim()) return;
    try {
      await guardrail.screen(text);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Input screening failed closed"
      )
        throw new HttpError(
          422,
          "SCREENING_REJECTED",
          "Input screening did not accept this content. Review the text before saving.",
        );
      throw error;
    }
  };

}
const workflow = new WorkflowRepository({
  client,
  tables,
  verifySnapshot: async () => {
    throw Error("The review API cannot register workflow snapshots");
  },
});
const service = new ReviewService(
  new AuthoringRepository(client, tables),
  workflow,
  artifacts,
  screen,
);
const origins = (
  mode === "local"
    ? `http://localhost:5173,http://127.0.0.1:5173${env.REVIEW_ALLOWED_ORIGINS ? `,${env.REVIEW_ALLOWED_ORIGINS}` : ""}`
    : required("REVIEW_ALLOWED_ORIGINS")
)
  .split(",")
  .map((s) => new URL(s.trim()).origin);
const documentRepository = new DocumentRepository(client, tables);
const documents = new DocumentsService(documentRepository, artifacts, screen);
const pipeline = previewArn ? new PipelineService(new SFNClient({ region }), previewArn, workflow, documentRepository, artifacts, screen) : undefined;
const app = createApp({ service, documents, history: new HistoryService(workflow, artifacts), pipeline, authenticate, mode, origins, authConfig });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await app.close();
    client.destroy();
  });
await app.listen({ host, port });
console.log(
  `Vera review API listening on ${host}:${port} (${mode === "local" ? "LOCAL: DynamoDB Local + local files; no AWS or clinical approvals fabricated" : "AWS: DynamoDB + S3"})`,
);
