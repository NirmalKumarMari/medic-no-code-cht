import type { LogicFlag } from '../types/logic-model';
import Citation from './Citation';

// Everything the drafting step was unsure about, with its source passage (design
// rule 7). An open ambiguity blocks approval; see ReviewPanel.

const TYPE_TEXT = { ambiguity: 'Ambiguity', missing_input: 'Missing information' } as const;

export function isOpenAmbiguity(flag: LogicFlag): boolean {
  return flag.type === 'ambiguity' && !flag.resolved;
}

export default function FlagsPanel({ flags }: { flags: LogicFlag[] }) {
  return (
    <section className="card" aria-labelledby="flags-heading">
      <h3 id="flags-heading">Questions for a person to settle</h3>
      {flags.length === 0 ? (
        <p className="hint">Nothing was flagged in this version.</p>
      ) : (
        <ul className="checks">
          {flags.map((flag, i) => (
            <li key={i} className={`check ${flag.resolved ? 'check-pass' : 'check-warning'}`}>
              <span className="check-status">{flag.resolved ? 'Settled' : 'Open'}</span>
              <div>
                <strong>{TYPE_TEXT[flag.type] ?? flag.type}</strong>
                <p>{flag.text}</p>
                <p className="citation">
                  Guideline: <Citation source={flag.source} />
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
