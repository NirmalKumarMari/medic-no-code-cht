import { randomUuid } from "@vera/review-model/data/identity";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, downloadRunFile, type PipelineRun } from "../api/client";
import { plainWords, runState } from "../data/status";
import { TextAreaField } from "./fields";
import StatusPill from "./StatusPill";

// One change from drafting to the finished CHT project. Shows where it is and
// the one thing the signed-in person can do next.

const STEPS = ["Drafting", "Checks", "Clinician review", "Build and test", "IT approval", "Ready to install"];

function currentStep(state?: string): number {
  switch (state) {
    case undefined:
    case "rejected":
    case "draft_failed":
      return 0;
    case "draft":
    case "checked":
      return 1;
    case "content_review":
      return 2;
    case "content_approved":
    case "built":
    case "build_failed":
    case "tested":
    case "test_failed":
      return 3;
    case "deploy_review":
    case "deploy_approved":
    case "deploying":
      return 4;
    default:
      return 5;
  }
}

const STOP_REASONS: Record<string, string> = {
  LogicChecksFailed: "The draft has a problem or an open question, so it can't go to review. Change the request and start again.",
  PreviewTestFailed: "The tests didn't pass, so nothing was released. Check the test cases and the request, then start again.",
  PreviewBuildFailed: "The CHT project couldn't be built.",
  ApprovalWaitExpired: "Nobody decided in time. Start the change again.",
  ChangePlanFailed: "The edit couldn't be planned. Reword the request and start again.",
};

