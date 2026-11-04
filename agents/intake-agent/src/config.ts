/**
 * All environment-specific values live here as plain env vars (design doc
 * section 14: "nothing hard-codes an ARN or account ID", and the handover
 * rule that models sit behind one swappable interface).
 */
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8081),
  region: required("AWS_REGION", "us-west-2"),

  // Bedrock model IDs are env-driven on purpose: swapping a model, or
  // escalating from Haiku to Sonnet on repeated schema failures, is a
  // config change, never a code change.
  bedrock: {
    draftModelId: required(
      "INTAKE_MODEL_ID",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    ),
    escalationModelId: process.env.INTAKE_ESCALATION_MODEL_ID, // optional; used on repeated schema failures
    guardrailId: process.env.BEDROCK_GUARDRAIL_ID, // optional locally; required in any real deployment
    guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION ?? "DRAFT",
  },

  storage: {
    specsBucket: required("SPECS_S3_BUCKET", "medic-nocode-specs-local"),
    specsPrefix: process.env.SPECS_S3_PREFIX ?? "specs/",
    changesTable: required("CHANGES_TABLE_NAME", "Changes"),
  },

  agent: {
    // One non-looping call on the happy path, plus up to 2 schema-repair
    // attempts (design §7). There is no tool loop anymore.
    maxSchemaRepairAttempts: Number(process.env.INTAKE_MAX_SCHEMA_REPAIR_ATTEMPTS ?? 2),
  },
};
