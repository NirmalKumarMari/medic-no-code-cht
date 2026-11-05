import { useEffect, useState } from "react";
import { api } from "../api/client";
import { plainWords } from "../data/status";
import StatusPill from "./StatusPill";

// Read-only record of each change. What happened comes first; identifiers and
// stored records stay behind "Technical details".

export interface Change {
  changeId: string;
  pathwayId: string;
  state: string;
  snapshotHash: string;
  updatedAt: string;
}
type StoredRecord = Record<string, unknown>;
interface History {
  current: Change;
  snapshots: {
    snapshotId: string;
    snapshotHash: string;
    parentSnapshotHash: string | null;
    authorId: string;
    origin: string;
    designation: string;
    integrity: string;
  }[];
  decisions: StoredRecord[];
  events: StoredRecord[];
  builds: StoredRecord[];
  tests: StoredRecord[];
  referrals: StoredRecord[];
  requests: StoredRecord[];
  incompleteSources: string[];
}

function formatTime(value: unknown): string {
  if (typeof value !== "string") return "";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

function recordTitle(record: StoredRecord): string {
  const name = record.decision ?? record.type ?? record.event ?? record.state;
  return typeof name === "string" ? plainWords(name) : "Update";
}

export default function ChangeHistoryPanel({ initialChangeId }: { initialChangeId?: string }) {
  const [items, setItems] = useState<Change[]>([]);
  const [history, setHistory] = useState<History>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "History couldn't be loaded. Try again.");

  function open(changeId: string) {
    setBusy(true);
    setError("");
    void api<History>(`changes/${changeId}/history`)
      .then(setHistory)
      .catch(fail)
      .finally(() => setBusy(false));
  }

  useEffect(() => {
    let active = true;
    void api<{ items: Change[] }>("changes")
      .then((p) => {
        if (active) setItems(p.items);
      })
      .catch((e) => {
        if (active) fail(e);
      });
    if (initialChangeId) open(initialChangeId);
    return () => {
      active = false;
    };
    // Runs once per panel; the parent remounts it for a different change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timeline = history
    ? [...history.decisions, ...history.events, ...history.builds, ...history.tests, ...history.referrals, ...history.requests]
        .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    : [];

  return (
    <section className="card" aria-labelledby="history-heading">
      <h2 id="history-heading">History</h2>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {!items.length && !error && <p className="empty">Nothing here yet.</p>}
      {items.length > 0 && (
        <ul className="row-list">
          {items.map((c) => (
            <li key={c.changeId}>
              <button className="row" disabled={busy} onClick={() => open(c.changeId)}>
                <span className="row-title">{plainWords(c.pathwayId)}</span>
                <StatusPill state={c.state} />
                <span className="row-meta">{formatTime(c.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {history && (
        <div className="history-detail">
          <h3>{plainWords(history.current.pathwayId)}</h3>
          <p>
            Status: <StatusPill state={history.current.state} />
          </p>
          {history.incompleteSources.length > 0 && (
            <p role="alert" className="notice notice-error">
              Part of this history couldn't be loaded, so it may be incomplete.
            </p>
          )}
          {!timeline.length && <p className="empty">No activity recorded yet.</p>}
          {timeline.length > 0 && (
            <ol className="history-list">
              {timeline.map((record, i) => (
                <li key={i}>
                  <strong>{recordTitle(record)}</strong>{" "}
                  <span className="row-meta">{formatTime(record.createdAt)}</span>
                  {typeof record.notes === "string" && record.notes && <p>{record.notes}</p>}
                </li>
              ))}
            </ol>
          )}
          <details className="json-details">
            <summary>Technical details</summary>
            <p className="version-id">
              Version ID: <code>{history.current.snapshotHash}</code>
            </p>
            <pre>{JSON.stringify({ snapshots: history.snapshots, records: timeline }, null, 2)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
