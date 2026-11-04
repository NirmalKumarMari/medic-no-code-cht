import { createHash } from "node:crypto";
import type { LogicModel, Rule, Condition } from "./logic-model.js";

/**
 * Deterministic rule fingerprinting.
 *
 * A fingerprint is the canonical MEANING of a rule — its condition, action and
 * follow-up — independent of its `id`, its `source` citation, or object key
 * order. Two rules with the same clinical effect produce the same fingerprint.
 *
 * This is the key the History Check agent matches against the DynamoDB decision
 * log (exact-match path, §9). It is pure deterministic code — never a model —
 * so an exact match is an exact match, not a judgement call.
 */

/** Canonicalize a condition into a stable, order-independent form. */
function canonicalCondition(cond: Condition): unknown {
  if ("all" in cond) {
    return { all: cond.all.map(canonicalCondition).sort(stableCompare) };
  }
  if ("any" in cond) {
    return { any: cond.any.map(canonicalCondition).sort(stableCompare) };
  }
  if ("not" in cond) {
    return { not: canonicalCondition(cond.not) };
  }
  if ("otherwise" in cond) {
    return { otherwise: true };
  }
  // Leaf comparison: exactly one operator key alongside `input`.
  const { input, ...rest } = cond as { input: string } & Record<string, unknown>;
  const [op, value] = Object.entries(rest)[0] ?? ["", null];
  const normValue = Array.isArray(value) ? [...value].sort(stableCompare) : value;
  return { input, op, value: normValue };
}

function stableCompare(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Canonical JSON for a single rule's meaning (no id, no citation). */
export function canonicalRule(rule: Rule): string {
  const canonical = {
    when: canonicalCondition(rule.when),
    then: { action: rule.then.action },
    followUp: rule.followUp
      ? { dueInDays: rule.followUp.dueInDays, openForDays: rule.followUp.openForDays }
      : null,
  };
  return JSON.stringify(canonical);
}

/** sha256 fingerprint of a single rule's meaning. */
export function fingerprintRule(rule: Rule): string {
  return createHash("sha256").update(canonicalRule(rule)).digest("hex");
}

/** Fingerprint every rule in a LogicModel, keyed by ruleId. */
export function fingerprintLogicModel(model: LogicModel): Array<{ ruleId: string; fingerprint: string }> {
  return model.rules.map((r) => ({ ruleId: r.id, fingerprint: fingerprintRule(r) }));
}
