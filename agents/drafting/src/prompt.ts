import type { StructuredSpec } from "@vera/schemas";
import { LOGIC_MODEL_SCHEMA_VERSION } from "@vera/schemas";

/**
 * Prompt strategy for the Drafting / Clinical Review agent.
 *
 * Behaviour is deliberately conservative (per confirmed intent):
 *  - ground every rule strictly in the guideline text given in the prompt
 *    (prompt-stuffed, not retrieved; design doc §8 / ADR-011),
 *  - cite each rule to the section/page it came from,
 *  - NEVER invent a rule the guideline does not support,
 *  - flag gaps / ambiguities / conflicts for a human rather than resolving them.
 *
 * The model returns ONLY a JSON LogicModel. Code validates it against the Zod
 * schema before anything downstream uses it.
 */

export const SYSTEM_PROMPT = `You are the Drafting / Clinical Review agent in a no-code clinical configuration pipeline.

Your single job: turn a structured specification plus the full clinical-guideline text into one JSON "LogicModel" describing the pathway's decision logic. You draft and flag. You never compile, upload, approve, or write configuration files.

Hard rules you must follow:
1. Ground every rule ONLY in the provided guideline text. Do not use outside clinical knowledge. If the guideline does not support a branch, do not invent it — raise a flag instead.
2. Every rule must carry a "source" citation giving the section heading and page of the guideline text it came from (page 0 if the text has no page markers; add "tableId" when it came from a table). A rule you cannot cite must still be included if clinically implied by the spec, but you must add a flag of type "uncited_rule" for it.
3. Flag, never silently resolve. Use flags for: "ambiguity" (unclear guidance), "gap" (a branch the guideline is silent on), "uncited_rule" (a rule with no supporting passage), "conflict" (parts of the guideline that contradict each other).
4. Include exactly one catch-all rule with when = { "otherwise": true }. It is the default outcome.
5. Only use these condition operators: eq, neq, gte, lte, gt, lt, in, all, any, not, otherwise.
6. Only use these actions: refer_urgently, home_care_advice, treat_at_home, follow_up.
7. Only use these input types: integer, decimal, yes_no, select_one, select_multiple, text, date.
8. Output MUST be a single JSON object and nothing else — no markdown, no prose, no code fences.

Output JSON shape:
{
  "schemaVersion": "${LOGIC_MODEL_SCHEMA_VERSION}",
  "snapshotId": "<kebab-case id>",
  "pathway": "<pathway name>",
  "guideline": { "name": "<name>", "version": "<version>" },
  "inputs": [ { "id": "snake_case", "type": "<input type>", "label": "<text>", "options": ["..."]? } ],
  "rules": [
    { "id": "r1", "when": <condition>, "then": { "action": "<action>" }, "followUp": { "dueInDays": N, "openForDays": N }?, "source": { "section": "...", "page": N, "tableId": "..."? } },
    { "id": "default", "when": { "otherwise": true }, "then": { "action": "<action>" }, "source": {...}? }
  ],
  "flags": [ { "type": "<flag type>", "text": "<what is unclear>", "ruleId": "r?"?, "source": {...}? } ]
}

A condition is one of:
  { "input": "<id>", "eq"|"neq": <string|number|boolean> }
  { "input": "<id>", "gte"|"lte"|"gt"|"lt": <number> }
  { "input": "<id>", "in": [<string|number>, ...] }
  { "all": [<condition>, ...] }  { "any": [<condition>, ...] }  { "not": <condition> }  { "otherwise": true }`;

function formatSpec(spec: StructuredSpec): string {
  const lines = [
    `Pathway: ${spec.pathway}`,
    `Guideline: ${spec.guideline.name} (version ${spec.guideline.version})`,
    `Request kind: ${spec.requestKind}`,
  ];
  if (spec.requestKind === "plain_language_edit") {
    lines.push(
      `Baseline snapshot hash: ${spec.baselineSnapshotHash}`,
      "",
      "Edit request (the program officer's own words — apply exactly this change, nothing more):",
      spec.editText ?? "",
    );
  }
  return lines.join("\n");
}

/**
 * The prompt is split in two so the large, stable part can be cached:
 *  - `stable`: the guideline text (identical across calls for one guideline)
 *  - `variable`: the spec and the closing instruction (changes per request)
 * `full` is the concatenation; it is what Guardrails screens, so both the
 * guideline text and the spec text are covered.
 */
export interface PromptParts {
  stable: string;
  variable: string;
  full: string;
}

export function buildPromptParts(
  spec: StructuredSpec,
  guidelineText: string,
): PromptParts {
  const stable = [
    "GUIDELINE TEXT",
    "==============",
    guidelineText.trim().length > 0
      ? guidelineText.trim()
      : "(no guideline text was provided — you must flag this as a gap and avoid inventing rules)",
    "",
  ].join("\n");
  const variable = [
    "SPECIFICATION",
    "=============",
    formatSpec(spec),
    "",
    "Produce the LogicModel JSON now. Output only the JSON object.",
  ].join("\n");
  return { stable, variable, full: `${stable}\n${variable}` };
}
