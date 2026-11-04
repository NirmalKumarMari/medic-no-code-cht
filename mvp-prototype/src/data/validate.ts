// Form validation. Each message names the exact field, so it can be shown next
// to the field and linked from the error summary.

import type { OutcomeDraft, RequirementsDraft } from '../types/draft';
import { isNumberType } from '../types/logic-model';
import { parseChoices } from './drafts';

export interface FieldError {
  /** id of the form control the message belongs to */
  fieldId: string;
  message: string;
}

const WHOLE_NUMBER = /^\d+$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

function normalise(label: string): string {
  return label.trim().toLowerCase().replace(/\?$/, '');
}

function validateOutcome(o: OutcomeDraft, idPrefix: string, name: string, errors: FieldError[]) {
  if (!o.action) {
    errors.push({ fieldId: `${idPrefix}-action`, message: `${name}: choose what the health worker should do` });
  }
  if (!o.followUp) return;
  if (!WHOLE_NUMBER.test(o.dueInDays.trim())) {
    errors.push({
      fieldId: `${idPrefix}-due`,
      message: `${name}: enter when the follow-up is due, in whole days (0 or more)`,
    });
  }
  if (!WHOLE_NUMBER.test(o.openForDays.trim()) || Number(o.openForDays) < 1) {
    errors.push({
      fieldId: `${idPrefix}-open`,
      message: `${name}: enter how many days the task stays open (1 or more)`,
    });
  }
}

export function validateDraft(d: RequirementsDraft): FieldError[] {
  const errors: FieldError[] = [];

  if (!d.pathway.trim()) errors.push({ fieldId: 'pathway', message: 'Enter the pathway name' });
  if (!d.guidelineName.trim()) {
    errors.push({ fieldId: 'guideline-name', message: 'Enter the guideline it is based on' });
  }

  const seen = new Map<string, number>();
  d.questions.forEach((q, i) => {
    const n = i + 1;
    const label = normalise(q.label);
    if (!label) {
      errors.push({ fieldId: `q-${q.key}-label`, message: `Question ${n}: enter the question` });
    } else if (seen.has(label)) {
      errors.push({
        fieldId: `q-${q.key}-label`,
        message: `Question ${n}: this is the same as question ${seen.get(label)}`,
      });
    } else {
      seen.set(label, n);
    }
    if (q.type === 'select_one' && parseChoices(q.choices).length < 2) {
      errors.push({
        fieldId: `q-${q.key}-choices`,
        message: `Question ${n}: enter at least 2 choices, separated by commas`,
      });
    }
  });

  d.rules.forEach((r, i) => {
    const name = `Rule ${i + 1}`;
    r.conditions.forEach((c, ci) => {
      const where = `${name}, condition ${ci + 1}`;
      const q = d.questions.find((x) => x.key === c.questionKey);
      if (!q) {
        errors.push({ fieldId: `c-${c.key}-question`, message: `${where}: choose a question` });
        return;
      }
      const value = c.value.trim();
      const valueId = `c-${c.key}-value`;
      if (isNumberType(q.type)) {
        const ok = q.type === 'integer' ? WHOLE_NUMBER.test(value) : NUMBER.test(value);
        if (!ok) {
          errors.push({
            fieldId: valueId,
            message: `${where}: enter ${q.type === 'integer' ? 'a whole number' : 'a number'}`,
          });
        }
      } else if (q.type === 'yes_no') {
        if (value !== 'yes' && value !== 'no') {
          errors.push({ fieldId: valueId, message: `${where}: choose Yes or No` });
        }
      } else if (!parseChoices(q.choices).includes(value)) {
        errors.push({ fieldId: valueId, message: `${where}: choose an answer` });
      }
    });
    validateOutcome(r, `r-${r.key}`, name, errors);
  });

  validateOutcome(d.otherwise, 'otherwise', 'If no rule matches', errors);
  return errors;
}
