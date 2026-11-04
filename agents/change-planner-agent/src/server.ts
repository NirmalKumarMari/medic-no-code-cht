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
import { handleChangePlan } from "./handler.js";
import { createGatewayTools } from "./tools.js";
export function createApp(
  run: (request: unknown) => Promise<unknown>,
  token?: string,
  bodyLimit = 16384,
) {
  const app = Fastify({ logger: false, bodyLimit });
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
  // POST /change-plan takes the shared AgentRequest envelope and always answers
  // 200 with an AgentResult (handleChangePlan never throws). Only service-level
  // problems are non-2xx: 401 bad worker token, 429 busy, 413 oversized body.
  const app = createApp(
    async (body) =>
      handleChangePlan(body, async (spec, revision) => {
        const request = EditChangeRequestSchema.parse(spec);
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
            config,
            revision,
          );
          trace({
            event: "planner.completed",
            snapshotHash: plan.snapshotHash,
            status: plan.status,
            replan: Boolean(revision),
          });
          return plan;
        } finally {
          await connection.close();
        }
      }),
    config.workerToken,
    // Room for the envelope plus up to 8,000 characters of rejection notes (UTF-8).
    65536,
  );
  await app.listen({ port: config.port, host: config.host });
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => void app.close());
}
