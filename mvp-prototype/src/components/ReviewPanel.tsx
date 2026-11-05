import { useState } from "react";
import type { CheckResult } from "../data/checks";
import type { LogicModel } from "../types/logic-model";
import ChecksPanel from "./ChecksPanel";
import DecisionTable from "./DecisionTable";
import FlagsPanel, { isOpenAmbiguity } from "./FlagsPanel";
import Flowchart from "./Flowchart";
import { TextAreaField } from "./fields";

// The reviewer's one job: read the rules and decide. A single status line says
// where things stand; anything else appears only when it needs attention.
// Approval is blocked while a check reports a problem or an ambiguity is open.

interface Props {
  model: LogicModel;
  checks: CheckResult[];
  onApprove: (note: string) => void;
  onReject: (note: string) => void;
  onFix: () => void;
  canEdit: boolean;
  canApprove: boolean;
  canReject: boolean;
  busy: boolean;
  isDraft: boolean;
  versionLabel?: string;
  decisionReason: string;
  validation?: unknown;
}

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export default function ReviewPanel({
  model,
  checks,
  onApprove,
  onReject,
  onFix,
  canEdit,
  canApprove,
  canReject,
  busy,
  isDraft,
  versionLabel,
  decisionReason,
  validation,
}: Props) {
  const [view, setView] = useState<"table" | "flow">("table");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string>();
  const problems = checks.filter((c) => c.status === "problem").length;
  const warnings = checks.filter((c) => c.status === "warning").length;
  const flags = model.flags ?? [];
  const openAmbiguities = flags.filter(isOpenAmbiguity).length;
  const blocked = problems > 0 || openAmbiguities > 0;
  const canDecide = canApprove || canReject;

  const status = problems
    ? { tone: "problem", text: `${count(problems, "problem", "problems")} to fix before this can be approved.` }
    : openAmbiguities
      ? { tone: "warning", text: `${count(openAmbiguities, "question needs", "questions need")} an answer before this can be approved.` }
      : warnings
        ? { tone: "warning", text: `${count(warnings, "item", "items")} to check.` }
        : { tone: "ok", text: "No issues found." };

  function reject() {
    if (!note.trim()) {
      setNoteError("Say what needs to change");
      document.getElementById("review-note")?.focus();
      return;
    }
    onReject(note.trim());
  }

  return (
    <div>
      {(versionLabel || model.guideline) && (
        <p className="page-sub">
          {[
            versionLabel,
            model.guideline &&
              `${model.guideline.name}${model.guideline.version ? ` (${model.guideline.version})` : ""}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      <div className={`status-banner status-${status.tone}`} role="status">
        {status.text}
        {problems > 0 && canEdit && (
          <button type="button" className="btn-link" onClick={onFix}>
            Fix now
          </button>
        )}
      </div>

      <FlagsPanel flags={flags} rules={model.rules} />

      <section className="card" aria-labelledby="logic-heading">
        <div className="card-head">
          <h3 id="logic-heading">Rules</h3>
          <div className="toggle-group" role="group" aria-label="Show the rules as">
            <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
              Table
            </button>
            <button type="button" aria-pressed={view === "flow"} onClick={() => setView("flow")}>
              Flowchart
            </button>
          </div>
        </div>
        {view === "table" ? <DecisionTable model={model} /> : <Flowchart model={model} />}
      </section>

      <ChecksPanel results={checks} />

      {canDecide && (
        <section className="card" aria-labelledby="decision-heading">
          <h3 id="decision-heading">Your decision</h3>
          <TextAreaField
            id="review-note"
            disabled={busy}
            label="Note"
            hint="Required if you send it back. Don't include patient information."
            value={note}
            error={noteError}
            onChange={(v) => {
              setNote(v);
              if (noteError && v.trim()) setNoteError(undefined);
            }}
          />
          <div className="button-bar">
            <button
              type="button"
              className="btn"
              disabled={blocked || !canApprove || busy}
              onClick={() => onApprove(note.trim())}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={!canReject || busy}
              onClick={reject}
            >
              Send back
            </button>
          </div>
          {model.snapshotHash && (
            <p className="version-id">
              Version ID: <code>{model.snapshotHash}</code>
            </p>
          )}
        </section>
      )}

      {!canDecide && !isDraft && decisionReason && (
        <p className="empty" role="status">
          {decisionReason}
        </p>
      )}

      <details className="json-details technical">
        <summary>Technical details</summary>
        {model.snapshotHash && !canDecide && (
          <p className="version-id">
            Version ID: <code>{model.snapshotHash}</code>
          </p>
        )}
        <pre role="region" aria-label="Rule data" tabIndex={0}>
          {JSON.stringify(model, null, 2)}
        </pre>
        {validation !== undefined && (
          <pre role="region" aria-label="Validation report" tabIndex={0}>
            {JSON.stringify(validation, null, 2)}
          </pre>
        )}
      </details>
    </div>
  );
}
