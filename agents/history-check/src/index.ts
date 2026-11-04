import {
  fingerprintLogicModel,
  HISTORY_CHECK_SCHEMA_VERSION,
  type HistoryCheckResult,
  type HistoryFlag,
  type LogicModel,
} from "@vera/schemas";
import type { DecisionLog } from "./stores.js";

export * from "./stores.js";

export interface HistoryCheckInput {
  logicModel: LogicModel;
  tenant: string;
}

export interface HistoryCheckDeps {
  decisionLog: DecisionLog;
}

/**
 * History check (solution design §9, revised per ADR-013).
 *
 * DETERMINISTIC CODE, not an agent. It folds into the logic checks: it hashes
 * each rule in the snapshot and looks those fingerprints up in the append-only
 * decision log, producing ADVISORY flags for the IT deploy-approval gate. There
 * is no model call, no AgentCore Memory, and no "similar decision" narration —
 * that AI half was cut (Decisions Log #13). The exact-match half is what
 * mattered: never let a rule a clinician already REJECTED silently resurface.
 *
 * It never blocks a run, never approves, and never writes a decision. A `high`
 * severity flag (an exact match to a previously REJECTED rule) is surfaced at
 * the top of the list but still never blocks.
 */
export async function runHistoryCheck(
  input: HistoryCheckInput,
  deps: HistoryCheckDeps,
): Promise<HistoryCheckResult> {
  const flags: HistoryFlag[] = [];

  const fingerprints = fingerprintLogicModel(input.logicModel);
  const ruleByFingerprint = new Map(fingerprints.map((f) => [f.fingerprint, f.ruleId]));

  const matches = await deps.decisionLog.findByFingerprints(
    fingerprints.map((f) => f.fingerprint),
    input.tenant,
  );

  for (const m of matches) {
    const isRejected = m.disposition === "rejected";
    flags.push({
      kind: "exact_fingerprint",
      severity: isRejected ? "high" : "info",
      text: isRejected
        ? `This rule exactly matches a previously REJECTED decision (${m.changeId})` +
          (m.note ? `: ${m.note}` : ".")
        : `This rule exactly matches a prior ${m.disposition} decision (${m.changeId}).`,
      ruleId: ruleByFingerprint.get(m.fingerprint),
      pastChangeId: m.changeId,
      pastDisposition: m.disposition,
      fingerprint: m.fingerprint,
    });
  }

  // High-severity first, then warning, then info — IT sees the worst at top.
  const order = { high: 0, warning: 1, info: 2 } as const;
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    schemaVersion: HISTORY_CHECK_SCHEMA_VERSION,
    snapshotId: input.logicModel.snapshotId,
    flags,
  };
}
