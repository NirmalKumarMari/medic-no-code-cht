import type { CheckResult } from '../data/checks';

// Only what needs attention. Status is given in words and symbols, not colour
// alone. Examples are one click away so the list stays short.

const STATUS_TEXT = { pass: 'Passed', problem: 'Problem', warning: 'Check' } as const;
const STATUS_ICON = { pass: '✓', problem: '✗', warning: '!' } as const;

function Check({ result }: { result: CheckResult }) {
  return (
    <li className={`check check-${result.status}`}>
      <span className="check-status">
        <span aria-hidden="true">{STATUS_ICON[result.status]} </span>
        {STATUS_TEXT[result.status]}
        <span className="sr-only">:</span>
      </span>
      <div>
        <strong>{result.title}</strong>
        <p>{result.summary}</p>
        {result.details.length > 0 && (
          <details open={result.status === 'problem'}>
            <summary>{result.status === 'problem' ? 'Details' : 'Show details'}</summary>
            <ul className="check-details">
              {result.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}

export default function ChecksPanel({ results }: { results: CheckResult[] }) {
  const attention = results.filter((r) => r.status !== 'pass');
  if (!attention.length) return null;
  return (
    <section className="card" aria-labelledby="checks-heading">
      <h3 id="checks-heading">To check</h3>
      <ul className="checks">
        {attention.map((r) => (
          <Check key={r.id} result={r} />
        ))}
      </ul>
    </section>
  );
}
