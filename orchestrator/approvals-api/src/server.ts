import Fastify from "fastify";
import { config } from "./config.js";
import { ApprovalError, completeApproval } from "./approvals.js";
import { createAwsDeps } from "./deps.js";
import { ApprovalDecisionRequestSchema, ApprovalKindSchema } from "./schema.js";

const app = Fastify({ logger: true });
const deps = createAwsDeps();

app.get("/healthz", async () => ({ status: "ok" }));

/**
 * NOTE: in a real deployment this route sits behind Cognito (design doc
 * section 14/15) — the Review UI authenticates the human and this API
 * trusts the authenticated identity, not a self-reported approverId in the
 * body. Until that's wired up, approverId/approverRole are taken from the
 * request body, which is fine for local testing and should NOT be treated
 * as a real auth boundary.
 */
app.post<{ Params: { changeId: string; kind: string } }>(
  "/approvals/:changeId/:kind",
  async (request, reply) => {
    const kindResult = ApprovalKindSchema.safeParse(request.params.kind);
    if (!kindResult.success) {
      return reply.code(400).send({ error: "kind must be 'content' or 'deploy'" });
    }
    const bodyResult = ApprovalDecisionRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.code(400).send({ error: bodyResult.error.message });
    }

    try {
      const result = await completeApproval(request.params.changeId, kindResult.data, bodyResult.data, deps);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof ApprovalError) {
        request.log.warn({ err }, "approval rejected by policy");
        return reply.code(err.statusCode).send({ error: err.message });
      }
      request.log.error({ err }, "unexpected approvals-api failure");
      return reply.code(500).send({ error: "internal error" });
    }
  },
);

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => app.log.info(`approvals-api listening on :${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
