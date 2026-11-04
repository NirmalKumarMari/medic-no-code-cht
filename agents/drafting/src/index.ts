import {
  LogicModel,
  parseLogicModel,
  type StructuredSpec,
} from "@vera/schemas";
import type { Retriever, RetrievedChunk } from "@vera/retrieval";
import type { ModelClient } from "./model.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { NoopGuardrail, type Guardrail, type GuardrailDecision } from "./guardrail.js";

export { BedrockModelClient, DEFAULT_MODEL_IDS } from "./model.js";
export type { ModelClient, ModelTier } from "./model.js";
export {
  BedrockGuardrail,
  NoopGuardrail,
  type Guardrail,
  type GuardrailDecision,
} from "./guardrail.js";

/** Bounded-autonomy limits for one drafting attempt (solution design §7). */
export const AGENT_LIMITS = {
  maxToolCalls: 4,
  maxModelTurns: 2,
} as const;

export interface DraftingInput {
  spec: StructuredSpec;
  /** Search queries to issue against the guideline KB (one tool call each). */
  queries?: string[];
}

export interface AgentUsage {
  toolCalls: number;
  modelTurns: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type DraftingResult =
  | {
      ok: true;
      logicModel: LogicModel;
      usage: AgentUsage;
    }
  | {
      ok: false;
      /** Reason the attempt failed — surfaced to a human / the repair loop. */
      reason: "schema_invalid" | "no_json" | "budget_exceeded" | "guardrail_blocked";
      /** Human/loop-readable detail. For schema_invalid this is Zod's flattened errors. */
      detail: string;
      rawOutput?: string;
      /** Set when reason is guardrail_blocked. */
      guardrail?: GuardrailDecision;
      usage: AgentUsage;
    };

/**
 * The Drafting / Clinical Review agent. Single attempt by design: on schema
 * failure it returns a structured error and the orchestrator (Step Functions)
 * decides whether to retry, escalate the model tier, or fail to a human. The
 * agent never loops the model on its own.
 */
export interface DraftingAgentOptions {
  /**
   * Guardrail to screen the drafting input before the model call (design rule
   * 8). Omit only for explicitly offline/local runs by passing a NoopGuardrail;
   * production runs must pass a real BedrockGuardrail.
   */
  guardrail?: Guardrail;
}

export class DraftingAgent {
  private readonly guardrail: Guardrail;

  constructor(
    private readonly model: ModelClient,
    private readonly retriever: Retriever,
    options: DraftingAgentOptions = {},
  ) {
    // Default to Noop so local/test wiring is ergonomic, but a real run is
    // expected to inject a BedrockGuardrail explicitly.
    this.guardrail = options.guardrail ?? new NoopGuardrail();
  }

  async draft(input: DraftingInput): Promise<DraftingResult> {
    let toolCalls = 0;
    let modelTurns = 0;

    const queries =
      input.queries && input.queries.length > 0
        ? input.queries
        : defaultQueries(input.spec);

    // ---- Retrieval (each search is one tool call, budget-capped) ----
    const chunks: RetrievedChunk[] = [];
    const seen = new Set<string>();
    for (const query of queries) {
      if (toolCalls >= AGENT_LIMITS.maxToolCalls) break;
      toolCalls += 1;
      const results = await this.retriever.search({
        source: "guideline",
        query,
        maxResults: 5,
      });
      for (const c of results) {
        if (!seen.has(c.chunkId)) {
          seen.add(c.chunkId);
          chunks.push(c);
        }
      }
    }

    const userPrompt = buildUserPrompt(input.spec, chunks);

    // ---- Guardrail screening (BEFORE the model sees anything) ----
    // Both entry points for personal data — the synthesized spec text and the
    // retrieved guideline text — are inside userPrompt, so screening it covers
    // both. Fail closed: if the guardrail intervenes, the model is never called.
    const decision = await this.guardrail.screenInput(userPrompt);
    if (decision.intervened) {
      return {
        ok: false,
        reason: "guardrail_blocked",
        detail:
          "Input blocked by Bedrock Guardrails before drafting: " +
          (decision.reasons.length > 0 ? decision.reasons.join(", ") : "policy intervention"),
        guardrail: decision,
        usage: { toolCalls, modelTurns },
      };
    }

    // ---- One model turn ----
    if (modelTurns >= AGENT_LIMITS.maxModelTurns) {
      return {
        ok: false,
        reason: "budget_exceeded",
        detail: "Model-turn budget exhausted before drafting.",
        usage: { toolCalls, modelTurns },
      };
    }
    modelTurns += 1;
    const response = await this.model.invoke({
      system: SYSTEM_PROMPT,
      user: userPrompt,
    });

    const usage = {
      toolCalls,
      modelTurns,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };

    // ---- Extract + validate ----
    const json = extractJson(response.text);
    if (json === null) {
      return {
        ok: false,
        reason: "no_json",
        detail: "Model output did not contain a parseable JSON object.",
        rawOutput: response.text,
        usage,
      };
    }

    const parsed = parseLogicModel(json);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "schema_invalid",
        detail: JSON.stringify(parsed.error.flatten(), null, 2),
        rawOutput: response.text,
        usage,
      };
    }

    return { ok: true, logicModel: parsed.data, usage };
  }
}

/** Default KB queries derived from the spec when the caller gives none. */
function defaultQueries(spec: StructuredSpec): string[] {
  const base = [`${spec.pathway} danger signs referral`, `${spec.pathway} classification treatment follow-up`];
  const fromReqs = spec.requirements.slice(0, 2).map((r) => r.text);
  return [...base, ...fromReqs];
}

/**
 * Pull a JSON object out of model text. Prefers a fenced ```json block, falls
 * back to the first balanced {...} span. Returns null if none parses.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();

  // Direct parse (we instruct the model to emit bare JSON).
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // Fenced code block.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const inner = tryParse(fence[1].trim());
    if (inner !== undefined) return inner;
  }

  // First balanced object.
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          const parsed = tryParse(candidate);
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }

  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
