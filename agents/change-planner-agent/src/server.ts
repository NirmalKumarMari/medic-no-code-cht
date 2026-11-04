import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { EditChangeRequestSchema } from "./schema.js";
import { ZodError } from "zod";
import { config, validateLiveConfig } from "./config.js";
import {
  ChangePlannerAgentError,
  createBedrockConverse,
  runChangePlannerAgent,
} from "./agent.js";
import { createGatewayTools } from "./tools.js";
export function createApp(
  run: (request: unknown) => Promise<unknown>,
  token?: string,
) {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  let busy = false;
  app.get("/healthz", async () => ({ status: "ok", agent: "change-planner" }));
  app.post("/change-plan", async (request, reply) => {
    if (token) {
      const a = Buffer.from(request.headers.authorization ?? ""),
        b = Buffer.from(`Bearer ${token}`);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    if (busy) return reply.code(429).send({ error: "BUSY" });
    busy = true;
    try {
      return await run(request.body);
    } catch (e) {
      return reply
        .code(
          e instanceof ZodError || e instanceof ChangePlannerAgentError
            ? 422
            : 502,
        )
        .send({
          error:
            e instanceof ZodError
              ? "INVALID_CONTRACT"
              : e instanceof ChangePlannerAgentError
                ? e.code
                : "PLANNER_UNAVAILABLE",
          humanReviewRequired: true,
        });
    } finally {
      busy = false;
    }
  });
  return app;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  validateLiveConfig();
  const app = createApp(async (raw) => {
    const request = EditChangeRequestSchema.parse(raw);
    const deadline = AbortSignal.timeout(105000);
    const trace = (event: Record<string, unknown>) =>
      process.stderr.write(
        JSON.stringify({
          agent: "change-planner",
          changeId: request.changeId,
          ...event,
        }) + "\n",
      );
    const converse = createBedrockConverse(undefined, config, trace, deadline);
    const connection = await createGatewayTools(process.env, deadline);
    try {
      const plan = await runChangePlannerAgent(
        request,
        connection.tools,
        converse,
      );
      trace({
        event: "planner.completed",
        snapshotHash: plan.snapshotHash,
        status: plan.status,
      });
      return plan;
    } finally {
      await connection.close();
    }
  }, config.workerToken);
  await app.listen({ port: config.port, host: config.host });
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => void app.close());
}
