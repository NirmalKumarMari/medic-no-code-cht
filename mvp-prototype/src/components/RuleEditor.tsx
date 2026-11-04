import type { ConditionDraft, QuestionDraft, RuleDraft } from '../types/draft';
import type { Comparison } from '../types/logic-model';
import { COMPARISON_LABELS, isNumberType } from '../types/logic-model';
import { parseChoices } from '../data/drafts';
import OutcomeFields from './OutcomeFields';
import { SelectField, TextField } from './fields';

// One rule: conditions built from the defined questions (no free-text logic),
// what the health worker should do, an optional follow-up, and a guideline
// reference. Rules can be reordered because the first match wins.

const COMPARISON_OPTIONS = (['gte', 'lt', 'eq'] as Comparison[]).map((value) => ({
  value,
  label: COMPARISON_LABELS[value],
}));

const YES_NO_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

function questionName(q: QuestionDraft, i: number): string {
  return q.label.trim() || `Question ${i + 1} (not written yet)`;
}

interface Props {
  rule: RuleDraft;
  index: number;
  total: number;
  questions: QuestionDraft[];
  errorFor: (fieldId: string) => string | undefined;
  onChange: (patch: Partial<RuleDraft>) => void;
  onChangeCondition: (conditionKey: string, patch: Partial<ConditionDraft>) => void;
  onAddCondition: () => void;
  onRemoveCondition: (conditionKey: string) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}

export default function RuleEditor({
  rule,
  index,
  total,
  questions,
  errorFor,
  onChange,
  onChangeCondition,
  onAddCondition,
  onRemoveCondition,
  onMove,
  onRemove,
}: Props) {
  const n = index + 1;
  const name = `Rule ${n}`;
  const questionOptions = questions.map((q, i) => ({ value: q.key, label: questionName(q, i) }));

  return (
    <fieldset className="rule">
      <legend>{name}</legend>
      <div className="toolbar">
        <button
          type="button"
          id={`r-${rule.key}-up`}
          className="btn-secondary btn-small"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <span aria-hidden="true">↑ </span>Move up<span className="sr-only"> rule {n}</span>
        </button>
        <button
          type="button"
          id={`r-${rule.key}-down`}
          className="btn-secondary btn-small"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <span aria-hidden="true">↓ </span>Move down<span className="sr-only"> rule {n}</span>
        </button>
        {total > 1 && (
          <button type="button" className="btn-link" onClick={onRemove}>
            Remove<span className="sr-only"> rule {n}</span>
          </button>
        )}
      </div>

      <fieldset className="plain">
        <legend>When all of these are true</legend>
        {rule.conditions.map((c, ci) => {
          const q = questions.find((x) => x.key === c.questionKey);
          const context = `${name}, condition ${ci + 1}`;
          const prefix = <span className="sr-only">{context}: </span>;
          const valueId = `c-${c.key}-value`;
          return (
            <div key={c.key}>
              {ci > 0 && (
                <p className="and-separator" aria-hidden="true">
                  and
                </p>
              )}
              <div className="condition">
                <SelectField
                  id={`c-${c.key}-question`}
                  className="condition-question"
                  label={<>{prefix}Question</>}
                  value={q ? c.questionKey : ''}
                  placeholder="Choose a question"
                  options={questionOptions}
                  error={errorFor(`c-${c.key}-question`)}
                  onChange={(v) => {
                    const next = questions.find((x) => x.key === v);
                    onChangeCondition(c.key, {
                      questionKey: v,
                      op: next && isNumberType(next.type) ? 'gte' : 'eq',
                      value: '',
                    });
                  }}
                />
                {q && isNumberType(q.type) && (
                  <>
                    <SelectField
                      id={`c-${c.key}-op`}
                      label={<>{prefix}Comparison</>}
                      value={c.op}
                      options={COMPARISON_OPTIONS}
                      onChange={(v) => onChangeCondition(c.key, { op: v as Comparison })}
                    />
                    <TextField
                      id={valueId}
                      label={<>{prefix}Number</>}
                      inputMode={q.type === 'decimal' ? 'decimal' : 'numeric'}
                      value={c.value}
                      error={errorFor(valueId)}
                      onChange={(v) => onChangeCondition(c.key, { value: v })}
                    />
                  </>
                )}
                {q && q.type === 'yes_no' && (
                  <SelectField
                    id={valueId}
                    label={<>{prefix}Answer</>}
                    value={c.value}
                    placeholder="Choose an answer"
                    options={YES_NO_OPTIONS}
                    error={errorFor(valueId)}
                    onChange={(v) => onChangeCondition(c.key, { value: v })}
                  />
                )}
                {q && q.type === 'select' && (
                  <SelectField
                    id={valueId}
                    label={<>{prefix}Answer</>}
                    value={c.value}
                    placeholder="Choose an answer"
                    options={parseChoices(q.choices).map((choice) => ({ value: choice, label: choice }))}
                    error={errorFor(valueId)}
                    onChange={(v) => onChangeCondition(c.key, { value: v })}
                  />
                )}
                {rule.conditions.length > 1 && (
                  <button type="button" className="btn-link condition-remove" onClick={() => onRemoveCondition(c.key)}>
                    Remove<span className="sr-only"> condition {ci + 1} from rule {n}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          id={`r-${rule.key}-add-condition`}
          className="btn-add btn-small"
          onClick={onAddCondition}
        >
          + Add another condition<span className="sr-only"> to rule {n}</span>
        </button>
      </fieldset>

      <OutcomeFields
        idPrefix={`r-${rule.key}`}
        context={name}
        value={rule}
        onChange={onChange}
        errorFor={errorFor}
      />

      <TextField
        id={`r-${rule.key}-source`}
        label={
          <>
            <span className="sr-only">{name}: </span>Where is this in the guideline?{' '}
            <span className="optional">(optional)</span>
          </>
        }
        hint="Section name or page. In the full system, the AI adds this from the guideline."
        value={rule.source}
        onChange={(v) => onChange({ source: v })}
      />
    </fieldset>
  );
}