export default function RunView({
  changeId,
  title,
  groups,
  onBack,
  onOpenReview,
}: {
  changeId: string;
  title?: string;
  groups: string[];
  onBack: () => void;
  onOpenReview: () => void;
}) {
  const [run, setRun] = useState<PipelineRun>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const request = useRef<{ signature: string; id: string }>();
  const isRunning = !run || run.status === "RUNNING";

  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<PipelineRun>(`pipeline/${changeId}`)
        .then((value) => {
          if (active) {
            setRun(value);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e instanceof Error ? e.message : "This change couldn't be loaded.");
        });
    void refresh();
    if (!isRunning) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [changeId, isRunning]);

  if (!run) {
    return (
      <>
        <button type="button" className="btn-link back-link" onClick={onBack}>
          ← Back
        </button>
        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : (
          <p role="status">Loading…</p>
        )}
      </>
    );
  }

  const state = runState(run.status, run.state);
  const stopped = !["RUNNING", "SUCCEEDED"].includes(run.status);
  const step = currentStep(run.state);
  const finished = run.status === "SUCCEEDED";
  const flags = run.historyFlags ?? [];
  const inReview = run.state === "content_review" && !stopped;
  const inItApproval = run.state === "deploy_review" && !stopped;
  const isIt = groups.includes("it_deploy");
  const isReviewer = groups.some((g) => g === "clinician" || g === "program_reviewer");

  async function decide(decision: "approve" | "reject") {
    if (!run?.snapshotHash || !run.buildId) return;
    setBusy(true);
    setError("");
    const body = {
      snapshotHash: run.snapshotHash,
      buildId: run.buildId,
      decision,
      notes,
      acknowledgedFlagIds: acknowledged,
    };
    const signature = JSON.stringify(body);
    if (request.current?.signature !== signature) request.current = { signature, id: randomUuid() };
    try {
      await api(`pipeline/${changeId}/release-decision`, {
        ...body,
        decisionId: request.current.id,
        idempotencyKey: request.current.id,
      });
      setRun({ ...run, state: decision === "approve" ? "deploy_approved" : "rejected" });
      setNotes("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Your decision wasn't confirmed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function download(file: "cht-project" | "release", filename: string) {
    setError("");
    try {
      await downloadRunFile(changeId, file, filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The download failed. Try again.");
    }
  }

  return (
    <>
      <button type="button" className="btn-link back-link" onClick={onBack}>
        ← Back
      </button>
      <div className="page-head">
        <h2>{run.title ?? title ?? "New change"}</h2>
        <StatusPill state={state} />
      </div>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {stopped && (
        <div className="status-banner status-problem" role="status">
          {(run.error && STOP_REASONS[run.error]) ?? "This change stopped before it finished. Start it again."}
        </div>
      )}
      {finished && (
        <div className="status-banner status-ok" role="status">
          Approved and tested. Download the project to install it on your CHT server.
        </div>
      )}
      <section className="card" aria-label="Progress">
        <ol className="run-steps">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={
                finished || index < step
                  ? "run-step run-step-done"
                  : index === step
                    ? `run-step ${stopped ? "run-step-stopped" : "run-step-current"}`
                    : "run-step"
              }
              aria-current={index === step && !finished ? "step" : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
        {run.state === "rejected" && !stopped && <p>Sent back. Drafting a new version from the reviewer's note.</p>}
        {inReview && !isReviewer && <p>Waiting for a clinician to review.</p>}
        {inItApproval && !isIt && <p>Waiting for IT approval.</p>}
        {run.testSummary && (
          <p>
            {run.testSummary.passed ? "Tests passed" : "Tests failed"}:{" "}
            {run.testSummary.coveredBranches} of {run.testSummary.branchCount} rules,{" "}
            {run.testSummary.passedGoldenCases} of {run.testSummary.goldenCaseCount} test cases.
          </p>
        )}
        {run.snapshotHash && (
          <div className="button-bar">
            <button
              type="button"
              className={inReview && isReviewer ? "btn" : "btn-secondary"}
              onClick={onOpenReview}
            >
              {inReview && isReviewer ? "Review the rules" : "View the rules"}
            </button>
          </div>
        )}
      </section>
      {inItApproval && isIt && (
        <section className="card" aria-labelledby="release-heading">
          <h3 id="release-heading">Your decision</h3>
          {flags.map((flag) => (
            <label key={flag.id} className="choice">
              <input
                type="checkbox"
                checked={acknowledged.includes(flag.id)}
                onChange={(e) =>
                  setAcknowledged(
                    e.target.checked
                      ? [...acknowledged, flag.id]
                      : acknowledged.filter((id) => id !== flag.id),
                  )
                }
              />
              Rejected before: {flag.notesExcerpt}
            </label>
          ))}
          <TextAreaField
            id="release-notes"
            label="Note"
            hint="Required if you send it back."
            value={notes}
            disabled={busy}
            onChange={setNotes}
          />
          <div className="button-bar">
            <button
              type="button"
              className="btn"
              disabled={busy || flags.length !== acknowledged.length}
              onClick={() => void decide("approve")}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={busy || !notes.trim()}
              onClick={() => void decide("reject")}
            >
              Send back
            </button>
          </div>
        </section>
      )}
      {run.chtProjectReady && (
        <section className="card">
          <div className="button-bar">
            <button
              type="button"
              className="btn"
              onClick={() => void download("cht-project", "vera-cht-project.zip")}
            >
              Download CHT project
            </button>
          </div>
        </section>
      )}
      <details className="json-details technical">
        <summary>Technical details</summary>
        <p className="version-id">
          Status: {plainWords(run.status.toLowerCase())}
          {run.stage ? `, ${run.stage}` : ""}
          {run.error ? `, ${run.error}` : ""}
        </p>
        {run.snapshotHash && (
          <p className="version-id">
            Version ID: <code>{run.snapshotHash}</code>
          </p>
        )}
        {run.buildId && (
          <p className="version-id">
            Build: <code>{run.buildId}</code>
          </p>
        )}
        {run.artifactDigest && (
          <p className="version-id">
            Digest: <code>{run.artifactDigest}</code>
          </p>
        )}
        {run.releaseReady && (
          <button
            type="button"
            className="btn-link"
            onClick={() => void download("release", "vera-preview-release.json")}
          >
            Download release record
          </button>
        )}
      </details>
    </>
  );
}
