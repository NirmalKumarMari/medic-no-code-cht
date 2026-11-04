// Plain-language wording for the logic, shared by the flowchart and table.

import type { FollowUp, LogicCondition, LogicInput } from '../types/logic-model';
import { COMPARISON_LABELS, isNumberType } from '../types/logic-model';

export function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function answerText(cond: LogicCondition, input: LogicInput | undefined): string {
  if (input && isNumberType(input.type)) {
    return `${COMPARISON_LABELS[cond.op].replace(/^is /, '')} ${cond.value}`;
  }
  if (input?.type === 'yes_no') return cond.value === 'yes' ? 'Yes' : 'No';
  return String(cond.value);
}

/** For example "Breaths per minute: at least 50" or "Any danger sign present? Yes". */
export function describeCondition(cond: LogicCondition, inputs: LogicInput[]): string {
  const input = inputs.find((i) => i.id === cond.input);
  const label = input?.label ?? 'Unknown question';
  const answer = answerText(cond, input);
  return label.endsWith('?') ? `${label} ${capitalise(answer)}` : `${label}: ${answer}`;
}

export function describeFollowUp(f: FollowUp): string {
  const due = f.dueInDays === 0 ? 'due the same day' : `due in ${days(f.dueInDays)}`;
  return `Follow-up task ${due}, then open for ${days(f.openForDays)}`;
}
