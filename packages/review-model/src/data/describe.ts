// Plain-language wording for the logic, shared by the flowchart, table and checks.

import type { Comparison, FollowUp, LogicInput } from '../types/logic-model.js';
import { COMPARISON_LABELS, isNumberType } from '../types/logic-model.js';
import type { Patient } from './evaluate.js';

export function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function answerText(op: Comparison, value: string | number | boolean, input: LogicInput | undefined): string {
  if (input && isNumberType(input.type)) {
    return `${COMPARISON_LABELS[op].replace(/^is /, '')} ${value}`;
  }
  if (input?.type === 'yes_no') return value === 'yes' || value === true ? 'Yes' : 'No';
  return String(value);
}

/** For example "Breaths per minute: at least 50" or "Any danger sign present? Yes". */
export function describeLeaf(
  inputId: string,
  op: Comparison,
  value: string | number | boolean,
  inputs: LogicInput[],
): string {
  const input = inputs.find((i) => i.id === inputId);
  const label = input?.label ?? `Unknown question (${inputId})`;
  const answer = answerText(op, value, input);
  return label.endsWith('?') ? `${label} ${capitalise(answer)}` : `${label}: ${answer}`;
}

export function describeFollowUp(f: FollowUp): string {
  const due = f.dueInDays === 0 ? 'due the same day' : `due in ${days(f.dueInDays)}`;
  return `Follow-up task ${due}, then open for ${days(f.openForDays)}`;
}

/** For example "Child's age in months: 61; Any danger sign present? No". */
export function describePatient(patient: Patient, inputs: LogicInput[]): string {
  return inputs
    .filter((input) => input.id in patient)
    .map((input) => {
      const value = patient[input.id];
      const answer = input.type === 'yes_no' ? capitalise(String(value)) : String(value);
      return input.label.endsWith('?') ? `${input.label} ${answer}` : `${input.label}: ${answer}`;
    })
    .join('; ');
}
