import { z } from "zod";

/**
 * The one request/result envelope every agent speaks with the orchestrator
 * (authoring-agents Requirement 1.4/1.5). The envelope is generic: it carries
 * identity (changeId, runId, tenant) and success/failure. What the agent
 * actually produced sits in `output` and is typed per agent, e.g. Intake's
 * output is a StructuredSpec, so `requestKind` lives in `output`, not here.
 *
 * Transport rule: an agent answers every request it could parse as HTTP 200
 * with an AgentResult, including failures (`ok: false`). A non-2xx response
 * means the agent itself is broken or unreachable, which the orchestrator
 * treats as a separate error.
 */

/** Same identifier rule as packages/workflow-data `idSchema`, so ids round-trip into the tables. */
export const AgentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "invalid identifier");

export const AgentName = z.enum(["intake", "drafting", "change_planner"]);
export type AgentName = z.infer<typeof AgentName>;

export const AgentFailureReason = z.enum([
  /** The request envelope or payload was missing or malformed. No model call was made. */
  "invalid_request",
  /** Input screening found personal data or credentials, or could not complete. */
  "screening_blocked",
  /** The model never produced a schema-valid output within the repair/escalation bounds. */
  "output_invalid",
  /** A Bedrock invocation failed. */
  "model_error",
  /** A tool or storage call failed. */
  "tool_error",
  /** An unexpected error inside the agent. */
  "internal_error",
]);
export type AgentFailureReason = z.infer<typeof AgentFailureReason>;

export interface AgentFailure {
  reason: AgentFailureReason;
  /** Human-readable, safe to show an operator. Never contains model input content. */
  message: string;
  /** Structured detail, e.g. validation issues or missing field names. */
  details?: unknown;
}

export interface AgentModelInfo {
  /** Bedrock inference profile id that produced the output. */
  modelId: string;
  /** True when the output came from the escalation model. */
  escalated: boolean;
}

interface AgentResultBase {
  agent: AgentName;
  /** Echoed from the request. Null only when the request did not carry a valid value. */
  changeId: string | null;
  runId: string | null;
  tenant: string | null;
}

export type AgentResult<O> =
  | (AgentResultBase & { ok: true; output: O; model?: AgentModelInfo })
  | (AgentResultBase & { ok: false; failure: AgentFailure });

export interface AgentRequest<P> {
  changeId: string;
  runId: string;
  tenant: string;
  payload: P;
}

const EnvelopeSchema = z.object({
  changeId: AgentIdSchema,
  runId: AgentIdSchema,
  tenant: AgentIdSchema,
  payload: z.unknown().refine((p) => p !== undefined && p !== null, "payload is required"),
});

function pickId(body: unknown, key: "changeId" | "runId" | "tenant"): string | null {
  if (typeof body !== "object" || body === null) return null;
  const parsed = AgentIdSchema.safeParse((body as Record<string, unknown>)[key]);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse an incoming request. On failure returns a ready-to-send `invalid_request`
 * AgentResult that names every bad field and echoes whichever ids were valid
 * (authoring-agents Req 1.5), so the caller makes no model or tool call.
 */
export function parseAgentRequest<P>(
  agent: AgentName,
  body: unknown,
  payloadSchema: z.ZodType<P>,
): { ok: true; request: AgentRequest<P> } | { ok: false; result: AgentResult<never> } {
  const envelope = EnvelopeSchema.safeParse(body);
  const payload = envelope.success
    ? payloadSchema.safeParse(envelope.data.payload)
    : undefined;

  if (envelope.success && payload?.success) {
    return {
      ok: true,
      request: { ...envelope.data, payload: payload.data },
    };
  }

  const issues = [
    ...(envelope.success ? [] : envelope.error.issues),
    ...(payload && !payload.success
      ? payload.error.issues.map((i) => ({ ...i, path: ["payload", ...i.path] }))
      : []),
  ].map((i) => ({ path: i.path.join("."), message: i.message }));

  return {
    ok: false,
    result: agentFailure(
      agent,
      { changeId: pickId(body, "changeId"), runId: pickId(body, "runId"), tenant: pickId(body, "tenant") },
      {
        reason: "invalid_request",
        message: `Invalid ${agent} request: ${issues.map((i) => i.path || "(root)").join(", ")}`,
        details: issues,
      },
    ),
  };
}

type Ids = Pick<AgentResultBase, "changeId" | "runId" | "tenant">;

export function agentSuccess<O>(
  agent: AgentName,
  request: AgentRequest<unknown>,
  output: O,
  model?: AgentModelInfo,
): AgentResult<O> {
  return {
    agent,
    changeId: request.changeId,
    runId: request.runId,
    tenant: request.tenant,
    ok: true,
    output,
    ...(model ? { model } : {}),
  };
}

export function agentFailure(agent: AgentName, ids: Ids, failure: AgentFailure): AgentResult<never> {
  return { agent, changeId: ids.changeId, runId: ids.runId, tenant: ids.tenant, ok: false, failure };
}
