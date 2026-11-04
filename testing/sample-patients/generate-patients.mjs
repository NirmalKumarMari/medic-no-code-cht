// Generates synthetic (fake) patients from a logic model, with the expected answer
// for each one worked out from that same model. No AI, no real patient data.
//
// Usage:
//   node generate-patients.mjs                         # uses reference-logic-model.json
//   node generate-patients.mjs path/to/approved.json   # use the clinician-approved snapshot
//
// Why only "edge" values: a rule's answer can only change at the numbers the rules
// compare against. Testing each threshold and its neighbours (59/60/61 breaths,
// 35.4/35.5/37.5/37.6 °C, 23/24 hours) covers every distinct case without
// millions of patients.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './evaluate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const modelPath = process.argv[2] ?? join(here, 'reference-logic-model.json');
const model = JSON.parse(readFileSync(modelPath, 'utf8'));

// Collect every number each input is compared against.
const thresholds = {};
function collect(cond) {
  if ('all' in cond) return cond.all.forEach(collect);
  if ('any' in cond) return cond.any.forEach(collect);
  if ('not' in cond) return collect(cond.not);
  for (const op of ['gt', 'gte', 'lt', 'lte']) {
    if (op in cond) (thresholds[cond.input] ??= new Set()).add(cond[op]);
  }
}
model.rules.forEach((r) => collect(r.when));

function valuesFor(input) {
  if (input.type === 'yes_no') return ['yes', 'no'];
  if (input.type === 'select_one') return input.options ?? [];
  const step = input.type === 'decimal' ? 0.1 : 1;
  const round = (n) => Math.round(n * 10) / 10;
  const set = new Set();
  for (const t of thresholds[input.id] ?? []) {
    set.add(round(t - step)); set.add(round(t)); set.add(round(t + step));
  }
  if (set.size === 0) set.add(input.type === 'decimal' ? 36.8 : 1);
  return [...set].sort((a, b) => a - b);
}

const axes = model.inputs.map((i) => [i.id, valuesFor(i)]);
const MAX = 200_000;
const total = axes.reduce((n, [, v]) => n * v.length, 1);
if (total > MAX) throw new Error(`${total} patients is too many; simplify the model or raise MAX.`);

const patients = [];
(function build(idx, current) {
  if (idx === axes.length) {
    const result = evaluate(model, current);
    patients.push({
      id: `P${String(patients.length + 1).padStart(5, '0')}`,
      inputs: { ...current },
      expected: { action: result.action, followUp: result.followUp },
      decidedBy: result.ruleId,
    });
    return;
  }
  const [id, values] = axes[idx];
  for (const v of values) build(idx + 1, { ...current, [id]: v });
})(0, {});

const byAction = {};
const byRule = {};
for (const p of patients) {
  byAction[p.expected.action] = (byAction[p.expected.action] ?? 0) + 1;
  byRule[p.decidedBy] = (byRule[p.decidedBy] ?? 0) + 1;
}
const unused = model.rules.map((r) => r.id).filter((id) => !byRule[id]);

const out = {
  note: 'SYNTHETIC test patients. Not real people. Expected answers are computed from the logic model below, never by a model or a person.',
  generatedFrom: { snapshotId: model.snapshotId, file: modelPath.split('/').pop() },
  valuesTested: Object.fromEntries(axes),
  summary: { patients: patients.length, byAction, byRule, rulesNeverReached: unused },
  patients,
};
writeFileSync(join(here, 'patients.json'), JSON.stringify(out, null, 2) + '\n');

const cols = model.inputs.map((i) => i.id);
const csv = [['id', ...cols, 'expected_action', 'decided_by_rule'].join(',')]
  .concat(patients.map((p) => [p.id, ...cols.map((c) => p.inputs[c]), p.expected.action, p.decidedBy].join(',')))
  .join('\n');
writeFileSync(join(here, 'patients.csv'), csv + '\n');

console.log(`Wrote ${patients.length} patients from ${out.generatedFrom.file}`);
console.log('By answer:', byAction);
console.log('Every rule reached:', unused.length === 0 ? 'yes' : `NO, never reached: ${unused.join(', ')}`);
