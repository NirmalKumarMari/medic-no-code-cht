// Runs every golden case through a logic model and reports pass/fail.
// This is the "golden case check" that runs before the clinician approves.
//
// Usage:
//   node check-golden-cases.mjs path/to/logic-model.json
//   node check-golden-cases.mjs            # defaults to the reference model
//
// Exit code 0 = all pass, 1 = at least one failure (so it can gate a pipeline).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../sample-patients/evaluate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const modelPath = process.argv[2] ?? join(here, '../sample-patients/reference-logic-model.json');
const model = JSON.parse(readFileSync(modelPath, 'utf8'));
const golden = JSON.parse(readFileSync(join(here, 'golden-cases.json'), 'utf8'));

let failed = 0;
for (const c of golden.cases) {
  let got;
  try {
    got = evaluate(model, c.inputs).action;
  } catch (err) {
    got = `ERROR: ${err.message}`;
  }
  const ok = got === c.expected.action;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}${ok ? '' : `\n      expected ${c.expected.action}, got ${got}\n      ${c.why}`}`);
}
console.log(`\n${golden.cases.length - failed}/${golden.cases.length} golden cases pass (${golden.goldenCaseVersion}, model ${model.snapshotId})`);
process.exit(failed ? 1 : 0);
