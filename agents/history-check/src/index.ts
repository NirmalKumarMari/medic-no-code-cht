import {
  fingerprintLogicModel,
  HISTORY_CHECK_SCHEMA_VERSION,
  type HistoryCheckResult,
  type HistoryFlag,
  type LogicModel,
} from "@vera/schemas";
import type { DecisionLog, DecisionMemory, MemoryRecord } from "./stores.js";

export * from "./stores.js";

/** Bounded-autonomy limits for one history-check attempt (solution design §7). */
export const HISTORY_CHECK_LIMITS = {
  maxToolCalls: 4,
  maxModelTurns: 2,
} as const;

/**
 * Optional narration model. History Check is advisory and its exact-match path
 * is fully deterministic, so the model is optional — it only turns similar
 * memory records into readable prose. Behind an interface so it can be a
 * Bedrock Haiku client in production or omitted locally.
 */
export interface NarrationModel {
  narrate(pathway: string, records: MemoryRecord[]): Promise<string[]>;
}

export interface HistoryCheckInput {
  logicModel: LogicModel;
  tenant: string;
}

export interface HistoryCheckDeps {
  decisionLog: DecisionLog;
  decisionMemory: DecisionMemory;
  /** Optional; omit for a deterministic-only run. */
  narrationModel?: NarrationModel;
}

/**
 * History Check agent (Should-Have, §7/§9).
 *
 * Produces ADVISORY flags for the IT deploy-approval gate and NOTHING else:
 *   - exact fingerprint matches to the decision log (deterministic),
 *   - similar prior decisions from memory (narrated),
 * It never blocks a run, never approves, never writes a decision or memory.
 *
 * The caller (Step Functions) attaches these flags to the deploy-approval
 * screen; IT acknowledges each one. A `high` severity flag (exact match to a
 * previously REJECTED rule) is surfaced at the top but still never blocks.
 */
export class HistoryCheckAgent {
  constructor(private readonly deps: HistoryCheckDeps) {}

  async check(input: HistoryCheckInput): Promise<HistoryCheckResult> {
    let toolCalls = 0;
    const flags: HistoryFlag[] = [];

    const fingerprints = fingerprintLogicModel(input.logicModel);
    const ruleByFingerprint = new Map(fingerprints.map((f) => [f.fingerprint, f.ruleId]));

    // ---- Exact-match path (deterministic, one decision-log read) ----
    if (toolCalls < HISTORY_CHECK_LIMITS.maxToolCalls) {
      toolCalls += 1;
      const matches = await this.deps.decisionLog.findByFingerprints(
        fingerprints.map((f) => f.fingerprint),
        input.tenant,
      );
      for (const m of matches) {
        const ruleId = ruleByFingerprint.get(m.fingerprint);
        const isRejected = m.disposition === "rejected";
        flags.push({
          kind: "exact_fingerprint",
          severity: isRejected ? "high" : "info",
          text: isRejected
            ? `This rule exactly matches a previously REJECTED decision (${m.changeId})` +
              (m.note ? `: ${m.note}` : ".")
            : `This rule exactly matches a prior ${m.disposition} decision (${m.changeId}).`,
          ruleId,
          pastChangeId: m.changeId,
          pastDisposition: m.disposition,
          fingerprint: m.fingerprint,
        });
      }
    }

    // ---- Similar-decision path (memory read, optional narration) ----
    if (toolCalls < HISTORY_CHECK_LIMITS.maxToolCalls) {
      toolCalls += 1;
      const records = await this.deps.decisionMemory.recall(
        input.logicModel.pathway,
        input.tenant,
      );

      // Don't re-flag anything already caught as an exact match.
      const exactChangeIds = new Set(flags.map((f) => f.pastChangeId).filter(Boolean));
      const similar = records.filter((r) => !exactChangeIds.has(r.changeId));

      if (similar.length > 0) {
        const texts = this.deps.narrationModel
          ? await this.deps.narrationModel.narrate(input.logicModel.pathway, similar)
          : similar.map(defaultNarration);

        similar.forEach((r, idx) => {
          flags.push({
            kind: "similar_decision",
            severity: r.disposition === "rejected" ? "warning" : "info",
            text: texts[idx] ?? defaultNarration(r),
            pastChangeId: r.changeId,
            pastDisposition: r.disposition,
          });
        });
      }
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
}

function defaultNarration(r: MemoryRecord): string {
  return `A ${r.disposition} decision on "${r.pathway}" (${r.changeId}) may be related: ${r.summary}`;
}
