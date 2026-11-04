import Fastify from "fastify";
import { config } from "./config.js";
import { createBedrockConverse } from "./agent.js";
import { handleIntake } from "./handler.js";
import { createDirectTools } from "./tools.js";

const app = Fastify({ logger: true });
const tools = createDirectTools();
const converse = createBedrockConverse();

app.get("/healthz", async () => ({ status: "ok" }));

/**
 * Orchestrator entrypoint for the Intake state. Takes the shared AgentRequest
 * envelope and always answers 200 with an AgentResult (`ok: true` with the
 * StructuredSpec, or `ok: false` with a failure the orchestrator surfaces to a
 * human). A non-2xx response only ever means this service is broken.
 */
app.post("/intake", async (request, reply) => {
  const result = await handleIntake(request.body, tools, converse);
  if (!result.ok) {
    request.log.warn(
      { changeId: result.changeId, runId: result.runId, reason: result.failure.reason },
      "intake agent returned a failure",
    );
  }
  return reply.code(200).send(result);
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => app.log.info(`intake-agent listening on :${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
