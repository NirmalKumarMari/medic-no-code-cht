// What the form edits. Kept separate from the LogicModel: the form holds text
// exactly as typed, and the generator turns a valid draft into a model.

import type { ActionKind, Comparison, QuestionType } from './logic-model';

export interface QuestionDraft {
  key: string;
  label: string;
  type: QuestionType;
  /** Comma-separated. Only used when type is 'select_one'. */
  choices: string;
}

export interface ConditionDraft {
  key: string;
  questionKey: string;
  op: Comparison;
  value: string;
}

export interface OutcomeDraft {
  action: ActionKind | '';
  followUp: boolean;
  dueInDays: string;
  openForDays: string;
}

export interface RuleDraft extends OutcomeDraft {
  key: string;
  conditions: ConditionDraft[];
  source: string;
}

export interface RequirementsDraft {
  pathway: string;
  guidelineName: string;
  guidelineVersion: string;
  questions: QuestionDraft[];
  rules: RuleDraft[];
  /** What happens when no rule matches. */
  otherwise: OutcomeDraft;
  otherwiseSource: string;
}

/** A message shown at the top of the form when the user comes back to edit. */
export interface Notice {
  tone: 'info' | 'error';
  title: string;
  lines: string[];
}
