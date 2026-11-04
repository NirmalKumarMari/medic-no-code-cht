import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConditionDraft, Notice, QuestionDraft, RequirementsDraft, RuleDraft } from '../types/draft';
import type { QuestionType } from '../types/logic-model';
import { QUESTION_TYPE_LABELS, isNumberType } from '../types/logic-model';
import { emptyCondition, emptyDraft, emptyQuestion, emptyRule, exampleDraft, hasContent } from '../data/drafts';
import { validateDraft } from '../data/validate';
import ErrorSummary from './ErrorSummary';
import OutcomeFields from './OutcomeFields';
import RuleEditor from './RuleEditor';
import { SelectField, TextField } from './fields';

// Structured form: pathway, the questions the health worker answers, ordered
// rules built from those questions, and a catch-all outcome. Validation runs
// on submit; after that, errors update as the user fixes them.

const TYPE_OPTIONS = (Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((value) => ({
  value,
  label: QUESTION_TYPE_LABELS[value],
}));

/** Clears a condition's answer when its question's answer type changes. */
function resetAnswer(c: ConditionDraft, type: QuestionType): ConditionDraft {
  return { ...c, op: isNumberType(type) ? 'gte' : 'eq', value: '' };
}

interface Props {
  initial?: RequirementsDraft;
  notice?: Notice;
  onGenerate: (draft: RequirementsDraft) => void;
}

export default function RequirementsForm({ initial, notice, onGenerate }: Props) {
  const [draft, setDraft] = useState<RequirementsDraft>(() => initial ?? emptyDraft());
  const [attempted, setAttempted] = useState(false);
  const [failedSubmits, setFailedSubmits] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const summaryRef = useRef<HTMLDivElement>(null);

  const errors = attempted ? validateDraft(draft) : [];
  const errorFor = (id: string) => errors.find((e) => e.fieldId === id)?.message;

  // After a failed submit, move focus to the error summary.
  useEffect(() => {
    if (failedSubmits > 0) summaryRef.current?.focus();
  }, [failedSubmits]);

  // Move focus to a control that was just added or moved, once it is rendered.
  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  const update = (patch: Partial<RequirementsDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function updateQuestion(key: string, patch: Partial<QuestionDraft>) {
    setDraft((d) => {
      const newType = patch.type;
      const typeChanged = newType !== undefined && d.questions.find((q) => q.key === key)?.type !== newType;
      return {
        ...d,
        questions: d.questions.map((q) => (q.key === key ? { ...q, ...patch } : q)),
        rules: typeChanged
          ? d.rules.map((r) => ({
              ...r,
              conditions: r.conditions.map((c) => (c.questionKey === key ? resetAnswer(c, newType) : c)),
            }))
          : d.rules,
      };
    });
  }

  function updateRule(key: string, patch: Partial<RuleDraft>) {
    setDraft((d) => ({ ...d, rules: d.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  }

  function updateCondition(ruleKey: string, conditionKey: string, patch: Partial<ConditionDraft>) {
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) =>
        r.key === ruleKey
          ? { ...r, conditions: r.conditions.map((c) => (c.key === conditionKey ? { ...c, ...patch } : c)) }
          : r,
      ),
    }));
  }

  function addQuestion() {
    const q = emptyQuestion();
    setDraft((d) => ({ ...d, questions: [...d.questions, q] }));
    setFocusId(`q-${q.key}-label`);
  }

  function removeQuestion(key: string, n: number) {
    setDraft((d) => ({ ...d, questions: d.questions.filter((q) => q.key !== key) }));
    setStatus(`Question ${n} removed.`);
    setFocusId('add-question');
  }

  function addRule() {
    const r = emptyRule();
    setDraft((d) => ({ ...d, rules: [...d.rules, r] }));
    setFocusId(`c-${r.conditions[0].key}-question`);
  }

  function removeRule(key: string, n: number) {
    setDraft((d) => ({ ...d, rules: d.rules.filter((r) => r.key !== key) }));
    setStatus(`Rule ${n} removed.`);
    setFocusId('add-rule');
  }

  function moveRule(key: string, direction: -1 | 1) {
    const total = draft.rules.length;
    const from = draft.rules.findIndex((r) => r.key === key);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= total) return;
    setDraft((d) => {
      const rules = [...d.rules];
      const [moved] = rules.splice(from, 1);
      rules.splice(to, 0, moved);
      return { ...d, rules };
    });
    // Keep focus on the button that was pressed, unless it is now disabled.
    const atEdge = to === 0 || to === total - 1;
    const pressed = direction === -1 ? 'up' : 'down';
    const other = direction === -1 ? 'down' : 'up';
    setFocusId(`r-${key}-${atEdge ? other : pressed}`);
    setStatus(`Rule moved to position ${to + 1} of ${total}.`);
  }

  function addCondition(ruleKey: string) {
    const c = emptyCondition();
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) => (r.key === ruleKey ? { ...r, conditions: [...r.conditions, c] } : r)),
    }));
    setFocusId(`c-${c.key}-question`);
  }

  function removeCondition(ruleKey: string, conditionKey: string) {
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) =>
        r.key === ruleKey ? { ...r, conditions: r.conditions.filter((c) => c.key !== conditionKey) } : r,
      ),
    }));
    setStatus('Condition removed.');
    setFocusId(`r-${ruleKey}-add-condition`);
  }

  function fillExample() {
    if (hasContent(draft) && !window.confirm('Replace what you have entered with the example?')) return;
    setDraft(exampleDraft());
    setAttempted(false);
    setStatus('Example filled in. Check it, then choose Generate flowchart.');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (validateDraft(draft).length > 0) {
      setFailedSubmits((n) => n + 1);
      return;
    }
    onGenerate(draft);
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <p className="sr-only" role="status">
        {status}
      </p>

      {notice && (
        <div className={`notice notice-${notice.tone}`}>
          <h3>{notice.title}</h3>
          {notice.lines.length === 1 ? (
            <p>{notice.lines[0]}</p>
          ) : (
            <ul>
              {notice.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="hint">Change the answers below, then generate a new version.</p>
        </div>
      )}

      {errors.length > 0 && <ErrorSummary ref={summaryRef} errors={errors} />}

      <div className="card intro">
        <p>
          Describe the pathway the way you would explain it to a colleague. Fields marked * are required.
        </p>
        <div className="intro-row">
          <p>Want to see how it works first?</p>
          <button type="button" className="btn-secondary" onClick={fillExample}>
            Fill in an example
          </button>
        </div>
        <p className="hint">The example is illustrative only. It is not clinical guidance.</p>
      </div>

      <section className="card" aria-labelledby="pathway-heading">
        <h3 id="pathway-heading">1. Pathway</h3>
        <TextField
          id="pathway"
          label="Pathway name"
          hint="For example, Child cough and fast breathing"
          required
          value={draft.pathway}
          error={errorFor('pathway')}
          onChange={(v) => update({ pathway: v })}
        />
        <div className="field-row">
          <TextField
            id="guideline-name"
            label="Guideline it is based on"
            hint="For example, WHO IMCI chart booklet"
            required
            value={draft.guidelineName}
            error={errorFor('guideline-name')}
            onChange={(v) => update({ guidelineName: v })}
          />
          <TextField
            id="guideline-version"
            label={
              <>
                Edition or year <span className="optional">(optional)</span>
              </>
            }
            hint="For example, 2014"
            short
            value={draft.guidelineVersion}
            onChange={(v) => update({ guidelineVersion: v })}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="questions-heading">
        <h3 id="questions-heading">2. Questions the health worker answers</h3>
        <p className="hint">These become the questions in the form on the health worker's phone.</p>
        {draft.questions.map((q, i) => {
          const n = i + 1;
          return (
            <fieldset key={q.key}>
              <legend>Question {n}</legend>
              <div className="field-row">
                <TextField
                  id={`q-${q.key}-label`}
                  label={
                    <>
                      <span className="sr-only">Question {n}: </span>Question
                    </>
                  }
                  hint="For example, Breaths per minute"
                  required
                  value={q.label}
                  error={errorFor(`q-${q.key}-label`)}
                  onChange={(v) => updateQuestion(q.key, { label: v })}
                />
                <SelectField
                  id={`q-${q.key}-type`}
                  label={
                    <>
                      <span className="sr-only">Question {n}: </span>Type of answer
                    </>
                  }
                  value={q.type}
                  options={TYPE_OPTIONS}
                  onChange={(v) => updateQuestion(q.key, { type: v as QuestionType })}
                />
              </div>
              {q.type === 'select' && (
                <TextField
                  id={`q-${q.key}-choices`}
                  label={
                    <>
                      <span className="sr-only">Question {n}: </span>Choices
                    </>
                  }
                  hint="Separate the choices with commas, for example: Cough, Fever, Diarrhoea"
                  required
                  value={q.choices}
                  error={errorFor(`q-${q.key}-choices`)}
                  onChange={(v) => updateQuestion(q.key, { choices: v })}
                />
              )}
              {draft.questions.length > 1 && (
                <button type="button" className="btn-link" onClick={() => removeQuestion(q.key, n)}>
                  Remove<span className="sr-only"> question {n}</span>
                </button>
              )}
            </fieldset>
          );
        })}
        <button id="add-question" type="button" className="btn-add" onClick={addQuestion}>
          + Add a question
        </button>
      </section>

      <section className="card" aria-labelledby="rules-heading">
        <h3 id="rules-heading">3. Rules</h3>
        <p className="hint">
          Rules are checked from top to bottom, and the first rule that matches decides what happens. Put the most
          serious rules first.
        </p>
        {draft.rules.map((r, i) => (
          <RuleEditor
            key={r.key}
            rule={r}
            index={i}
            total={draft.rules.length}
            questions={draft.questions}
            errorFor={errorFor}
            onChange={(patch) => updateRule(r.key, patch)}
            onChangeCondition={(conditionKey, patch) => updateCondition(r.key, conditionKey, patch)}
            onAddCondition={() => addCondition(r.key)}
            onRemoveCondition={(conditionKey) => removeCondition(r.key, conditionKey)}
            onMove={(direction) => moveRule(r.key, direction)}
            onRemove={() => removeRule(r.key, i + 1)}
          />
        ))}
        <button id="add-rule" type="button" className="btn-add" onClick={addRule}>
          + Add a rule
        </button>
      </section>

      <section className="card" aria-labelledby="otherwise-heading">
        <h3 id="otherwise-heading">4. If no rule matches</h3>
        <p className="hint">This catch-all makes sure every patient gets an outcome.</p>
        <OutcomeFields
          idPrefix="otherwise"
          context="If no rule matches"
          value={draft.otherwise}
          errorFor={errorFor}
          onChange={(patch) => setDraft((d) => ({ ...d, otherwise: { ...d.otherwise, ...patch } }))}
        />
      </section>

      <div className="button-bar">
        <button type="submit" className="btn">
          Generate flowchart
        </button>
      </div>
    </form>
  );
}
