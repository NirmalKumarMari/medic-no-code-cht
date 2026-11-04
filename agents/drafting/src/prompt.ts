import type { StructuredSpec } from "@vera/schemas";
import { LOGIC_MODEL_SCHEMA_VERSION } from "@vera/schemas";
import type { RetrievedChunk } from "@vera/retrieval";

/**
 * Prompt strategy for the Drafting / Clinical Review agent.
 *
 * Behaviour is deliberately conservative (per confirmed intent):
 *  - ground every rule strictly in the retrieved guideline chunks,
 *  - cite each rule to the chunk it came from,
 *  - NEVER invent a rule the guideline does not support,
 *  - flag gaps / ambiguities / conflicts for a human rather than resolving them.
 *
 * The model returns ONLY a JSON LogicModel. Code validates it against the Zod
 * schema before anything downstream uses it.
 */

export const SYSTEM_PROMPT = `You are the Drafting / Clinical Review agent in a no-code clinical configuration pipeline.

Your single job: turn a structured specification plus retrieved clinical-guideline passages into one JSON "LogicModel" describing the pathway's decision logic. You draft and flag. You never compile, upload, approve, or write configuration files.

Hard rules you must follow:
1. Ground every rule ONLY in the provided guideline passages. Do not use outside clinical knowledge. If the passages do not support a branch, do not invent it — raise a flag instead.
2. Every rule must carry a "source" citation copied from the passage it came from, including the passage's chunkId. A rule you cannot cite must still be included if clinically implied by the spec, but you must add a flag of type "uncited_rule" for it.
3. Flag, never silently resolve. Use flags for: "ambiguity" (unclear guidance), "gap" (a branch the guideline is silent on), "uncited_rule" (a rule with no supporting passage), "conflict" (passages that contradict each other).
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
    { "id": "r1", "when": <condition>, "then": { "action": "<action>" }, "followUp": { "dueInDays": N, "openForDays": N }?, "source": { "section": "...", "page": N, "tableId": "..."?, "chunkId": "..." } },
    { "id": "default", "when": { "otherwise": true }, "then": { "action": "<action>" }, "source": {...}? }
  ],
  "flags": [ { "type": "<flag type>", "text": "<what is unclear>", "ruleId": "r?"?, "source": {...}? } ]
}

A condition is one of:
  { "input": "<id>", "eq"|"neq": <string|number|boolean> }
  { "input": "<id>", "gte"|"lte"|"gt"|"lt": <number> }
  { "input": "<id>", "in": [<string|number>, ...] }
  { "all": [<condition>, ...] }  { "any": [<condition>, ...] }  { "not": <condition> }  { "otherwise": true }`;

function formatChunks(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "(no guideline passages were retrieved — you must flag this as a gap and avoid inventing rules)";
  }
  return chunks
    .map(
      (c) =>
        `- chunkId: ${c.chunkId}\n  section: ${c.citation.section}` +
        (c.citation.tableId ? ` (table ${c.citation.tableId})` : "") +
        `, page: ${c.citation.page}\n  text: ${c.text}`,
    )
    .join("\n");
}

function formatSpec(spec: StructuredSpec): string {
  const reqs =
    spec.requirements.length > 0
      ? spec.requirements.map((r) => `- (${r.id}) ${r.text}`).join("\n")
      : "(none provided)";
  const inputs =
    spec.candidateInputs.length > 0
      ? spec.candidateInputs
          .map((i) => `- ${i.id}: ${i.label}${i.type ? ` [${i.type}]` : ""}`)
          .join("\n")
      : "(none provided)";
  const open =
    spec.openQuestions.length > 0
      ? spec.openQuestions.map((q) => `- ${q}`).join("\n")
      : "(none)";

  return [
    `Pathway: ${spec.pathway}`,
    `Guideline: ${spec.guideline.name} (version ${spec.guideline.version})`,
    `Request type: ${spec.requestType}`,
    ``,
    `Requirements:`,
    reqs,
    ``,
    `Candidate inputs:`,
    inputs,
    ``,
    `Open questions from intake (carry forward as flags where still unresolved):`,
    open,
  ].join("\n");
}

export function buildUserPrompt(spec: StructuredSpec, chunks: RetrievedChunk[]): string {
  return [
    "SPECIFICATION",
    "=============",
    formatSpec(spec),
    "",
    "RETRIEVED GUIDELINE PASSAGES",
    "============================",
    formatChunks(chunks),
    "",
    "Produce the LogicModel JSON now. Output only the JSON object.",
  ].join("\n");
}
