import { useEffect, useRef, useState } from "react";
import { randomUuid } from "@vera/review-model/data/identity";
import { api } from "../api/client";

type Run = {
  changeId: string; title?: string; state?: string; status: string; stage?: string; error?: string;
  snapshotHash?: string; buildId?: string; artifactDigest?: string; releaseReady?: boolean; chtProjectReady?: boolean;
  historyFlags?: { id: string; ruleId: string; notesExcerpt: string }[];
  testSummary?: { passed: boolean; coveredBranches: number; branchCount: number; passedGoldenCases: number; goldenCaseCount: number };
};
type Document = { documentId: string; filename: string; version: number };
const demoText = "Create the Synthetic triage training pathway. Ask whether the demo signal is present, as a yes/no input with ID demo_signal. If present refer urgently, otherwise give home care advice. Use exactly two rules: one conditional rule for yes and the required final otherwise rule for home care. Do not create a separate no rule. Include citations and no follow-up.";

export default function PipelinePanel({ persona, openReview }: { persona: string; openReview(id: string): void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get("run") ?? params.get("review") ?? "";
  });
  const [run, setRun] = useState<Run>();
  const [title, setTitle] = useState("Synthetic triage training");
  const [request, setRequest] = useState(demoText);
  const [source, setSource] = useState("");
  const [cases, setCases] = useState("");
  const [notes, setNotes] = useState("");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ signature: string; id: string }>();
  const inFlight = useRef(false);
  function select(id: string) {
    setSelected(id);
    setRun(undefined);
    setAcknowledged([]);
    setNotes("");
    const url = new URL(location.href);
    url.searchParams.set("run", id);
    history.replaceState(null, "", url);
  }
  async function loadDocs() {
    setDocs((await api<{ items: Document[] }>("documents")).items);
  }
  useEffect(() => { void loadDocs().catch(() => {}); }, []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const list = await api<{ items: Run[] }>("pipeline");
        if (active) setRuns(list.items);
        if (selected) {
          const current = await api<Run>(`pipeline/${selected}`);
          if (active) setRun(current);
        }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { inFlight.current = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [selected]);
  async function start() {
    setBusy(true); setError("");
    try {
      const body = { pathway: title, requestText: request,
        ...(source.startsWith("doc:") ? { documentId: source.slice(4) } : {}),
        ...(source.startsWith("baseline:") ? { baselineChangeId: source.slice(9) } : {}),
        ...(cases.trim() ? { goldenCases: JSON.parse(cases) } : {}),
      };
      const signature = JSON.stringify(body);
      if (pending.current?.signature !== signature) pending.current = { signature, id: randomUuid() };
      const response = await api<{ changeId: string }>("pipeline", { ...body, requestId: pending.current.id });
      pending.current = undefined;
      select(response.changeId);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function decide(decision: "approve" | "reject") {
    if (!run?.snapshotHash || !run.buildId) return;
    setBusy(true); setError("");
    try {
      const body = { snapshotHash: run.snapshotHash, buildId: run.buildId, decision, notes, acknowledgedFlagIds: acknowledged };
      const signature = JSON.stringify(body);
      if (pending.current?.signature !== signature) pending.current = { signature, id: randomUuid() };
      await api(`pipeline/${run.changeId}/release-decision`, { ...body, decisionId: pending.current.id, idempotencyKey: pending.current.id });
      setRun({ ...run, state: decision === "approve" ? "deploy_approved" : "rejected" });
      pending.current = undefined;
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const releaseReview = run?.state === "deploy_review";
  return <section className="card" aria-label="Agent pipeline">
    <h2>Agent pipeline preview</h2>
    <p>Follow a synthetic change from Bedrock drafting through review, tests and preview release.</p>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {persona === "program_officer" && <form onSubmit={e => { e.preventDefault(); void start(); }}>
      <p><label>Pathway <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required /></label></p>
      <p><label>Request <textarea value={request} onChange={e => setRequest(e.target.value)} maxLength={2000} required /></label></p>
      <p><label>Guideline or baseline <select value={source} onFocus={() => void loadDocs().catch(() => {})} onChange={e => setSource(e.target.value)}>
        <option value="">Synthetic triage protocol</option>
        {docs.map(d => <option key={d.documentId} value={`doc:${d.documentId}`}>{d.filename} v{d.version}</option>)}
        {runs.filter(r => r.status === "SUCCEEDED").map(r => <option key={r.changeId} value={`baseline:${r.changeId}`}>Edit baseline {r.changeId.slice(0, 8)}</option>)}
      </select></label></p>
      {source && <p><label>Synthetic golden cases as JSON <textarea value={cases} onChange={e => setCases(e.target.value)} placeholder={'[{"inputs":{"demo_signal":"yes"},"action":"refer_urgently"}]'} /></label></p>}
      <button className="btn" disabled={busy}>Start agent pipeline</button>
    </form>}
    <h3>Recent runs</h3>
    {!runs.length && <p>No pipeline runs yet.</p>}
    <ul>{runs.map(r => <li key={r.changeId}><button className="btn-link" onClick={() => select(r.changeId)}>{r.changeId.slice(0, 8)} · {r.state ?? r.status}</button></li>)}</ul>
    {selected && !run && <p>Loading pipeline run…</p>}
    {run && <article aria-live="polite">
      <h3>{run.title ?? "Pipeline run"}</h3>
      <p><strong>{run.status}</strong> · {run.stage ?? "Starting"} {run.state && `· ${run.state}`}</p>
      {run.error && <p role="alert">Pipeline stopped at {run.error}.</p>}
      {run.snapshotHash && <p><button className="btn-link" onClick={() => openReview(run.changeId)}>Open snapshot and content review</button></p>}
      {run.testSummary && <p>Tests {run.testSummary.passed ? "passed" : "failed"} · {run.testSummary.coveredBranches}/{run.testSummary.branchCount} branches · {run.testSummary.passedGoldenCases}/{run.testSummary.goldenCaseCount} golden cases</p>}
      {releaseReview && <><p>Release candidate <code>{run.buildId}</code></p><p>Artifact digest <code style={{ overflowWrap: "anywhere" }}>{run.artifactDigest}</code></p></>}
      {releaseReview && persona === "it_deploy" && <div>
        {(run.historyFlags ?? []).map(flag => <p key={flag.id}><label><input type="checkbox" checked={acknowledged.includes(flag.id)} onChange={e => setAcknowledged(e.target.checked ? [...acknowledged, flag.id] : acknowledged.filter(id => id !== flag.id))} /> Acknowledge rule {flag.ruleId}: {flag.notesExcerpt}</label></p>)}
        <p><label>Release review notes <textarea value={notes} onChange={e => setNotes(e.target.value)} /></label></p>
        <button className="btn" disabled={busy || (run.historyFlags ?? []).length !== acknowledged.length} onClick={() => void decide("approve")}>Approve preview release</button>{" "}
        <button className="btn" disabled={busy || !notes.trim()} onClick={() => void decide("reject")}>Reject preview release</button>
      </div>}
      {run.chtProjectReady && <p><a href={`${import.meta.env.BASE_URL}api/pipeline/${run.changeId}/cht-project`}>Download compiled CHT project</a></p>}
      {run.releaseReady && <p><a href={`${import.meta.env.BASE_URL}api/pipeline/${run.changeId}/release`}>Download verified preview artifact</a></p>}
    </article>}
  </section>;
}
