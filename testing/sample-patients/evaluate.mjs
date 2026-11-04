// Deterministic rule evaluator. Plain code, no AI (Medic design rule 6).
// Rules are checked top to bottom; the first rule that matches decides.
// Supports every operator in the team's locked schema (schemas/src/logic-model.ts).

function same(a, b) {
  const norm = (v) => (v === true ? 'yes' : v === false ? 'no' : String(v));
  return norm(a) === norm(b);
}

export function matches(cond, patient) {
  if ('otherwise' in cond) return true;
  if ('all' in cond) return cond.all.every((c) => matches(c, patient));
  if ('any' in cond) return cond.any.some((c) => matches(c, patient));
  if ('not' in cond) return !matches(cond.not, patient);
  const value = patient[cond.input];
  if (value === undefined) throw new Error(`Patient has no answer for "${cond.input}"`);
  if ('eq' in cond) return same(value, cond.eq);
  if ('neq' in cond) return !same(value, cond.neq);
  if ('in' in cond) return cond.in.some((v) => same(value, v));
  if (typeof value !== 'number') return false;
  if ('gt' in cond) return value > cond.gt;
  if ('gte' in cond) return value >= cond.gte;
  if ('lt' in cond) return value < cond.lt;
  if ('lte' in cond) return value <= cond.lte;
  throw new Error(`Unknown condition: ${JSON.stringify(cond)}`);
}

/** Returns { action, ruleId, followUp } for one patient. */
export function evaluate(model, patient) {
  for (const rule of model.rules) {
    if (matches(rule.when, patient)) {
      return { action: rule.then.action, ruleId: rule.id, followUp: rule.followUp ?? null };
    }
  }
  throw new Error('No rule matched. The model has no catch-all rule.');
}
