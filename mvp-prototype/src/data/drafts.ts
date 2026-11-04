import type {
  ConditionDraft,
  OutcomeDraft,
  QuestionDraft,
  RequirementsDraft,
  RuleDraft,
} from '../types/draft';
import type { ActionKind, Comparison } from '../types/logic-model';

let counter = 0;

/** Stable keys for list items, so React keeps focus and state on the right row. */
export function newKey(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export function parseChoices(raw: string): string[] {
  return raw
    .split(',')
    .map((choice) => choice.trim())
    .filter(Boolean);
}

export function emptyQuestion(): QuestionDraft {
  return { key: newKey('q'), label: '', type: 'integer', choices: '' };
}

export function emptyCondition(): ConditionDraft {
  return { key: newKey('c'), questionKey: '', op: 'gte', value: '' };
}

function emptyOutcome(): OutcomeDraft {
  return { action: '', followUp: false, dueInDays: '', openForDays: '' };
}

export function emptyRule(): RuleDraft {
  return { key: newKey('r'), conditions: [emptyCondition()], source: '', ...emptyOutcome() };
}

export function emptyDraft(): RequirementsDraft {
  return {
    pathway: '',
    guidelineName: '',
    guidelineVersion: '',
    questions: [emptyQuestion()],
    rules: [emptyRule()],
    // Blank on purpose: the catch-all is a clinical decision, so nothing is preselected.
    otherwise: emptyOutcome(),
    otherwiseSource: '',
  };
}

/** True once the user has typed or chosen anything. */
export function hasContent(d: RequirementsDraft): boolean {
  return Boolean(
    d.pathway.trim() ||
      d.guidelineName.trim() ||
      d.guidelineVersion.trim() ||
      d.questions.some((q) => q.label.trim()) ||
      d.rules.some((r) => r.conditions.some((c) => c.questionKey || c.value.trim())),
  );
}

function condition(questionKey: string, op: Comparison, value: string): ConditionDraft {
  return { key: newKey('c'), questionKey, op, value };
}

function ruleWithFollowUp(
  conditions: ConditionDraft[],
  action: ActionKind,
  dueInDays: string,
  openForDays: string,
  source = '',
): RuleDraft {
  return { key: newKey('r'), conditions, action, followUp: true, dueInDays, openForDays, source };
}

/**
 * Illustrative example only, loosely based on the WHO IMCI cough and fast
 * breathing chart. It is not clinical guidance: real pathways and their golden
 * cases must be confirmed by a clinician (design doc section 20).
 */
export function exampleDraft(): RequirementsDraft {
  const age = newKey('q');
  const breaths = newKey('q');
  const danger = newKey('q');
  return {
    pathway: 'Child cough and fast breathing',
    guidelineName: 'WHO IMCI chart booklet',
    guidelineVersion: '2014',
    questions: [
      { key: age, label: "Child's age in months", type: 'integer', choices: '' },
      { key: breaths, label: 'Breaths per minute', type: 'integer', choices: '' },
      { key: danger, label: 'Any danger sign present?', type: 'yes_no', choices: '' },
    ],
    rules: [
      ruleWithFollowUp([condition(danger, 'eq', 'yes')], 'refer_urgently', '1', '3', 'General danger signs'),
      ruleWithFollowUp([condition(age, 'lt', '2')], 'refer_urgently', '1', '3'),
      ruleWithFollowUp(
        [condition(age, 'gte', '2'), condition(age, 'lt', '12'), condition(breaths, 'gte', '50')],
        'treat_at_home',
        '3',
        '3',
      ),
      ruleWithFollowUp(
        [condition(age, 'gte', '12'), condition(age, 'lt', '60'), condition(breaths, 'gte', '40')],
        'treat_at_home',
        '3',
        '3',
      ),
    ],
    otherwise: { action: 'home_care_advice', followUp: false, dueInDays: '', openForDays: '' },
    otherwiseSource: '',
  };
}
