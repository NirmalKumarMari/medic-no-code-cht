import {
  agentFailure,
  agentSuccess,
  parseAgentRequest,
  type AgentResult,
  type StructuredSpec,
} from "@vera/schemas";
import { IntakeAgentError, runIntakeAgentWithModel, type ConverseFn } from "./agent.js";
import { IntakeRequestSchema } from "./schema.js";
import type { Tools } from "./tools.js";

export type IntakeResult = AgentResult<StructuredSpec>;

/**
 * One Intake Agent_Run behind the shared envelope.
 *
 * Request:  { changeId, runId, tenant, payload: IntakeRequest }
 * Result:   { agent: "intake", changeId, runId, tenant, ok: true, output: StructuredSpec }
 *        or { agent: "intake", changeId, runId, tenant, ok: false, failure }
 *
 * Never throws: every outcome, including an unexpected error, is an AgentResult.
 */
export async function handleIntake(
  body: unknown,
  tools: Tools,
  converse: ConverseFn,
): Promise<IntakeResult> {
  const parsed = parseAgentRequest("intake", body, IntakeRequestSchema);
  if (!parsed.ok) return parsed.result;
  const { request } = parsed;

  // The envelope changeId is authoritative; a mismatched payload is a caller bug.
  if (request.payload.changeId !== request.changeId) {
    return agentFailure("intake", request, {
      reason: "invalid_request",
      message: "payload.changeId does not match the request changeId",
      details: [{ path: "payload.changeId", message: "must equal changeId" }],
    });
  }

  try {
    const run = await runIntakeAgentWithModel(request.payload, tools, converse);
    return agentSuccess("intake", request, run.spec, { modelId: run.modelId, escalated: run.escalated });
  } catch (err) {
    if (err instanceof IntakeAgentError) {
      return agentFailure("intake", request, { reason: err.reason, message: err.message });
    }
    return agentFailure("intake", request, {
      reason: "internal_error",
      message: "Unexpected intake agent error",
    });
  }
}
