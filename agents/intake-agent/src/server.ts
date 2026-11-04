import Fastify from "fastify";
import { config } from "./config.js";
import { IntakeAgentError, createBedrockConverse, runIntakeAgent } from "./agent.js";
import { createDirectTools } from "./tools.js";

const app = Fastify({ logger: true });
const tools = createDirectTools();
const converse = createBedrockConverse();

app.get("/healthz", async () => ({ status: "ok" }));

/**
 * Contract for whoever builds the orchestrator (Step Functions): this is
 * the one entrypoint it calls for the "Intake" state. On success it
 * returns the persisted StructuredSpec (changeId included). On failure it
 * returns 422 with an error the orchestrator should surface to a human —
 * this agent never retries past its own bounded limits, and the caller
 * must not either.
 */
app.post("/intake", async (request, reply) => {
  try {
    const spec = await runIntakeAgent(request.body, tools, converse);
    return reply.code(200).send(spec);
  } catch (err) {
    if (err instanceof IntakeAgentError) {
      request.log.warn({ err }, "intake agent could not produce a valid spec");
      return reply.code(422).send({ error: err.message });
    }
    request.log.error({ err }, "unexpected intake agent failure");
    return reply.code(500).send({ error: "internal error" });
  }
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => app.log.info(`intake-agent listening on :${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
