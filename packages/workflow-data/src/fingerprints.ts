import { canonicalJson, idSchema, requireData, sha256, type Json } from './model.js';
export interface RuleFingerprint { ruleId: string; fingerprint: string }
export interface HistoryFlag {
  id: string; type: 'previously_rejected_rule'; severity: 'high'; advisory: true;
  ruleId: string; fingerprint: string; sourceChangeId: string; decisionId: string;
  rejectedSnapshotHash: string; rejectedSnapshotId: string; notesExcerpt: string; createdAt: string;
}
function normalize(value: Json): Json {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const normalized = normalize(child);
    // The order of conjuncts/disjuncts carries no meaning. Other arrays retain order.
    return [key, ['all', 'any'].includes(key) && Array.isArray(normalized)
      ? normalized.slice().sort((a, b) => { const x = canonicalJson(a), y = canonicalJson(b); return x < y ? -1 : x > y ? 1 : 0; }) : normalized];
  }));
}
/** Versioned exact structural match. No semantic similarity, inferred equivalence or LLM. */
export function fingerprintRules(spec: Record<string, Json>): RuleFingerprint[] {
  if (spec.rules === undefined) return []; // Intake/wording drafts may not yet contain clinical rules.
  requireData(Array.isArray(spec.rules) && spec.rules.length <= 80, 'INVALID_RULES', 'At most 80 explicit rules per snapshot fit the atomic rejection transaction');
  const ids = new Set<string>();
  return spec.rules.map(rule => {
    requireData(rule && typeof rule === 'object' && !Array.isArray(rule) && 'when' in rule && 'then' in rule, 'INVALID_RULES', 'A rule requires structural when and then fields');
    const ruleId = idSchema.parse(rule.id); requireData(!ids.has(ruleId), 'INVALID_RULES', 'Rule IDs must be unique'); ids.add(ruleId);
    const structural = { version: 'rule-v1', when: normalize(rule.when!), then: rule.then!,
      ...(rule.followUp === undefined ? {} : { followUp: rule.followUp }) };
    return { ruleId, fingerprint: sha256(canonicalJson(structural)) };
  });
}
