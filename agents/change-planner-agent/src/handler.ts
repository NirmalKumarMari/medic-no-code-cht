import { z, ZodError } from "zod";
import {
  agentFailure,
  agentSuccess,
  parseAgentRequest,
  StructuredSpecSchema,
  type AgentFailureReason,
  type AgentResult,
} from "@vera/schemas";
import { ChangePlannerAgentError, type PlannerRevision } from "./agent.js";
import type { ChangePlan } from "./schema.js";

/**
 * Change Planner payload. `spec` is Intake's output passed through unchanged.
 * `revision` is present only on a re-plan after a human rejection.
 */
export const ChangePlanPayloadSchema = z
  .object({
    spec: StructuredSpecSchema,
    revision: z
      .object({
        gate: z.enum(["content", "deploy"]),
        // Same cap as workflow-data recordDecision, the system of record for notes.
        notes: z
          .string()
          .max(8000)
          .refine((s) => s.trim().length > 0, "rejection notes must not be empty"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ChangePlanPayload = z.infer<typeof ChangePlanPayloadSchema>;

export type ChangePlannerResult = AgentResult<ChangePlan>;

/** Runs one planner Agent_Run for an already-validated payload. Throws on failure. */
export type RunPlanner = (spec: ChangePlanPayload["spec"], revision?: PlannerRevision) => Promise<ChangePlan>;

/** ChangePlannerAgentError codes onto the shared failure reasons. Unknown codes are internal errors. */
const REASON_BY_CODE: Record<string, AgentFailureReason> = {
  INVALID_REQUEST: "invalid_request",
  SCREENING_BLOCKED: "screening_blocked",
  GUARDRAIL_BLOCKED: "screening_blocked",
  INVALID_MODEL_OUTPUT: "output_invalid",
  MODEL_STOP: "output_invalid",
  // The baseline/primer/guideline the Gateway returned is stale or does not match its pins.
  STALE_BASELINE: "tool_error",
  INVALID_BASELINE: "tool_error",
  PRIMER_NOT_PINNED: "tool_error",
  INVALID_GROUNDING: "tool_error",
  CONFIGURATION: "internal_error",
};

/**
 * One Change Planner Agent_Run behind the shared envelope.
 *
 * Request:  { changeId, runId, tenant, payload: { spec, revision? } }
 * Result:   { agent: "change_planner", ..., ok: true, output: ChangePlan, model }
 *        or { agent: "change_planner", ..., ok: false, failure }
 *
 * Never throws: every outcome, including an unexpected error, is an AgentResult.
 * Error messages are the planner's own fixed strings, never model or Gateway content.
 */
export async function handleChangePlan(body: unknown, run: RunPlanner): Promise<ChangePlannerResult> {
  const parsed = parseAgentRequest("change_planner", body, ChangePlanPayloadSchema);
  if (!parsed.ok) return parsed.result;
  const { request } = parsed;
  const { spec, revision } = request.payload;

  if (spec.changeId !== request.changeId) {
    return agentFailure("change_planner", request, {
      reason: "invalid_request",
      message: "payload.spec.changeId does not match the request changeId",
      details: [{ path: "payload.spec.changeId", message: "must equal changeId" }],
    });
  }
  // Checked here too (the planner checks again) so a wrong route never reaches a tool or model.
  if (spec.requestKind !== "plain_language_edit") {
    return agentFailure("change_planner", request, {
      reason: "invalid_request",
      message: `The Change Planner only handles plain_language_edit, got ${spec.requestKind}`,
      details: [{ path: "payload.spec.requestKind", message: "must be plain_language_edit" }],
    });
  }

  try {
    const plan = await run(spec, revision);
    return agentSuccess("change_planner", request, plan, {
      modelId: plan.execution.modelId,
      escalated: plan.execution.escalated,
    });
  } catch (err) {
    if (err instanceof ChangePlannerAgentError) {
      return agentFailure("change_planner", request, {
        reason: REASON_BY_CODE[err.code] ?? "internal_error",
        message: err.message,
        details: { code: err.code },
      });
    }
    if (err instanceof ZodError) {
      // The request was validated above, so a schema error here came from a Gateway reply.
      return agentFailure("change_planner", request, {
        reason: "tool_error",
        message: "A Gateway tool returned data that does not match its contract",
      });
    }
    return agentFailure("change_planner", request, {
      reason: "internal_error",
      message: "Change planner failed (Gateway, Bedrock or runtime error)",
    });
  }
}
