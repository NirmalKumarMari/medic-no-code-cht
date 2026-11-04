// LogicModel: the one structured description of a pathway's logic.
//
// Follows the FINAL Solution Design doc, section 10: each rule is stored once,
// as "when" (conditions) + "then" (action) + an optional follow-up. The
// flowchart, decision table, automatic checks and JSON view all read this same
// object, so what a reviewer approves is exactly what the compiler would read
// (design rule 5).

/** integer and decimal match the XLSForm field types the compiler would emit. */
export type QuestionType = 'integer' | 'decimal' | 'yes_no' | 'select';

export interface LogicInput {
  id: string;
  type: QuestionType;
  label: string;
  /** Only for 'select' questions. */
  choices?: string[];
}

/** eq: "is exactly" (or "is" for yes/no and choices); gte: "is at least"; lt: "is less than". */
export type Comparison = 'eq' | 'gte' | 'lt';

export interface LogicCondition {
  /** The LogicInput.id this condition reads. */
  input: string;
  op: Comparison;
  /** A number for number questions, 'yes' | 'no' for yes/no, the choice text for choice lists. */
  value: number | string;
}

export type RuleWhen = { all: LogicCondition[] } | { otherwise: true };

export type ActionKind = 'refer_urgently' | 'treat_at_home' | 'home_care_advice';

/** Becomes a CHT task: dueInDays -> tasks.js events[].days, openForDays -> events[].end. */
export interface FollowUp {
  dueInDays: number;
  openForDays: number;
}

export interface LogicRule {
  id: string;
  when: RuleWhen;
  then: { action: ActionKind };
  followUp?: FollowUp;
  source?: { section: string };
}

export interface LogicModel {
  snapshotId: string;
  version: number;
  pathway: string;
  guideline: { name: string; version?: string };
  inputs: LogicInput[];
  /** Checked top to bottom; the first match decides. The last rule is always the catch-all. */
  rules: LogicRule[];
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  refer_urgently: 'Refer urgently to a health facility',
  treat_at_home: 'Treat at home',
  home_care_advice: 'Give home care advice',
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  integer: 'A whole number (for example, breaths per minute)',
  decimal: 'A number with decimals (for example, temperature)',
  yes_no: 'Yes or no',
  select: 'One choice from a list',
};

export const COMPARISON_LABELS: Record<Comparison, string> = {
  gte: 'is at least',
  lt: 'is less than',
  eq: 'is exactly',
};

export function isNumberType(type: QuestionType): boolean {
  return type === 'integer' || type === 'decimal';
}

export function isOtherwise(rule: LogicRule): boolean {
  return 'otherwise' in rule.when;
}

export function conditionsOf(rule: LogicRule): LogicCondition[] {
  return 'all' in rule.when ? rule.when.all : [];
}
