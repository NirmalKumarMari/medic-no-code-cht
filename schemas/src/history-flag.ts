import { z } from "zod";

/**
 * History Check output schema (solution design §7, §9).
 *
 * The History Check agent produces ADVISORY flags only. It never blocks a run;
 * IT must acknowledge each flag at the deploy-approval gate. This schema is the
 * locked contract for those flags.
 */
export const HISTORY_CHECK_SCHEMA_VERSION = "history-check/v1" as const;

/** How the flag was found. */
export const HistoryMatchKind = z.enum([
  /** Deterministic exact fingerprint match against the DynamoDB decision log. */
  "exact_fingerprint",
  /** Similar prior decision surfaced from AgentCore Memory (narrated by the model). */
  "similar_decision",
]);
export type HistoryMatchKind = z.infer<typeof HistoryMatchKind>;

/** Advisory severity. An exact match to a REJECTED rule is the high-severity case. */
export const HistorySeverity = z.enum(["info", "warning", "high"]);
export type HistorySeverity = z.infer<typeof HistorySeverity>;

/** The disposition of the past decision this flag refers to. */
export const PastDisposition = z.enum(["approved", "rejected", "rolled_back", "unknown"]);
export type PastDisposition = z.infer<typeof PastDisposition>;

export const HistoryFlag = z
  .object({
    kind: HistoryMatchKind,
    severity: HistorySeverity,
    /** Human-readable explanation shown to IT at the deploy gate. */
    text: z.string().min(1),
    /** The rule in the current snapshot this flag concerns, when applicable. */
    ruleId: z.string().min(1).optional(),
    /** The past decision/change this matched, for audit linking. */
    pastChangeId: z.string().min(1).optional(),
    pastDisposition: PastDisposition.default("unknown"),
    /** Rule fingerprint involved in an exact match. */
    fingerprint: z.string().min(1).optional(),
  })
  .strict();
export type HistoryFlag = z.infer<typeof HistoryFlag>;

export const HistoryCheckResult = z
  .object({
    schemaVersion: z.literal(HISTORY_CHECK_SCHEMA_VERSION),
    snapshotId: z.string().min(1),
    /** Advisory flags; may be empty. NEVER a block/allow decision. */
    flags: z.array(HistoryFlag).default([]),
  })
  .strict();
export type HistoryCheckResult = z.infer<typeof HistoryCheckResult>;

export function parseHistoryCheckResult(value: unknown) {
  return HistoryCheckResult.safeParse(value);
}
