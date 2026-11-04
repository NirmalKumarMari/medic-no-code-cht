import { capitalise } from '../data/describe';
import type { LogicModel } from '../types/logic-model';
import { modelLabel } from '../types/logic-model';
import DecisionTable from './DecisionTable';

// Confirmation screen. Also shows, in plain words, what the full system would
// do next (design doc section 6, states 6 to 10). None of that is built here.

const NEXT_STEPS = [
  { title: 'Content approved', detail: 'The exact version you reviewed is locked.', done: true },
  { title: 'Build', detail: 'Code, not AI, turns the approved logic into CHT forms and tasks.', done: false },
  {
    title: 'Test',
    detail: 'Made-up test patients are run through the built app to prove each rule gives the expected outcome.',
    done: false,
  },
  { title: 'Publish', detail: 'A final sign-off, then the update is uploaded to CHT.', done: false },
  { title: 'Sync', detail: "Health workers' phones get the update the next time they connect.", done: false },
];

interface Props {
  model: LogicModel;
  note: string;
  onStartOver: () => void;
}

export default function ApprovedView({ model, note, onStartOver }: Props) {
  return (
    <div>
      <div className="banner-ok">
        {capitalise(modelLabel(model))} of <strong>{model.pathway.title}</strong> is approved.
        {note && <> Note: “{note}”</>}
      </div>

      <section className="card" aria-labelledby="next-heading">
        <h3 id="next-heading">What happens next in the full system</h3>
        <p className="hint">The content decision is saved. The workflow owns build, test and the separate deployment approval.</p>
        <ol className="pipeline">
          {NEXT_STEPS.map((step) => (
            <li key={step.title} className={step.done ? 'done' : undefined}>
              <strong>{step.title}</strong> <span className="pill">{step.done ? 'Done' : 'Pending workflow'}</span>
              <p>{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="card" aria-labelledby="approved-logic-heading">
        <h3 id="approved-logic-heading">Approved logic (snapshot {model.snapshotId})</h3>
        <DecisionTable model={model} />
      </section>

      <div className="button-bar">
        <button type="button" className="btn-secondary" onClick={onStartOver}>
          Start a new change
        </button>
      </div>
    </div>
  );
}
