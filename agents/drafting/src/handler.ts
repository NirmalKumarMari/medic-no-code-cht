import { z } from "zod";
import {
  agentFailure,
  agentSuccess,
  parseAgentRequest,
  StructuredSpecSchema,
  LogicModel as LogicModelSchema,
  type AgentFailureReason,
  type AgentResult,
  type LogicModel,
} from "@vera/schemas";
import { DraftingAgent, type DraftingResult } from "./index.js";

/**
 * Drafting payload. `spec` is Intake's output passed through unchanged.
 * `guidelineText` is the full guideline prepared by trusted code
 * (PromptContextBuilder in @vera/artifact-storage); the agent never fetches it.
 */
export const DraftingPayloadSchema = z
  .object({
    spec: StructuredSpecSchema,
    guidelineText: z.string().refine((s) => s.trim().length > 0, "guidelineText must not be empty"),
    /** Present only on a re-draft after a human rejected the previous draft. */
    revision: z
      .object({
        gate: z.enum(["content", "deploy"]),
        notes: z
          .string()
          // Same cap as workflow-data recordDecision, the system of record for notes.
          .max(8000)
          .refine((s) => s.trim().length > 0, "rejection notes must not be empty"),
        previousLogicModel: LogicModelSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type DraftingPayload = z.infer<typeof DraftingPayloadSchema>;

export type DraftingAgentResult = AgentResult<LogicModel>;

const FAILURE_REASON: Record<Extract<DraftingResult, { ok: false }>["reason"], AgentFailureReason> = {
  guardrail_blocked: "screening_blocked",
  schema_invalid: "output_invalid",
  no_json: "output_invalid",
  budget_exceeded: "output_invalid",
};

/**
 * One Drafting Agent_Run behind the shared envelope.
 *
 * Request:  { changeId, runId, tenant, payload: { spec, guidelineText } }
 * Result:   { agent: "drafting", ..., ok: true, output: LogicModel, model }
 *        or { agent: "drafting", ..., ok: false, failure }
 *
 * Never throws: every outcome, including an unexpected error, is an AgentResult.
 */
export async function handleDrafting(
  body: unknown,
  agent: DraftingAgent,
  modelId: string,
): Promise<DraftingAgentResult> {
  const parsed = parseAgentRequest("drafting", body, DraftingPayloadSchema);
  if (!parsed.ok) return parsed.result;
  const { request } = parsed;
  const { spec, guidelineText, revision } = request.payload;

  if (spec.changeId !== request.changeId) {
    return agentFailure("drafting", request, {
      reason: "invalid_request",
      message: "payload.spec.changeId does not match the request changeId",
      details: [{ path: "payload.spec.changeId", message: "must equal changeId" }],
    });
  }
  // Edits go to the Change Planner against a base snapshot (design §6/§7),
  // never to a fresh re-draft from the guideline.
  if (spec.requestKind === "plain_language_edit") {
    return agentFailure("drafting", request, {
      reason: "invalid_request",
      message: "plain_language_edit requests are handled by the Change Planner, not the Drafting Agent",
      details: [{ path: "payload.spec.requestKind", message: "must be guideline_upload or pathway_pick" }],
    });
  }

  let result: DraftingResult;
  try {
    result = await agent.draft({ spec, guidelineText, ...(revision ? { revision } : {}) });
  } catch (err) {
    return agentFailure("drafting", request, {
      reason: "model_error",
      message: `Drafting model or screening call failed on ${modelId}: ${(err as Error).name ?? "Error"}`,
    });
  }

  if (!result.ok) {
    return agentFailure("drafting", request, {
      reason: FAILURE_REASON[result.reason],
      message: result.reason === "guardrail_blocked" ? result.detail : `Drafting failed: ${result.reason}`,
      // Validation detail only; the raw model output stays out of the envelope.
      details: result.reason === "schema_invalid" ? result.detail : undefined,
    });
  }

  // The Drafting Agent has no escalation of its own yet, so its output always comes from `modelId`.
  return agentSuccess("drafting", request, result.logicModel, { modelId, escalated: false });
}
