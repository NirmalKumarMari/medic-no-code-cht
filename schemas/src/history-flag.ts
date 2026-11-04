import { z } from "zod";

/**
 * History check output schema (solution design §9, revised per ADR-013).
 *
 * The history check is DETERMINISTIC CODE, not an agent: an exact rule-
 * fingerprint lookup against the append-only decision log, folded into the
 * logic checks. The AI "similar decision" layer and AgentCore Memory were cut
 * (Decisions Log #13 / ADR-013), so only the exact-match kind remains.
 *
 * Its flags are ADVISORY. They never block a run; IT acknowledges each at the
 * deploy-approval gate. An exact match to a previously REJECTED rule is the
 * high-severity case.
 */
export const HISTORY_CHECK_SCHEMA_VERSION = "history-check/v1" as const;

/** How the flag was found. Only the deterministic exact match survives (ADR-013). */
export const HistoryMatchKind = z.enum([
  /** Deterministic exact fingerprint match against the DynamoDB decision log. */
  "exact_fingerprint",
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
    /** Rule fingerprint involved in the exact match. */
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
