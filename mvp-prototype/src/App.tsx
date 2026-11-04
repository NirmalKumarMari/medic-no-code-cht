import { randomUuid } from "@vera/review-model/data/identity";
import { useEffect, useRef, useState } from "react";
import ChangeHistoryPanel from "./components/ChangeHistoryPanel";
import DocumentsPanel from "./components/DocumentsPanel";
import ApprovedView from "./components/ApprovedView";
import RequirementsForm from "./components/RequirementsForm";
import ReviewPanel from "./components/ReviewPanel";
import {
  api,
  authConfig,
  completeSignIn,
  setTenant,
  signIn,
  signOut,
  type AuditEvent,
  type AuthConfig,
  type DraftSummary,
  type Page,
  type ReviewSummary,
  type SavedDraft,
  type Session,
  type WorkflowReview,
} from "./api/client";
import type { Notice, RequirementsDraft } from "./types/draft";

type Stage = "requirements" | "saving" | "review" | "approved";
export default function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [session, setSession] = useState<Session>();
  const [organization, setOrganization] = useState("");
  const [stage, setStage] = useState<Stage>("requirements");
  const [draft, setDraft] = useState<RequirementsDraft>();
  const [saved, setSaved] = useState<SavedDraft>();
  const [review, setReview] = useState<WorkflowReview>();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [draftCursor, setDraftCursor] = useState<string>();
  const [reviewCursor, setReviewCursor] = useState<string>();
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [formKey, setFormKey] = useState(0);
  const operation = useRef(0);
  const saveRequest = useRef<{ signature: string; id: string }>();
  const decisionRequest = useRef<{ signature: string; id: string }>();
  const heading = useRef<HTMLHeadingElement>(null);
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : "The operation failed.");
  }
  function clearSelection() {
    setSaved(undefined);
    setReview(undefined);
    setDraft(undefined);
    setAudit([]);
    setAuditCursor(undefined);
    setNotice(undefined);
    setStage("requirements");
    setFormKey((k) => k + 1);
  }
  async function loadLists() {
    const n = operation.current;
    try {
      const [d, r] = await Promise.all([
        api<Page<DraftSummary>>("drafts"),
        api<Page<ReviewSummary>>("reviews"),
      ]);
      if (n !== operation.current) return;
      setDrafts(d.items);
      setDraftCursor(d.cursor);
      setReviews(r.items);
      setReviewCursor(r.cursor);
    } catch (e) {
      if (n === operation.current) fail(e);
    }
  }
  async function open(kind: "drafts" | "reviews", changeId: string) {
    const n = ++operation.current;
    setBusy(true);
    setError("");
    clearSelection();
    try {
      if (kind === "drafts") {
        const item = await api<SavedDraft>(`drafts/${changeId}`);
        if (n !== operation.current) return;
        setSaved(item);
        setDraft(item.draft);
      } else {
        const item = await api<WorkflowReview>(`reviews/${changeId}`);
        if (n !== operation.current) return;
        setReview(item);
      }
      setStage("review");
      history.replaceState(
        null,
        "",
        `?${kind === "drafts" ? "draft" : "review"}=${encodeURIComponent(changeId)}`,
      );
      const events = await api<Page<AuditEvent>>(`${kind}/${changeId}/audit`);
      if (n === operation.current) {
        setAudit(events.items);
        setAuditCursor(events.cursor);
      }
    } catch (e) {
      if (n === operation.current) fail(e);
    } finally {
      if (n === operation.current) setBusy(false);
    }
  }
  useEffect(() => {
    // React StrictMode mounts effects twice; consume an OAuth code only once per document.
    let active = true;
    const init = window as Window & {
      veraSessionInit?: Promise<{ config: AuthConfig; session: Session }>;
    };
    init.veraSessionInit ??= (async () => {
      const c = await authConfig();
      await completeSignIn(c);
      return { config: c, session: await api<Session>("session") };
    })();
    init.veraSessionInit
      .then(({ config: c, session: s }) => {
        if (!active) return;
        setConfig(c);
        setSession(s);
        const tenant = s.tenants[0];
        setTenant(tenant);
        setOrganization(tenant);
        const params = new URLSearchParams(location.search);
        const id = params.get("draft") ?? params.get("review");
        if (id)
          void open(params.has("draft") ? "drafts" : "reviews", id).then(
            loadLists,
          );
        else void loadLists();
      })
      .catch(async (e) => {
        if (active) {
          fail(e);
          try {
            setConfig(await authConfig());
          } catch {
            /* Show the connection error. */
          }
        }
      });
    const unauthorized = () => {
      operation.current++;
      setSession(undefined);
      clearSelection();
      setDrafts([]);
      setReviews([]);
      setBusy(false);
    };
    window.addEventListener("vera-unauthorized", unauthorized);
    return () => {
      active = false;
      window.removeEventListener("vera-unauthorized", unauthorized);
    };
  }, []);
  useEffect(() => {
    document.title = "Vera — saved changes and review";
    heading.current?.focus();
  }, [stage]);
  async function handleGenerate(d: RequirementsDraft) {
    const n = ++operation.current;
    setBusy(true);
    setError("");
    setDraft(d);
    setStage("saving");
    const expectedVersion = saved?.version ?? 0;
    const signature = JSON.stringify({
      d,
      expectedVersion,
      changeId: saved?.changeId,
      organization,
    });
    if (saveRequest.current?.signature !== signature)
      saveRequest.current = { signature, id: randomUuid() };
    try {
      const item = await api<SavedDraft>(
        saved ? `drafts/${saved.changeId}` : "drafts",
        { draft: d, expectedVersion, requestId: saveRequest.current!.id },
        saved ? "PUT" : "POST",
      );
      if (n !== operation.current) return;
      setSaved(item);
      setDraft(item.draft);
      setReview(undefined);
      setStage("review");
      history.replaceState(
        null,
        "",
        `?draft=${encodeURIComponent(item.changeId)}`,
      );
      await loadLists();
      try {
        const events = await api<Page<AuditEvent>>(
          `drafts/${item.changeId}/audit`,
        );
        if (n === operation.current) {
          setAudit(events.items);
          setAuditCursor(events.cursor);
        }
      } catch (e) {
        // A secondary history read cannot turn a confirmed save into a failed save.
        if (n === operation.current) fail(e);
      }
    } catch (e) {
      if (n === operation.current) {
        fail(e);
        setStage("requirements");
        setFormKey((k) => k + 1);
      }
    } finally {
      if (n === operation.current) setBusy(false);
    }
  }
  async function decide(decision: "approve" | "reject", notes: string) {
    if (!review) return;
    const n = ++operation.current;
    setBusy(true);
    setError("");
    const signature = JSON.stringify({
      changeId: review.changeId,
      hash: review.snapshotHash,
      decision,
      notes,
    });
    if (decisionRequest.current?.signature !== signature)
      decisionRequest.current = { signature, id: randomUuid() };
    try {
      await api(`reviews/${review.changeId}/decisions`, {
        decision,
        notes,
        snapshotHash: review.snapshotHash,
        decisionId: decisionRequest.current!.id,
        idempotencyKey: decisionRequest.current!.id,
      });
      const updated = await api<WorkflowReview>(`reviews/${review.changeId}`);
      if (n !== operation.current) return;
      setReview(updated);
      setNote(notes);
      setStage(decision === "approve" ? "approved" : "review");
      if (decision === "reject")
        setNotice({
          tone: "info",
          title: "Rejection saved",
          lines: [
            "The decision is recorded for this exact snapshot. The workflow owns the next revision.",
          ],
        });
      await loadLists();
      const events = await api<Page<AuditEvent>>(
        `reviews/${review.changeId}/audit`,
      );
      if (n === operation.current) {
        setAudit(events.items);
        setAuditCursor(events.cursor);
      }
    } catch (e) {
      if (n === operation.current) fail(e);
    } finally {
      if (n === operation.current) setBusy(false);
    }
  }
  function startNew() {
    operation.current++;
    clearSelection();
    setError("");
    history.replaceState(null, "", import.meta.env.BASE_URL);
  }
  async function more(kind: "drafts" | "reviews") {
    setBusy(true);
    try {
      if (kind === "drafts") {
        const p = await api<Page<DraftSummary>>(
          `drafts?cursor=${encodeURIComponent(draftCursor!)}`,
        );
        setDrafts((d) => [...d, ...p.items]);
        setDraftCursor(p.cursor);
      } else {
        const p = await api<Page<ReviewSummary>>(
          `reviews?cursor=${encodeURIComponent(reviewCursor!)}`,
        );
        setReviews((r) => [...r, ...p.items]);
        setReviewCursor(p.cursor);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const model = review?.model ?? saved?.model;
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="app-header">
        <h1>Medic No-Code CHT</h1>
        <p>Saved changes and content review</p>
      </header>
      <main id="main" className="app-main" tabIndex={-1}>
        {error && (
          <div className="notice notice-error" role="alert">
            <p>{error}</p>
          </div>
        )}
        {!session ? (
          <section className="card">
            <h2>Connect to your workspace</h2>
            <p>Sign in to load saved changes.</p>
            {config?.mode === "cognito" ? (
              <button
                className="btn"
                onClick={() => void signIn(config).catch(fail)}
              >
                Sign in with Cognito
              </button>
            ) : (
              <p>
                Waiting for the review API. Start the local API for development,
                then reload this page.
              </p>
            )}
          </section>
        ) : (
          <>
            <section className="card" aria-label="Workspace">
              <p>
                {config?.mode === "demo" ? "Demo workspace · no sign-in required" : "Signed in as"} <strong>{config?.mode === "demo" ? "" : session.subject}</strong> ·{" "}
                {session.groups.join(", ")}
              </p>
              {session.storage === "local" && (
                <p className="notice">
                  Local development: drafts use DynamoDB Local and files on this
                  computer. AI generation and live workflow approvals require
                  their configured services.
                </p>
              )}
              <label htmlFor="organization">Organization</label>{" "}
              <select
                id="organization"
                value={organization}
                disabled={busy}
                onChange={(e) => {
                  operation.current++;
                  setTenant(e.target.value);
                  setOrganization(e.target.value);
                  clearSelection();
                  setDrafts([]);
                  setReviews([]);
                  setError("");
                  history.replaceState(null, "", import.meta.env.BASE_URL);
                  void loadLists();
                }}
              >
                {session.tenants.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {config?.mode === "cognito" && (
                <button className="btn-link" onClick={() => signOut(config)}>
                  Sign out
                </button>
              )}
            </section>
            <DocumentsPanel key={organization} canUpload={session.groups.includes("program_officer")} />
            <ChangeHistoryPanel key={`history-${organization}`} />
            <section className="card">
              <h2>Saved drafts</h2>
              <p>Reopen a draft to inspect it or continue editing.</p>
              {!drafts.length && <p>No saved drafts yet.</p>}
              <ul>
                {drafts.map((d) => (
                  <li key={d.changeId}>
                    <button
                      className="btn-link"
                      disabled={busy}
                      onClick={() => void open("drafts", d.changeId)}
                    >
                      {d.title} — version {d.version}
                    </button>
                  </li>
                ))}
              </ul>
              {draftCursor && (
                <button disabled={busy} onClick={() => void more("drafts")}>
                  Load more drafts
                </button>
              )}
              {session.groups.includes("program_officer") && (
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={startNew}
                >
                  Start a new change
                </button>
              )}
            </section>
            <section className="card">
              <h2>Waiting for content review</h2>
              {!reviews.length && (
                <p>No workflows are waiting for content review.</p>
              )}
              <ul>
                {reviews.map((r) => (
                  <li key={r.changeId}>
                    <button
                      className="btn-link"
                      disabled={busy}
                      onClick={() => void open("reviews", r.changeId)}
                    >
                      {r.pathwayId} — {r.changeId}
                    </button>
                  </li>
                ))}
              </ul>
              {reviewCursor && (
                <button disabled={busy} onClick={() => void more("reviews")}>
                  Load more reviews
                </button>
              )}
              <button
                className="btn-link"
                disabled={busy}
                onClick={() => void loadLists()}
              >
                Refresh lists
              </button>
            </section>
            <h2 ref={heading} tabIndex={-1}>
              {stage === "requirements"
                ? "Describe the change"
                : stage === "saving"
                  ? "Saving your draft"
                  : stage === "approved"
                    ? "Content approval recorded"
                    : "Review the saved version"}
            </h2>
            {notice && (
              <div className="notice">
                <strong>{notice.title}</strong>
                {notice.lines.map((l) => (
                  <p key={l}>{l}</p>
                ))}
              </div>
            )}
            {stage === "requirements" &&
              session.groups.includes("program_officer") && (
                <RequirementsForm
                  key={formKey}
                  initial={draft}
                  onGenerate={(d) => void handleGenerate(d)}
                />
              )}
            {stage === "saving" && (
              <div className="card" role="status">
                Saving the version and running deterministic checks…
              </div>
            )}
            {stage === "review" && model && (
              <>
                {saved && !review && (
                  <section className="card">
                    <h3>Draft saved — version {saved.version}</h3>
                    <p>
                      Saved drafts can be reopened after a refresh. Content
                      approval becomes available when the pipeline registers the
                      snapshot and opens its review gate.
                    </p>
                    <p>
                      Draft integrity hash:{" "}
                      <code className="snapshot-hash">{saved.contentHash}</code>
                    </p>
                    {saved.authorId === session.subject &&
                      session.groups.includes("program_officer") && (
                        <button
                          className="btn-secondary"
                          disabled={busy}
                          onClick={() => {
                            setStage("requirements");
                            setFormKey((k) => k + 1);
                          }}
                        >
                          Edit and save a new version
                        </button>
                      )}
                  </section>
                )}
                {review && review.historyFlags.length > 0 && (
                  <section className="card">
                    <h3>Previously rejected rule matches</h3>
                    <ul>
                      {review.historyFlags.map((f) => (
                        <li key={f.id}>
                          <strong>
                            {f.severity}: {f.ruleId}
                          </strong>{" "}
                          — {f.notesExcerpt} (prior change: {f.sourceChangeId})
                        </li>
                      ))}
                    </ul>
                    <p>
                      These flags are advisory and remain part of the review
                      record.
                    </p>
                  </section>
                )}
                {review && !review.canRender ? (
                  <section className="card">
                    <h3>Snapshot requires a supported review view</h3>
                    <p>{review.decisionReason}</p>
                    <pre>{JSON.stringify(review.rawSpec, null, 2)}</pre>
                  </section>
                ) : (
                  <ReviewPanel
                    key={model.snapshotId}
                    model={model}
                    checks={review?.checks ?? saved!.checks}
                    onApprove={(n) => void decide("approve", n)}
                    onReject={(n) => void decide("reject", n)}
                    onFix={() => {
                      if (!review) setStage("requirements");
                    }}
                    canEdit={!review && saved?.authorId === session.subject}
                    canApprove={review?.canApprove ?? false}
                    canReject={review?.canReject ?? false}
                    busy={busy}
                    decisionReason={
                      review?.decisionReason ??
                      "This is a saved authoring draft. A workflow review gate is required for approval."
                    }
                  />
                )}
                {review && (
                  <section className="card">
                    <h3>Persisted decisions</h3>
                    {!review.decisions.length && <p>No decisions recorded.</p>}
                    <ul>
                      {review.decisions.map((d) => (
                        <li key={d.decisionId}>
                          {d.decision} by {d.actorId} at {d.createdAt}
                          {d.notes && <p>{d.notes}</p>}
                        </li>
                      ))}
                    </ul>
                    <details>
                      <summary>Stored validation report</summary>
                      <pre>{JSON.stringify(review.validation, null, 2)}</pre>
                    </details>
                  </section>
                )}
              </>
            )}
            {stage === "approved" && review && (
              <ApprovedView
                model={review.model}
                note={note}
                onStartOver={startNew}
              />
            )}
            {audit.length > 0 && (
              <section className="card">
                <h3>Saved activity</h3>
                <ol>
                  {audit.map((e, i) => (
                    <li key={`${e.createdAt}-${i}`}>
                      {e.type} — {e.actorId} — {e.createdAt}
                      {e.version && ` — version ${e.version}`}
                    </li>
                  ))}
                </ol>
                {auditCursor && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      const kind = review ? "reviews" : "drafts";
                      const id = review?.changeId ?? saved!.changeId;
                      setBusy(true);
                      void api<Page<AuditEvent>>(
                        `${kind}/${id}/audit?cursor=${encodeURIComponent(auditCursor)}`,
                      )
                        .then((p) => {
                          setAudit((a) => [...a, ...p.items]);
                          setAuditCursor(p.cursor);
                        })
                        .catch(fail)
                        .finally(() => setBusy(false));
                    }}
                  >
                    Load more activity
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
