function integer(name: string, fallback: number, min: number, max: number) {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < min || v > max)
    throw Error(`Invalid ${name}`);
  return v;
}
export const config = {
  region: process.env.AWS_REGION ?? "us-west-2",
  host: process.env.HOST ?? "127.0.0.1",
  port: integer("PORT", 8083, 1, 65535),
  workerToken: process.env.WORKER_AUTH_TOKEN,
  bedrock: {
    draftModelId:
      process.env.CHANGEPLAN_MODEL_ID ??
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    escalationModelId:
      process.env.CHANGEPLAN_ESCALATION_MODEL_ID ??
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    guardrailId: process.env.BEDROCK_GUARDRAIL_ID,
    guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION,
    promptCaching: process.env.CHANGEPLAN_PROMPT_CACHING !== "false",
  },
  agent: {
    maxSchemaRepairAttempts: integer(
      "CHANGEPLAN_MAX_SCHEMA_REPAIR_ATTEMPTS",
      2,
      0,
      2,
    ),
  },
};
export function validateLiveConfig(settings = config) {
  if (!settings.bedrock.guardrailId || !settings.bedrock.guardrailVersion)
    throw Error(
      "BEDROCK_GUARDRAIL_ID and BEDROCK_GUARDRAIL_VERSION are required.",
    );
  for (const model of [
    settings.bedrock.draftModelId,
    settings.bedrock.escalationModelId,
  ])
    if (!model.startsWith("us."))
      throw Error("Configure us. inference profiles.");
  if (
    settings.host !== "127.0.0.1" &&
    settings.host !== "::1" &&
    (!settings.workerToken || settings.workerToken.length < 32)
  )
    throw Error(
      "Non-loopback listener requires a worker token of at least 32 characters.",
    );
}
