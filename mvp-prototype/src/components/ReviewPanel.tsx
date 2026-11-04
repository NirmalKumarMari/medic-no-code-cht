import { useState } from 'react';
import type { CheckResult } from '../data/checks';
import { capitalise } from '../data/describe';
import type { LogicModel } from '../types/logic-model';
import { modelLabel } from '../types/logic-model';
import ChecksPanel from './ChecksPanel';
import DecisionTable from './DecisionTable';
import FlagsPanel, { isOpenAmbiguity } from './FlagsPanel';
import Flowchart from './Flowchart';
import { TextAreaField } from './fields';

// Review screen: automatic checks, the logic as a flowchart or table, and the
// decision. Approval is blocked while a check reports a problem or an ambiguity
// is open. Rejecting
// needs a note, which is shown on the form when the user goes back to edit.

interface Props {
  model: LogicModel;
  checks: CheckResult[];
  onApprove: (note: string) => void;
  onReject: (note: string) => void;
  onFix: () => void;
}

export default function ReviewPanel({ model, checks, onApprove, onReject, onFix }: Props) {
  const [view, setView] = useState<'flow' | 'table'>('flow');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string>();
  const hasProblems = checks.some((c) => c.status === 'problem');
  const flags = model.flags ?? [];
  const openAmbiguities = flags.filter(isOpenAmbiguity).length;
  const blocked = hasProblems || openAmbiguities > 0;
  const label = modelLabel(model);

  function reject() {
    if (!note.trim()) {
      setNoteError('Enter a note saying what needs to change');
      document.getElementById('review-note')?.focus();
      return;
    }
    onReject(note.trim());
  }

  return (
    <div>
      <p className="lead">
        {capitalise(label)} of <strong>{model.pathway.title}</strong>
        {model.guideline
          ? `, based on ${model.guideline.name}${model.guideline.version ? ` (${model.guideline.version})` : ''}`
          : ''}
        .
      </p>

      <ChecksPanel results={checks} />

      <FlagsPanel flags={flags} />

      <section className="card" aria-labelledby="logic-heading">
        <div className="card-head">
          <h3 id="logic-heading">The logic</h3>
          <div className="toggle-group" role="group" aria-label="Show the logic as">
            <button type="button" aria-pressed={view === 'flow'} onClick={() => setView('flow')}>
              Flowchart
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
              Decision table
            </button>
          </div>
        </div>
        {view === 'flow' ? <Flowchart model={model} /> : <DecisionTable model={model} />}
        <details className="json-details">
          <summary>Show the data the compiler will read (for the technical team)</summary>
          <pre role="region" aria-label="Logic model data in JSON" tabIndex={0}>
            {JSON.stringify(model, null, 2)}
          </pre>
        </details>
      </section>

      <section className="card" aria-labelledby="decision-heading">
        <h3 id="decision-heading">Your decision</h3>
        <TextAreaField
          id="review-note"
          label="Note for the record"
          hint="Optional when approving. Required when rejecting: say what needs to change."
          value={note}
          error={noteError}
          onChange={(v) => {
            setNote(v);
            if (noteError && v.trim()) setNoteError(undefined);
          }}
        />
        {model.snapshotHash && (
          <p className="snapshot-hash">
            You are deciding on exactly this snapshot: <code>{model.snapshotHash}</code>
          </p>
        )}
        {blocked && (
          <div className="notice notice-error">
            <p>
              <strong>This version cannot be approved yet.</strong>
              {hasProblems && ' Fix the problems found by the automatic checks first.'}
              {openAmbiguities > 0 &&
                ` ${openAmbiguities} ${openAmbiguities === 1 ? 'ambiguity is' : 'ambiguities are'} still open and must be settled by a person.`}
            </p>
            {hasProblems && (
              <button type="button" className="btn" onClick={onFix}>
                Edit to fix the problems
              </button>
            )}
          </div>
        )}
        <div className="button-bar">
          <button type="button" className="btn" disabled={blocked} onClick={() => onApprove(note.trim())}>
            Approve {label}
          </button>
          <button type="button" className="btn-danger" onClick={reject}>
            Reject and edit
          </button>
        </div>
      </section>
    </div>
  );
}
