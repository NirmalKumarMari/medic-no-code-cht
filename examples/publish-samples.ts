import { readFile, writeFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ArtifactStore } from "../src/artifacts.js";
import { Ingestor, GuardrailScreen } from "../src/ingestion.js";
import { sourceSchema } from "../src/contracts.js";
function env(key: string) {
  const value = process.env[key];
  if (!value) throw Error(`Missing ${key}`);
  return value;
}
// Run in the trusted ingestion worker role. Review files and set SOURCE_REVIEWER before running.
const reviewer = env("SOURCE_REVIEWER");
const reviewedAt = env("SOURCE_REVIEWED_AT");
const s3 = new S3Client({});
const artifacts = new ArtifactStore(
  s3,
  env("ARTIFACT_BUCKET"),
  env("KMS_KEY_ARN"),
);
const sources = new ArtifactStore(
  s3,
  env("KB_SOURCE_BUCKET"),
  env("KMS_KEY_ARN"),
  ["guideline/", "cht-docs/", "reference-config/"],
);
const ingestor = new Ingestor(
  sources,
  artifacts,
  new GuardrailScreen(
    new BedrockRuntimeClient({}),
    env("GUARDRAIL_ID"),
    env("GUARDRAIL_VERSION"),
  ),
  ["https://www.cdc.gov", "https://raw.githubusercontent.com"],
);
const catalog = JSON.parse(
  await readFile("examples/sources/catalog.json", "utf8"),
);
const publications = [];
for (const entry of catalog) {
  const { file, format, extraction, reviewStatus, ...metadata } = entry;
  const source = sourceSchema.parse({
    ...metadata,
    public: true,
    purpose: "reference-document",
    reviewedBy: reviewer,
    reviewedAt,
  });
  publications.push(
    await ingestor.publish(
      source,
      await readFile("examples/sources/" + file),
      format,
    ),
  );
}
await writeFile("publications.json", JSON.stringify(publications, null, 2));
console.log(
  "Screened sources uploaded. Start the three ingestion jobs with IngestionJobs; wait for COMPLETE and zero failed documents before enabling retrieval.",
);
