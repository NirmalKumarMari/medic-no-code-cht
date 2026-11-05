// Finds anything in a logic model the approver's screen cannot show faithfully.
// A person must never approve logic they could not see (design rule 5), so each
// problem found here blocks approval.

import type { LogicInput, LogicModel } from '../types/logic-model.js';
import { actionLabel, isNumberType, parseExpr } from '../types/logic-model.js';

function auditExpr(expr: unknown, name: string, inputs: Map<string, LogicInput>, top: boolean, problems: string[]) {
  const parsed = parseExpr(expr);
  switch (parsed.kind) {
    case 'invalid':
      problems.push(`${name} has a condition this screen cannot read.`);
      return;
    case 'otherwise':
      if (!top) problems.push(`${name} has an "otherwise" inside another condition.`);
      return;
    case 'all':
    case 'any':
      if (parsed.items.length === 0) problems.push(`${name} has an empty group of conditions.`);
      parsed.items.forEach((item) => auditExpr(item, name, inputs, false, problems));
      return;
    case 'not':
      auditExpr(parsed.item, name, inputs, false, problems);
      return;
    case 'leaf': {
      const input = inputs.get(parsed.input);
      if (!input) {
        problems.push(`${name} reads a question that does not exist ("${parsed.input}").`);
        return;
      }
      const { op, value } = parsed;
      const values = Array.isArray(value) ? value : [value];
      const label = `"${input.label}"`;
      if (isNumberType(input.type)) {
        const bad = values.find((v) => typeof v !== 'number');
        if (bad !== undefined) problems.push(`${name} compares the number question ${label} to "${bad}".`);
      } else if (op === 'gte' || op === 'gt' || op === 'lte' || op === 'lt') {
        problems.push(`${name} uses a number comparison on ${label}, which is not a number question.`);
      } else if (input.type === 'yes_no') {
        const bad = values.find((v) => !['yes', 'no', true, false].includes(v as string | boolean));
        if (bad !== undefined) problems.push(`${name} expects "${bad}" from the yes or no question ${label}.`);
      } else if (input.type === 'select_one') {
        const bad = values.find((v) => !input.choices?.includes(String(v)));
        if (bad !== undefined) problems.push(`${name} expects "${bad}", which is not one of the choices for ${label}.`);
      } else if (input.type !== 'text') {
        problems.push(`${name} reads ${label}, whose answer type this screen cannot show ("${input.type}").`);
      }
    }
  }
}

export function findDisplayProblems(model: LogicModel): string[] {
  if (!Array.isArray(model.inputs) || !Array.isArray(model.rules)) {
    return ['This version is missing its questions or its rules.'];
  }
  const inputs = new Map(model.inputs.map((input) => [input.id, input]));
  const problems: string[] = [];
  model.rules.forEach((rule, i) => {
    const name = `Rule ${i + 1}`;
    auditExpr(rule.when, name, inputs, true, problems);
    if (actionLabel(rule.then?.action) === undefined) {
      problems.push(`${name} has an action this screen does not recognise ("${String(rule.then?.action)}").`);
    }
  });
  return problems;
}
