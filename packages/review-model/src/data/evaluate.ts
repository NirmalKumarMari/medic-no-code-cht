// Deterministic evaluation of the logic. Plain code, no AI.
//
// buildPatientGrid makes one test patient for every combination of meaningful
// answers. Conditions only compare against fixed values, so a rule's result can
// only change at those values: testing each value and its neighbours covers
// every distinct case, and the checks can give exact answers rather than samples.

import type { LogicInput, LogicModel } from '../types/logic-model.js';
import { isNumberType, parseExpr } from '../types/logic-model.js';

export type Patient = Record<string, string | number>;

const INTEGER_STEP = 1;
const DECIMAL_STEP = 0.001;
const MAX_PATIENTS = 100_000;
const OTHER_TEXT = '(some other answer)';

/** yes_no may arrive as a boolean from the agents' schema. */
function normaliseEq(value: string | number | boolean): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return String(value);
}

export function matches(expr: unknown, patient: Patient): boolean {
  const parsed = parseExpr(expr);
  switch (parsed.kind) {
    case 'all':
      return parsed.items.every((item) => matches(item, patient));
    case 'any':
      return parsed.items.some((item) => matches(item, patient));
    case 'not':
      return !matches(parsed.item, patient);
    case 'otherwise':
      return true;
    case 'leaf': {
      const answer = patient[parsed.input];
      if (answer === undefined) return false;
      const { op, value } = parsed;
      if (op === 'in') return (value as (string | number)[]).map(normaliseEq).includes(normaliseEq(answer));
      if (op === 'eq') return normaliseEq(answer) === normaliseEq(value as string | number | boolean);
      if (op === 'neq') return normaliseEq(answer) !== normaliseEq(value as string | number | boolean);
      if (typeof answer !== 'number') return false;
      const limit = value as number;
      if (op === 'gte') return answer >= limit;
      if (op === 'gt') return answer > limit;
      if (op === 'lte') return answer <= limit;
      return answer < limit;
    }
    case 'invalid':
      return false;
  }
}

interface Leaf {
  input: string;
  value: string | number | boolean;
}

function collectLeaves(expr: unknown, leaves: Leaf[] = []): Leaf[] {
  const parsed = parseExpr(expr);
  if (parsed.kind === 'all' || parsed.kind === 'any') parsed.items.forEach((item) => collectLeaves(item, leaves));
  if (parsed.kind === 'not') collectLeaves(parsed.item, leaves);
  if (parsed.kind === 'leaf') {
    const values = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    values.forEach((value) => leaves.push({ input: parsed.input, value }));
  }
  return leaves;
}

/** The ids of the questions at least one rule reads. */
export function usedInputIds(model: LogicModel): Set<string> {
  return new Set(model.rules.flatMap((rule) => collectLeaves(rule.when).map((leaf) => leaf.input)));
}

function valuesFor(input: LogicInput, leaves: Leaf[]): (string | number)[] {
  const compared = leaves.filter((leaf) => leaf.input === input.id).map((leaf) => leaf.value);
  if (isNumberType(input.type)) {
    const step = input.type === 'integer' ? INTEGER_STEP : DECIMAL_STEP;
    const values = compared.map(Number).flatMap((n) => [n - step, n, n + step]);
    // Readings such as age and breaths per minute cannot be negative.
    return [...new Set(values)].filter((n) => n >= 0).sort((a, b) => a - b);
  }
  if (input.type === 'yes_no') return ['yes', 'no'];
  const answers = compared.map(normaliseEq);
  if (input.type === 'select_one') return [...new Set([...(input.choices ?? []), ...answers])];
  return [...new Set([...answers, OTHER_TEXT])];
}

export interface PatientGrid {
  patients: Patient[];
  /** True if there were too many combinations to build, so nothing was checked. */
  tooLarge: boolean;
}

export function buildPatientGrid(model: LogicModel): PatientGrid {
  const leaves = model.rules.flatMap((rule) => collectLeaves(rule.when));
  const used = model.inputs.filter((input) => leaves.some((leaf) => leaf.input === input.id));
  const axes = used.map((input) => ({ id: input.id, values: valuesFor(input, leaves) }));

  const size = axes.reduce((total, axis) => total * axis.values.length, 1);
  if (size > MAX_PATIENTS) return { patients: [], tooLarge: true };

  let patients: Patient[] = [{}];
  for (const axis of axes) {
    patients = patients.flatMap((patient) => axis.values.map((value) => ({ ...patient, [axis.id]: value })));
  }
  return { patients, tooLarge: false };
}
