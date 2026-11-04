import type { PastDisposition } from "@vera/schemas";

/**
 * Read-only views over the two decision stores (solution design §9).
 *
 *  - DecisionLog  -> DynamoDB + S3, the exact, append-only source of truth.
 *                    History Check reads rule FINGERPRINTS for exact matches.
 *  - DecisionMemory -> AgentCore Memory, plain-language summaries of past
 *                      approvals/rejections. History Check reads SIMILAR
 *                      decisions to narrate.
 *
 * CRITICAL: the History Check agent only ever READS these. It never writes a
 * decision or a memory (enforced by the interface shape — there is no write
 * method — and, in production, by AgentCore Policy deny-by-default). Only code
 * (the Step Functions memory-writer step) writes them.
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

/** A similar (not exact) past decision surfaced from memory. */
export interface MemoryRecord {
  changeId: string;
  pathway: string;
  disposition: PastDisposition;
  /** Plain-language summary written by code, read by the agent. */
  summary: string;
}

/** A read-only view of AgentCore Memory (long-term decision summaries). */
export interface DecisionMemory {
  /**
   * Return plain-language summaries of past decisions relevant to a pathway.
   * The agent narrates these into advisory `similar_decision` flags.
   */
  recall(pathway: string, tenant: string, limit?: number): Promise<MemoryRecord[]>;
}

/* ----------------------------- Stubs ----------------------------- */

/** In-memory decision log stub for building/testing with no AWS. */
export class StubDecisionLog implements DecisionLog {
  constructor(private readonly records: DecisionLogMatch[] = []) {}

  async findByFingerprints(fingerprints: string[], _tenant: string): Promise<DecisionLogMatch[]> {
    const set = new Set(fingerprints);
    return this.records.filter((r) => set.has(r.fingerprint));
  }
}

/** In-memory decision memory stub. */
export class StubDecisionMemory implements DecisionMemory {
  constructor(private readonly records: MemoryRecord[] = []) {}

  async recall(pathway: string, _tenant: string, limit = 10): Promise<MemoryRecord[]> {
    const p = pathway.toLowerCase();
    return this.records
      .filter((r) => r.pathway.toLowerCase() === p)
      .slice(0, limit);
  }
}
