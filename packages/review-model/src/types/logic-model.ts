// LogicModel: the one structured description of a pathway's logic.
//
// Follows the FINAL Solution Design doc, section 10: each rule is stored once,
// as "when" (an expression) + "then" (action) + an optional follow-up. The
// flowchart, decision table, automatic checks and JSON view all read this same
// object, so what a reviewer approves is exactly what the compiler would read
// (design rule 5).
//
// The shape matches the Change Planner agent's LogicModelSchema, with these
// proposed additions, which the agents' schema must adopt too:
// - gte and lt leaves, because "breaths per minute >= 50" cannot be written with
//   eq alone
// - decimal inputs and choices on select_one inputs
// - a source on flags, and page and quote on sources (each ambiguity must be
//   shown with its source passage)

export type InputType = 'integer' | 'decimal' | 'yes_no' | 'select_one' | 'text';

/** The answer types the hand-edit form offers. */
export type QuestionType = Exclude<InputType, 'text'>;

export interface LogicInput {
  id: string;
  type: InputType;
  label: string;
  /** Only for 'select_one' questions. */
  choices?: string[];
}

/** The comparisons the hand-edit form offers. */
export type Comparison = 'eq' | 'gte' | 'gt' | 'lte' | 'lt';

/** Every comparison in the shared @vera/schemas LogicModel. */
export type LeafOp = Comparison | 'neq' | 'in';

export type LeafValue = string | number | boolean | (string | number)[];

export type LeafCondition =
  | { input: string; eq: string | number | boolean }
  | { input: string; neq: string | number | boolean }
  | { input: string; gte: number }
  | { input: string; gt: number }
  | { input: string; lte: number }
  | { input: string; lt: number }
  | { input: string; in: (string | number)[] };

export type Expr = { all: Expr[] } | { any: Expr[] } | { not: Expr } | { otherwise: true } | LeafCondition;

export type ActionKind = 'refer_urgently' | 'treat_at_home' | 'home_care_advice';

/** Becomes a CHT task: dueInDays -> tasks.js events[].days, openForDays -> events[].end. */
export interface FollowUp {
  dueInDays: number;
  openForDays: number;
}

export interface SourceRef {
  section?: string;
  page?: number;
  /** The guideline passage itself. */
  quote?: string;
  tableId?: string;
  chunkId?: string;
}

export interface LogicRule {
  id: string;
  when: Expr;
  /** A string, not ActionKind: this data comes from outside the UI. See findDisplayProblems. */
  then: { action: string };
  followUp?: FollowUp;
  source?: SourceRef;
}

export interface LogicFlag {
  type: 'ambiguity' | 'missing_input' | 'gap' | 'uncited_rule' | 'conflict';
  ruleId?: string;
  text: string;
  source?: SourceRef;
  /** Set once a person has settled it. An open ambiguity blocks approval. */
  resolved?: boolean;
}

export interface LogicModel {
  snapshotId: string;
  /** Assigned by the server. The UI displays it and never computes it. */
  snapshotHash?: string;
  version?: number;
  pathway: { id: string; title: string };
  guideline?: { name: string; version?: string };
  inputs: LogicInput[];
  /** Checked top to bottom; the first match decides. The last rule is always the catch-all. */
  rules: LogicRule[];
  flags?: LogicFlag[];
}

export const ACTION_LABELS: Record<ActionKind, string> = {
  refer_urgently: 'Refer urgently to a health facility',
  treat_at_home: 'Treat at home',
  home_care_advice: 'Give home care advice',
};

/** Actions the shared schema allows but the hand-edit form does not offer. */
const OTHER_ACTION_LABELS: Record<string, string> = {
  follow_up: 'Schedule a follow-up visit',
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  integer: 'A whole number (for example, breaths per minute)',
  decimal: 'A number with decimals (for example, temperature)',
  yes_no: 'Yes or no',
  select_one: 'One choice from a list',
};

export const COMPARISON_LABELS: Record<Comparison, string> = {
  gte: 'is at least',
  gt: 'is more than',
  lte: 'is at most',
  lt: 'is less than',
  eq: 'is exactly',
};

export function isNumberType(type: InputType): boolean {
  return type === 'integer' || type === 'decimal';
}

/** The label for an action, or undefined if this UI does not know the action. */
export function actionLabel(action: unknown): string | undefined {
  if (typeof action !== 'string') return undefined;
  if (Object.prototype.hasOwnProperty.call(ACTION_LABELS, action)) return ACTION_LABELS[action as ActionKind];
  return Object.prototype.hasOwnProperty.call(OTHER_ACTION_LABELS, action) ? OTHER_ACTION_LABELS[action] : undefined;
}

export type ParsedExpr =
  | { kind: 'all' | 'any'; items: unknown[] }
  | { kind: 'not'; item: unknown }
  | { kind: 'otherwise' }
  | { kind: 'leaf'; input: string; op: LeafOp; value: LeafValue }
  | { kind: 'invalid' };

/**
 * Reads an expression strictly. Anything not exactly one known shape is
 * 'invalid', so an extra or unknown key can never be silently dropped from
 * what the approver sees. Takes unknown because the data comes from outside.
 */
export function parseExpr(expr: unknown): ParsedExpr {
  if (expr === null || typeof expr !== 'object' || Array.isArray(expr)) return { kind: 'invalid' };
  const record = expr as Record<string, unknown>;
  const keys = Object.keys(record);

  if (keys.length === 1) {
    if (Array.isArray(record.all)) return { kind: 'all', items: record.all };
    if (Array.isArray(record.any)) return { kind: 'any', items: record.any };
    if ('not' in record) return { kind: 'not', item: record.not };
    if (record.otherwise === true) return { kind: 'otherwise' };
    return { kind: 'invalid' };
  }

  if (keys.length === 2 && typeof record.input === 'string') {
    const input = record.input as string;
    for (const op of ['eq', 'neq'] as const) {
      const value = record[op];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return { kind: 'leaf', input, op, value };
      }
    }
    for (const op of ['gte', 'gt', 'lte', 'lt'] as const) {
      const value = record[op];
      if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'leaf', input, op, value };
    }
    const list = record.in;
    if (Array.isArray(list) && list.length > 0 && list.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return { kind: 'leaf', input, op: 'in', value: list as (string | number)[] };
    }
  }
  return { kind: 'invalid' };
}

export function isOtherwise(rule: LogicRule): boolean {
  return parseExpr(rule.when).kind === 'otherwise';
}

export function hasCitation(source: SourceRef | undefined): boolean {
  return Boolean(source && (source.section?.trim() || source.page !== undefined || source.quote?.trim()));
}

/** How to name this snapshot on screen, for example "version 2". */
export function modelLabel(model: LogicModel): string {
  return model.version !== undefined ? `version ${model.version}` : `snapshot ${model.snapshotId}`;
}
