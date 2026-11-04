import Fastify from "fastify";
import { BedrockGuardrail, BedrockModelClient, DEFAULT_MODEL_IDS, DraftingAgent } from "./index.js";
import { handleDrafting } from "./handler.js";

/**
 * Drafting Agent HTTP entrypoint for the Step Functions "Draft" state.
 *
 * Fails closed on screening: the service refuses to start without a Bedrock
 * Guardrail, so no drafting input can reach a model unscreened (design rule 8).
 */
const region = process.env.AWS_REGION ?? "us-west-2";
const port = Number(process.env.PORT ?? 8083);
const modelId = process.env.DRAFTING_MODEL_ID ?? DEFAULT_MODEL_IDS.haiku;
const guardrailId = process.env.BEDROCK_GUARDRAIL_ID;
if (!guardrailId) {
  throw new Error("BEDROCK_GUARDRAIL_ID is required: the Drafting Agent never runs without input screening");
}

const agent = new DraftingAgent(new BedrockModelClient({ modelId, region }), {
  guardrail: new BedrockGuardrail({
    guardrailIdentifier: guardrailId,
    guardrailVersion: process.env.BEDROCK_GUARDRAIL_VERSION ?? "DRAFT",
    region,
  }),
});

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

app.get("/healthz", async () => ({ status: "ok" }));

/** Always 200 with an AgentResult; a non-2xx response only ever means this service is broken. */
app.post("/draft", async (request, reply) => {
  const result = await handleDrafting(request.body, agent, modelId);
  if (!result.ok) {
    request.log.warn(
      { changeId: result.changeId, runId: result.runId, reason: result.failure.reason },
      "drafting agent returned a failure",
    );
  }
  return reply.code(200).send(result);
});

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`drafting-agent listening on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
