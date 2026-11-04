import type { PastDisposition } from "@vera/schemas";

/**
 * Read-only view over the append-only decision log (solution design §9).
 *
 * Per ADR-013 the history check is deterministic code, not an agent: it reads
 * rule FINGERPRINTS from the decision log and reports exact matches. There is
 * no AgentCore Memory and no AI "similar decision" path anymore — that half was
 * cut (Decisions Log #13).
 *
 * The check only ever READS. It never writes a decision (enforced by the
 * interface shape — there is no write method — and, in production, by IAM /
 * Cedar deny-by-default). Only the Step Functions decision-log-writer step
 * writes decisions.
 */

/** A past rule that matched the current snapshot by fingerprint. */
export interface DecisionLogMatch {
  fingerprint: string;
  changeId: string;
  disposition: PastDisposition;
  pathway: string;
  /** Short note recorded with the decision (e.g. a clinician rejection reason). */
  note?: string;
}

/** A read-only view of the exact decision log, keyed by rule fingerprint. */
export interface DecisionLog {
  /**
   * Return every past decision whose rule fingerprint exactly matches one of
   * the supplied fingerprints. Deterministic; no model involved.
   */
  findByFingerprints(fingerprints: string[], tenant: string): Promise<DecisionLogMatch[]>;
}

/* ----------------------------- Stub ----------------------------- */

/** In-memory decision log stub for building/testing with no AWS. */
export class StubDecisionLog implements DecisionLog {
  constructor(private readonly records: DecisionLogMatch[] = []) {}

  async findByFingerprints(fingerprints: string[], _tenant: string): Promise<DecisionLogMatch[]> {
    const set = new Set(fingerprints);
    return this.records.filter((r) => set.has(r.fingerprint));
  }
}
