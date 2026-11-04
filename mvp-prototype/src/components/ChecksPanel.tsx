import type { CheckResult } from '../data/checks';

// Results of the deterministic checks. Status is given in words and symbols,
// not colour alone.

const STATUS_TEXT = { pass: 'Passed', problem: 'Problem', warning: 'Warning' } as const;
const STATUS_ICON = { pass: '✓', problem: '✗', warning: '!' } as const;

export default function ChecksPanel({ results }: { results: CheckResult[] }) {
  const problems = results.filter((r) => r.status === 'problem').length;
  const warnings = results.filter((r) => r.status === 'warning').length;
  const passed = results.length - problems - warnings;

  return (
    <section className="card" aria-labelledby="checks-heading">
      <h3 id="checks-heading">Automatic checks</h3>
      <p className="hint">
        These checks are plain code, not AI, and run on every version: {passed} passed,{' '}
        {problems} {problems === 1 ? 'problem' : 'problems'}, {warnings} {warnings === 1 ? 'warning' : 'warnings'}.
      </p>
      <ul className="checks">
        {results.map((r) => (
          <li key={r.id} className={`check check-${r.status}`}>
            <span className="check-status">
              <span aria-hidden="true">{STATUS_ICON[r.status]} </span>
              {STATUS_TEXT[r.status]}
              <span className="sr-only">:</span>
            </span>
            <div>
              <strong>{r.title}</strong>
              <p>{r.summary}</p>
              {r.details.length > 0 && (
                <ul className="check-details">
                  {r.details.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
