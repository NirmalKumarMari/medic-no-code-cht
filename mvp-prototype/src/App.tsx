import { exampleDraft } from "@vera/review-model/data/drafts";
import { randomUuid } from "@vera/review-model/data/identity";
import { useEffect, useRef, useState } from "react";
import veraLogo from "./assets/vera-logo.png";
import ChangeHistoryPanel, { type Change } from "./components/ChangeHistoryPanel";
import StatusPill from "./components/StatusPill";
import ApprovedView from "./components/ApprovedView";
import NewChange from "./components/NewChange";
import RunView from "./components/RunView";
import RequirementsForm from "./components/RequirementsForm";
import ReviewPanel from "./components/ReviewPanel";
import SignIn from "./components/SignIn";
import {
  api,
  ApiError,
  authConfig,
  completeSignIn,
  setTenant,
  signIn,
  signOut,
  type AuthConfig,
  type DraftSummary,
  type Page,
  type PipelineSummary,
  type ReviewSummary,
  type SavedDraft,
  type Session,
  type WorkflowReview,
} from "./api/client";
import { buildLogicModel } from "@vera/review-model/data/stubGenerator";
import { draftRequest } from "./data/draftRequest";
import { plainWords, runState } from "./data/status";
import type { Notice, RequirementsDraft } from "./types/draft";

type Stage = "choose" | "requirements" | "saving" | "review" | "approved";
type Tab = "changes" | "review" | "deploy" | "history" | "work" | "run";

const ROLE_LABELS: Record<string, string> = {
  program_officer: "Program officer",
  program_reviewer: "Program reviewer",
  clinician: "Clinician",
  it_deploy: "IT lead",
};

// For rehearsals: open the app with ?example to pre-fill "Enter the rules myself".
const USE_EXAMPLE = new URLSearchParams(location.search).has("example");

