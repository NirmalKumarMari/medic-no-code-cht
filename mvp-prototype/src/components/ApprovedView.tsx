import type { LogicModel } from '../types/logic-model';

// Confirmation: what was decided, and the one thing that happens next.

interface Props {
  model: LogicModel;
  note: string;
  onDone: () => void;
}

export default function ApprovedView({ model, note, onDone }: Props) {
  return (
    <section className="card">
      <div className="status-banner status-ok" role="status">
        <span>
          You approved <strong>{model.pathway.title}</strong>.
        </span>
      </div>
      {note && <p>Your note: {note}</p>}
      <p>Next, it will be built and tested, then sent to IT for approval to deploy.</p>
      <div className="button-bar">
        <button type="button" className="btn" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}
