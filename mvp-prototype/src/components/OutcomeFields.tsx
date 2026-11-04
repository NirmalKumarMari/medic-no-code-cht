import type { OutcomeDraft } from '../types/draft';
import type { ActionKind } from '../types/logic-model';
import { ACTION_LABELS } from '../types/logic-model';
import { SelectField, TextField } from './fields';

// "What should the health worker do?" plus an optional follow-up task.
// Used for each rule and for the "if no rule matches" catch-all.

const ACTION_OPTIONS = (Object.keys(ACTION_LABELS) as ActionKind[]).map((value) => ({
  value,
  label: ACTION_LABELS[value],
}));

interface Props {
  /** Prefix for element ids, e.g. "r-r3" or "otherwise". */
  idPrefix: string;
  /** Read out before each label so repeated labels are told apart, e.g. "Rule 2". */
  context: string;
  value: OutcomeDraft;
  onChange: (patch: Partial<OutcomeDraft>) => void;
  errorFor: (fieldId: string) => string | undefined;
}

export default function OutcomeFields({ idPrefix, context, value, onChange, errorFor }: Props) {
  const followUpId = `${idPrefix}-followup`;
  return (
    <>
      <SelectField
        id={`${idPrefix}-action`}
        label={
          <>
            <span className="sr-only">{context}: </span>What should the health worker do?
          </>
        }
        required
        value={value.action}
        placeholder="Choose what to do"
        options={ACTION_OPTIONS}
        error={errorFor(`${idPrefix}-action`)}
        onChange={(v) => onChange({ action: v as ActionKind | '' })}
      />

      <div className="checkbox">
        <input
          id={followUpId}
          type="checkbox"
          checked={value.followUp}
          onChange={(e) => onChange({ followUp: e.target.checked })}
        />
        <label htmlFor={followUpId}>
          <span className="sr-only">{context}: </span>Create a follow-up task on the health worker's phone
        </label>
      </div>

      {value.followUp && (
        <div className="reveal">
          <p className="hint">The task appears in the Tasks list of the health worker's CHT app.</p>
          <div className="field-row">
            <TextField
              id={`${idPrefix}-due`}
              label={
                <>
                  <span className="sr-only">{context}: </span>Due after (days)
                </>
              }
              hint="0 means the same day"
              required
              short
              inputMode="numeric"
              value={value.dueInDays}
              error={errorFor(`${idPrefix}-due`)}
              onChange={(v) => onChange({ dueInDays: v })}
            />
            <TextField
              id={`${idPrefix}-open`}
              label={
                <>
                  <span className="sr-only">{context}: </span>Then stays open for (days)
                </>
              }
              hint="For example, 3"
              required
              short
              inputMode="numeric"
              value={value.openForDays}
              error={errorFor(`${idPrefix}-open`)}
              onChange={(v) => onChange({ openForDays: v })}
            />
          </div>
        </div>
      )}
    </>
  );
}
