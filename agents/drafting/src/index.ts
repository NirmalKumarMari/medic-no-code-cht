import {
  LogicModel,
  parseLogicModel,
  type StructuredSpec,
} from "@vera/schemas";
import type { ModelClient } from "./model.js";
import { buildPromptParts, SYSTEM_PROMPT, type GuidelineRef } from "./prompt.js";
import { NoopGuardrail, type Guardrail, type GuardrailDecision } from "./guardrail.js";

export { BedrockModelClient, DEFAULT_MODEL_IDS } from "./model.js";
export type { ModelClient, ModelTier } from "./model.js";
export type { GuidelineRef } from "./prompt.js";
export {
  BedrockGuardrail,
  NoopGuardrail,
  type Guardrail,
  type GuardrailDecision,
} from "./guardrail.js";

/**
 * Bounded-autonomy limits for one drafting attempt (solution design §7).
 * The agent has no tools (the guideline is prompt-stuffed, not retrieved) and
 * makes exactly one model call per attempt.
 */
export const AGENT_LIMITS = {
  maxModelTurns: 1,
} as const;

export interface DraftingInput {
  spec: StructuredSpec;
  /**
   * Full text of the guideline for this pathway, placed directly in the prompt
   * (design doc §8 / ADR-011). Callers supply it; there is no retrieval step.
   */
  guidelineText: string;
  /**
   * Guideline name + version for the LogicModel. Optional for `new_pathway`
   * specs (taken from `spec.guideline`: title -> name). REQUIRED for `edit`
   * specs, which only carry a baseline snapshot reference, not the guideline.
   */
  guideline?: GuidelineRef;
}

export interface AgentUsage {
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
      reason: "invalid_input" | "schema_invalid" | "no_json" | "budget_exceeded" | "guardrail_blocked";
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
    options: DraftingAgentOptions = {},
  ) {
    // Default to Noop so local/test wiring is ergonomic, but a real run is
    // expected to inject a BedrockGuardrail explicitly.
    this.guardrail = options.guardrail ?? new NoopGuardrail();
  }

  async draft(input: DraftingInput): Promise<DraftingResult> {
    let modelTurns = 0;

    const guideline: GuidelineRef | undefined =
      input.guideline ??
      (input.spec.changeType === "new_pathway"
        ? { name: input.spec.guideline.title, version: input.spec.guideline.version }
        : undefined);
    if (!guideline) {
      return {
        ok: false,
        reason: "invalid_input",
        detail:
          "An edit spec carries no guideline name/version; the caller must pass `guideline` " +
          "(from the baseline snapshot). This is a caller bug, not something for the model to guess.",
        usage: { modelTurns },
      };
    }

    const prompt = buildPromptParts(input.spec, guideline, input.guidelineText);

    // ---- Guardrail screening (BEFORE the model sees anything) ----
    // Both entry points for personal data — the synthesized spec text and the
    // guideline text — are inside the full prompt, so screening it covers both. Fail closed: if the guardrail intervenes, the model is never called.
    const decision = await this.guardrail.screenInput(prompt.full);
    if (decision.intervened) {
      return {
        ok: false,
        reason: "guardrail_blocked",
        detail:
          "Input blocked by Bedrock Guardrails before drafting: " +
          (decision.reasons.length > 0 ? decision.reasons.join(", ") : "policy intervention"),
        guardrail: decision,
        usage: { modelTurns },
      };
    }

    // ---- One model turn ----
    if (modelTurns >= AGENT_LIMITS.maxModelTurns) {
      return {
        ok: false,
        reason: "budget_exceeded",
        detail: "Model-turn budget exhausted before drafting.",
        usage: { modelTurns },
      };
    }
    modelTurns += 1;
    const response = await this.model.invoke({
      system: SYSTEM_PROMPT,
      cachedContext: prompt.stable,
      user: prompt.variable,
    });

    const usage = {
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