function formatDate(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function firstTab(groups: string[]): Tab {
  if (groups.includes("program_officer")) return "changes";
  if (groups.some((g) => g === "clinician" || g === "program_reviewer")) return "review";
  return groups.includes("it_deploy") ? "deploy" : "history";
}

export default function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [session, setSession] = useState<Session>();
  const [organization, setOrganization] = useState("");
  const [tab, setTab] = useState<Tab>("changes");
  const [returnTo, setReturnTo] = useState<Tab>("changes");
  const [historyChange, setHistoryChange] = useState<string>();
  const [stage, setStage] = useState<Stage>("choose");
  const [draft, setDraft] = useState<RequirementsDraft>();
  const [saved, setSaved] = useState<SavedDraft>();
  const [review, setReview] = useState<WorkflowReview>();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [runs, setRuns] = useState<PipelineSummary[]>([]);
  const [run, setRun] = useState<{ id: string; from: Tab }>();
  const [draftCursor, setDraftCursor] = useState<string>();
  const [reviewCursor, setReviewCursor] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [formKey, setFormKey] = useState(0);
  const operation = useRef(0);
  const saveRequest = useRef<{ signature: string; id: string }>();
  const decisionRequest = useRef<{ signature: string; id: string }>();
  const heading = useRef<HTMLHeadingElement>(null);
  const groups = session?.groups ?? [];
  const isOfficer = groups.includes("program_officer");
  const isReviewer = groups.some((g) => g === "clinician" || g === "program_reviewer");
  const isIt = groups.includes("it_deploy");
  const waitingForIt = changes.filter((c) => c.state === "deploy_review");
  const pipeline = Boolean(config?.pipeline);
  const pathwayTitle = (changeId: string) => {
    const pathwayId = changes.find((c) => c.changeId === changeId)?.pathwayId;
    return pathwayId ? plainWords(pathwayId) : "New change";
  };
  // Runs start before their first version is saved, so they are the fuller list.
  const otherChanges = pipeline ? changes.filter((c) => !runs.some((r) => r.changeId === c.changeId)) : changes;

  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
  }
  function clearSelection() {
    setSaved(undefined);
    setReview(undefined);
    setDraft(undefined);
    setNotice(undefined);
    setStage("choose");
    setFormKey((k) => k + 1);
  }
  async function loadLists() {
    const n = operation.current;
    try {
      const [d, r, c] = await Promise.all([
        api<Page<DraftSummary>>("drafts"),
        api<Page<ReviewSummary>>("reviews"),
        api<{ items: Change[] }>("changes"),
      ]);
      if (n !== operation.current) return;
      setDrafts(d.items);
      setDraftCursor(d.cursor);
      setReviews(r.items);
      setReviewCursor(r.cursor);
      setChanges(c.items);
    } catch (e) {
      if (n === operation.current) fail(e);
    }
  }
  async function open(kind: "drafts" | "reviews", changeId: string, from: Tab, fromLink = false) {
    const n = ++operation.current;
    setBusy(true);
    setError("");
    clearSelection();
    setReturnTo(from);
    setTab("work");
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
    } catch (e) {
      if (n === operation.current) {
        if (e instanceof ApiError && e.status === 404) {
          // An old link in the address bar isn't something the person did, so just clear it.
          if (!fromLink) setError("This change isn't available. Choose one from the list.");
          history.replaceState(null, "", import.meta.env.BASE_URL);
        } else fail(e);
        setTab(from);
      }
    } finally {
      if (n === operation.current) setBusy(false);
    }
  }
  function openRun(id: string, from: Tab) {
    operation.current++;
    setError("");
    clearSelection();
    setRun({ id, from });
    setTab("run");
    history.replaceState(null, "", `?run=${encodeURIComponent(id)}`);
  }
  function openChange(c: Change, from: Tab) {
    if (pipeline) {
      openRun(c.changeId, from);
      return;
    }
    if (c.state === "content_review") {
      void open("reviews", c.changeId, from);
      return;
    }
    setHistoryChange(c.changeId);
    setTab("history");
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
        const home = firstTab(s.groups);
        setTab(home);
        setReturnTo(home);
        const params = new URLSearchParams(location.search);
        const id = params.get("draft") ?? params.get("review");
        const runId = params.get("run");
        if (runId && c.pipeline) {
          void api(`pipeline/${runId}`).then(
            () => {
              setRun({ id: runId, from: home });
              setTab("run");
            },
            (e) => {
              if (e instanceof ApiError && e.status === 404)
                history.replaceState(null, "", import.meta.env.BASE_URL);
              else {
                setRun({ id: runId, from: home });
                setTab("run");
              }
            },
          );
          void loadLists();
        } else if (id)
          void open(params.has("draft") ? "drafts" : "reviews", id, home, true).then(loadLists);
        else void loadLists();
      })
      .catch(async (e) => {
        if (active) {
          // Not being signed in yet is expected, not an error to show.
          if (!(e instanceof ApiError && e.status === 401)) fail(e);
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
      setChanges([]);
      setBusy(false);
    };
    window.addEventListener("vera-unauthorized", unauthorized);
    return () => {
      active = false;
      window.removeEventListener("vera-unauthorized", unauthorized);
    };
  }, []);
  // Keep the lists current while a run moves through its steps.
  useEffect(() => {
    if (!session || !pipeline) return;
    let active = true;
    const refresh = () => {
      void loadLists();
      void api<{ items: PipelineSummary[] }>("pipeline")
        .then((p) => {
          if (active) setRuns(p.items);
        })
        .catch((e) => {
          if (active) fail(e);
        });
    };
    refresh();
    // Other screens only need the lists once, for example to offer finished pathways.
    const timer = ["changes", "review", "deploy"].includes(tab) ? setInterval(refresh, 5000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
    // loadLists only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, pipeline, tab, organization]);
  useEffect(() => {
    document.title = "Vera";
    heading.current?.focus();
  }, [stage, tab]);
  async function handleGenerate(d: RequirementsDraft) {
    const n = ++operation.current;
    setBusy(true);
    setError("");
    setDraft(d);
    setStage("saving");
    if (pipeline) {
      try {
        const body = {
          pathway: d.pathway.trim(),
          requestText: draftRequest(buildLogicModel(d, 1)),
        };
        const signature = JSON.stringify(body);
        if (saveRequest.current?.signature !== signature)
          saveRequest.current = { signature, id: randomUuid() };
        const started = await api<{ changeId: string }>("pipeline", {
          ...body,
          requestId: saveRequest.current.id,
        });
        if (n === operation.current) openRun(started.changeId, "changes");
      } catch (e) {
        if (n === operation.current) {
          fail(e);
          setStage("requirements");
          setFormKey((k) => k + 1);
        }
      } finally {
        setBusy(false);
      }
      return;
    }
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
      history.replaceState(null, "", `?draft=${encodeURIComponent(item.changeId)}`);
      await loadLists();
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
          title: "Sent back",
          lines: ["Your note is saved with this version."],
        });
      await loadLists();
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
    setReturnTo("changes");
    setTab("work");
    history.replaceState(null, "", import.meta.env.BASE_URL);
  }
  function goBack() {
    operation.current++;
    setError("");
    clearSelection();
    setTab(returnTo);
    history.replaceState(
      null,
      "",
      returnTo === "run" && run ? `?run=${encodeURIComponent(run.id)}` : import.meta.env.BASE_URL,
    );
  }
  function changeOrganization(value: string) {
    operation.current++;
    setTenant(value);
    setOrganization(value);
    clearSelection();
    setDrafts([]);
    setReviews([]);
    setChanges([]);
    setRuns([]);
    setError("");
    setTab(firstTab(groups));
    history.replaceState(null, "", import.meta.env.BASE_URL);
    void loadLists();
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
  const tabs: { id: Tab; label: string; count?: number }[] = [
    ...(isOfficer ? [{ id: "changes" as Tab, label: "Changes" }] : []),
    ...(isReviewer ? [{ id: "review" as Tab, label: "To review", count: reviews.length }] : []),
    ...(isIt ? [{ id: "deploy" as Tab, label: "To deploy", count: waitingForIt.length }] : []),
    { id: "history", label: "History" },
  ];
  const canEditDraft = Boolean(saved && !review && saved.authorId === session?.subject && isOfficer);
  if (!session && config?.mode === "password") return <SignIn />;
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="brand">
            <img src={veraLogo} alt="Vera" />
          </h1>
          {session && (
            <div className="workspace">
              {!(config?.mode === "demo" && config.pipeline) && (
                <span>{groups.map((g) => ROLE_LABELS[g] ?? g).join(", ")}</span>
              )}
              {session.tenants.length > 1 && (
                <>
                  <label htmlFor="organization" className="sr-only">
                    Organization
                  </label>
                  <select
                    id="organization"
                    value={organization}
                    disabled={busy}
                    onChange={(e) => changeOrganization(e.target.value)}
                  >
                    {session.tenants.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {config?.mode === "demo" && config.pipeline && (
                <>
                  <label htmlFor="persona" className="sr-only">
                    Role
                  </label>
                  <select
                    id="persona"
                    value={groups[0]}
                    onChange={(e) => {
                      sessionStorage.setItem("vera-preview-persona", e.target.value);
                      location.assign(import.meta.env.BASE_URL);
                    }}
                  >
                    <option value="program_officer">Program officer</option>
                    <option value="clinician">Clinician</option>
                    <option value="it_deploy">IT lead</option>
                  </select>
                </>
              )}
              {(config?.mode === "cognito" || config?.mode === "password") && (
                <button className="header-link" onClick={() => signOut(config)}>
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      {session && (
        <nav className="tabs" aria-label="Sections">
          <div className="tabs-inner">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className="tab"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => {
                  setHistoryChange(undefined);
                  setTab(t.id);
                }}
              >
                {t.label}
                {t.count ? <span className="tab-count">{t.count}</span> : null}
              </button>
            ))}
            {isOfficer && (
              <button
                type="button"
                className="btn btn-small tab-action"
                disabled={busy}
                onClick={startNew}
              >
                New change
              </button>
            )}
          </div>
        </nav>
      )}
      <main id="main" className="app-main" tabIndex={-1}>
        {error && (
          <div className="notice notice-error" role="alert">
            <p>{error}</p>
          </div>
        )}
        {!session ? (
          <section className="card">
            <h2>Sign in</h2>
            {config?.mode === "cognito" ? (
              <button className="btn" onClick={() => void signIn(config).catch(fail)}>
                Sign in
              </button>
            ) : (
              !error && <p role="status">Connecting…</p>
            )}
          </section>
        ) : (
          <>
            {tab === "history" && (
              <ChangeHistoryPanel
                key={`history-${organization}-${historyChange ?? ""}`}
                initialChangeId={historyChange}
              />
            )}
            {tab === "changes" && (
              <section className="card">
                <h2>Changes</h2>
                {!drafts.length && !changes.length && !runs.length && (
                  <p className="empty">No changes yet.</p>
                )}
                {(drafts.length > 0 || changes.length > 0 || runs.length > 0) && (
                  <ul className="row-list">
                    {drafts.map((d) => (
                      <li key={d.changeId}>
                        <button
                          className="row"
                          disabled={busy}
                          onClick={() => void open("drafts", d.changeId, "changes")}
                        >
                          <span className="row-title">{d.title}</span>
                          <StatusPill state="draft" />
                          <span className="row-meta">{formatDate(d.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                    {runs.map((r) => (
                      <li key={r.changeId}>
                        <button
                          className="row"
                          disabled={busy}
                          onClick={() => openRun(r.changeId, "changes")}
                        >
                          <span className="row-title">{pathwayTitle(r.changeId)}</span>
                          <StatusPill state={runState(r.status, r.state)} />
                          {r.startedAt && <span className="row-meta">{formatDate(r.startedAt)}</span>}
                        </button>
                      </li>
                    ))}
                    {otherChanges.map((c) => (
                      <li key={c.changeId}>
                        <button
                          className="row"
                          disabled={busy}
                          onClick={() => openChange(c, "changes")}
                        >
                          <span className="row-title">{plainWords(c.pathwayId)}</span>
                          <StatusPill state={c.state} />
                          <span className="row-meta">{formatDate(c.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {draftCursor && (
                  <button
                    className="btn-secondary btn-small load-more"
                    disabled={busy}
                    onClick={() => void more("drafts")}
                  >
                    Show more
                  </button>
                )}
              </section>
            )}
            {tab === "review" && (
              <section className="card">
                <h2>To review</h2>
                {!reviews.length && <p className="empty">Nothing to review right now.</p>}
                {reviews.length > 0 && (
                  <ul className="row-list">
                    {reviews.map((r) => (
                      <li key={r.changeId}>
                        <button
                          className="row"
                          disabled={busy}
                          onClick={() => void open("reviews", r.changeId, "review")}
                        >
                          <span className="row-title">{plainWords(r.pathwayId)}</span>
                          <StatusPill state={r.state} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {reviewCursor && (
                  <button
                    className="btn-secondary btn-small load-more"
                    disabled={busy}
                    onClick={() => void more("reviews")}
                  >
                    Show more
                  </button>
                )}
              </section>
            )}
            {tab === "deploy" && (
              <section className="card">
                <h2>To deploy</h2>
                {!waitingForIt.length && <p className="empty">Nothing to deploy right now.</p>}
                {waitingForIt.length > 0 && (
                  <ul className="row-list">
                    {waitingForIt.map((c) => (
                      <li key={c.changeId}>
                        <button
                          className="row"
                          disabled={busy}
                          onClick={() => openChange(c, "deploy")}
                        >
                          <span className="row-title">{plainWords(c.pathwayId)}</span>
                          <StatusPill state={c.state} />
                          <span className="row-meta">{formatDate(c.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            {tab === "run" && run && (
              <RunView
                key={run.id}
                changeId={run.id}
                title={changes.some((c) => c.changeId === run.id) ? pathwayTitle(run.id) : undefined}
                groups={groups}
                onBack={() => {
                  setTab(run.from);
                  history.replaceState(null, "", import.meta.env.BASE_URL);
                }}
                onOpenReview={() => void open("reviews", run.id, "run")}
              />
            )}
            {tab === "work" && (
              <>
                <button type="button" className="btn-link back-link" onClick={goBack}>
                  ← Back
                </button>
                <div className="page-head">
                  <h2 ref={heading} tabIndex={-1}>
                    {stage === "choose"
                      ? "New change"
                      : stage === "requirements"
                        ? saved
                          ? "Edit this change"
                          : "Enter the rules"
                        : stage === "saving"
                          ? "Saving…"
                          : stage === "approved"
                            ? "Approved"
                            : (model?.pathway.title ?? "Loading…")}
                  </h2>
                  {stage === "review" && canEditDraft && (
                    <button
                      className="btn-secondary btn-small"
                      disabled={busy}
                      onClick={() => {
                        setStage("requirements");
                        setFormKey((k) => k + 1);
                      }}
                    >
                      Edit
                    </button>
                  )}
                </div>
                {notice && (
                  <div className="notice" role="status">
                    <strong>{notice.title}</strong>
                    {notice.lines.map((l) => (
                      <p key={l}>{l}</p>
                    ))}
                  </div>
                )}
                {stage === "choose" && isOfficer && (
                  <NewChange
                    pipeline={pipeline}
                    onStarted={(id) => {
                      openRun(id, "changes");
                      void loadLists();
                    }}
                    onEnterRules={(initial) => {
                      setDraft(initial ?? (USE_EXAMPLE ? exampleDraft() : undefined));
                      setStage("requirements");
                      setFormKey((k) => k + 1);
                    }}
                  />
                )}
                {stage === "requirements" && isOfficer && (
                  <RequirementsForm
                    key={formKey}
                    initial={draft}
                    submitLabel={pipeline ? "Start" : "Save"}
                    onGenerate={(d) => void handleGenerate(d)}
                  />
                )}
                {stage === "saving" && (
                  <div className="card" role="status">
                    <div className="generating">
                      <span className="spinner" aria-hidden="true" />
                      <p>Saving and checking your rules…</p>
                    </div>
                  </div>
                )}
                {stage === "review" && model && (
                  <>
                    {review && review.historyFlags.length > 0 && (
                      <section className="card">
                        <h3>Rejected before</h3>
                        <ul className="checks">
                          {review.historyFlags.map((f) => {
                            const index = review.model.rules.findIndex((r) => r.id === f.ruleId);
                            return (
                              <li key={f.id} className="check check-warning">
                                <span className="check-status">
                                  {index === -1 ? f.ruleId : `Rule ${index + 1}`}
                                </span>
                                <p>{f.notesExcerpt}</p>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    )}
                    {review && !review.canRender ? (
                      <section className="card">
                        <div className="status-banner status-problem" role="status">
                          This version can't be shown correctly, so it can't be approved.
                        </div>
                        <details className="json-details">
                          <summary>Technical details</summary>
                          <p>{review.decisionReason}</p>
                          <pre>{JSON.stringify(review.rawSpec, null, 2)}</pre>
                        </details>
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
                        canEdit={canEditDraft}
                        canApprove={review?.canApprove ?? false}
                        canReject={review?.canReject ?? false}
                        busy={busy}
                        isDraft={!review}
                        versionLabel={saved && !review ? `Draft, version ${saved.version}` : undefined}
                        decisionReason={review?.decisionReason ?? ""}
                        validation={review?.validation}
                      />
                    )}
                  </>
                )}
                {stage === "approved" && review && (
                  <ApprovedView model={review.model} note={note} onDone={goBack} />
                )}
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
