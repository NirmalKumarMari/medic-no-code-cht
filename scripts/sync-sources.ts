import { readFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";
import { ArtifactStore, sha256 } from "../src/artifacts.js";
import { IngestionJobs, type Publication } from "../src/ingestion.js";
import type { SourceType } from "../src/contracts.js";
function env(k: string) {
  const v = process.env[k];
  if (!v) throw Error(`Missing ${k}`);
  return v;
}
const s3 = new S3Client({});
const key = env("KMS_KEY_ARN");
const artifacts = new ArtifactStore(s3, env("ARTIFACT_BUCKET"), key);
const sources = new ArtifactStore(s3, env("KB_SOURCE_BUCKET"), key, [
  "guideline/",
  "cht-docs/",
  "reference-config/",
]);
const jobs = new IngestionJobs(
  new BedrockAgentClient({}),
  env("KNOWLEDGE_BASE_ID"),
  {
    guideline: env("GUIDELINE_DATA_SOURCE_ID"),
    "cht-docs": env("CHT_DOCS_DATA_SOURCE_ID"),
    "reference-config": env("REFERENCE_CONFIG_DATA_SOURCE_ID"),
  },
  sources,
  artifacts,
);
const publications: Publication[] = JSON.parse(
  await readFile("publications.json", "utf8"),
);
for (const type of [
  "guideline",
  "cht-docs",
  "reference-config",
] as SourceType[]) {
  const batch = publications.filter((p) => p.sourceType === type);
  const token = sha256(JSON.stringify(batch));
  const job = await jobs.start(type, batch, token);
  if (!job?.ingestionJobId) throw Error("Missing ingestion job ID");
  console.log({ type, jobId: job.ingestionJobId, status: job.status });
  // One bounded observation; rerun with the same token to resume. Never claim success before COMPLETE with zero failed documents.
  const status = await jobs.status(type, job.ingestionJobId);
  console.log({
    type,
    status: status.status,
    statistics: status.statistics,
    failureReasons: status.failureReasons,
  });
  if (
    status.status !== "COMPLETE" ||
    (status.statistics?.numberOfDocumentsFailed ?? 0) > 0
  )
    process.exitCode = 1;
}
