import { createHash } from 'node:crypto';
import { z } from 'zod';
import { artifactRefSchema, type ArtifactRef } from '@vera/artifact-storage/contracts';

export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
// Shared storage contract; re-exported here to preserve the workflow package API.
export { artifactRefSchema };
export type { ArtifactRef };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema),
  z.record(z.string(), jsonSchema),
]));
export const snapshotBundleSchema = z.object({
  schemaVersion: z.string().min(1), baselineRevision: z.string().min(1),
  spec: z.record(z.string(), jsonSchema),
  evidenceVersions: z.array(z.object({ sourceId: idSchema, version: z.string().min(1), sha256: digestSchema,
    sourceS3Ref: artifactRefSchema }).strict()).min(1),
  // Legacy field name retained so source binding does not require a hash-format migration.
  // References now capture full guideline/primer text supplied directly in prompts.
  retrievalEvidenceRefs: z.array(artifactRefSchema),
  goldenCaseVersion: z.string().min(1), compilerVersion: z.string().min(1),
  toolchainImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type SnapshotBundle = z.infer<typeof snapshotBundleSchema>;

// Canonical JSON: sorted UTF-16 property keys, ECMAScript number serialization,
// no undefined/non-finite values. Hash the bundle only, never its own hash or timestamps.
export function canonicalJson(value: unknown): string {
  const parsed = jsonSchema.parse(value);
  function encode(v: Json): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode(v[k]!)}`).join(',')}}`;
  }
  return encode(parsed);
}
export function sha256(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function snapshotHash(bundle: SnapshotBundle): string { return sha256(canonicalJson(snapshotBundleSchema.parse(bundle))); }

export const roles = ['program_officer', 'program_reviewer', 'clinician', 'it_deploy'] as const;
export type Role = typeof roles[number];
/** Trusted backend context. Construct from verified Cognito claims, never request JSON. */
export interface HumanContext { tenantId: string; subject: string; groups: readonly Role[] }
/** Trusted Step Functions/worker identity, not an agent-provided value. */
export interface WorkflowContext { tenantId: string; executionArn: string; actorId: string }
export type Gate = 'content' | 'deploy';
export type State = 'draft' | 'checked' | 'draft_failed' | 'content_review' | 'content_approved' |
  'build_failed' | 'built' | 'test_failed' | 'tested' | 'deploy_review' | 'deploy_approved' |
  'rejected' | 'deploying' | 'deployed';
export interface Tables { changes: string; approvals: string; audit: string; tokens: string }
export type Item = Record<string, any>;
export interface Change extends Item {
  changeId: string; sk: 'META'; tenantId: string; pathwayId: string; authorId: string;
  snapshotId: string; snapshotHash: string; executionArn: string; state: State;
  version: number; createdAt: string; updatedAt: string; buildKind: 'release';
}
export interface DecisionInput {
  changeId: string; snapshotHash: string; gate: Gate; decisionId: string;
  idempotencyKey: string; decision: 'approve' | 'reject'; notes?: string;
  acknowledgedFlagIds?: string[];
}
export interface TestSummary {
  passed: boolean; branchCount: number; coveredBranches: number;
  goldenCaseCount: number; passedGoldenCases: number; errorCount: number;
}
export interface CallbackPayload {
  changeId: string; snapshotHash: string; gate: Gate; decisionId: string;
  decision: 'approve' | 'reject'; buildId?: string; artifactDigest?: string;
}
export class WorkflowDataError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'WorkflowDataError'; }
}
export function requireData(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new WorkflowDataError(code, message);
}
export function validateContext(ctx: HumanContext | WorkflowContext): void {
  idSchema.parse(ctx.tenantId);
  if ('subject' in ctx) {
    requireData(Boolean(ctx.subject), 'UNAUTHORIZED', 'Verified human identity required');
    requireData(ctx.groups.every(g => roles.includes(g)), 'UNAUTHORIZED', 'Unknown role');
  } else {
    requireData(/^arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}:execution:[^:]+:.+$/.test(ctx.executionArn), 'INVALID_EXECUTION', 'Standard workflow execution ARN required');
    requireData(Boolean(ctx.actorId), 'UNAUTHORIZED', 'Trusted workflow actor required');
  }
}
export function hasRole(ctx: HumanContext, allowed: Role[]): void {
  validateContext(ctx);
  requireData(ctx.groups.some(g => allowed.includes(g)), 'FORBIDDEN', 'Role is not permitted for this operation');
}
export function safeDecision(row: Item): Item {
  const { changeId, sk, gate, snapshotHash, decisionId, decision, actorId, actorRole, notes, createdAt, buildId, artifactDigest, targetId, acknowledgedFlagIds, historyFlags } = row;
  return Object.fromEntries(Object.entries({ changeId, sk, gate, snapshotHash, decisionId, decision, actorId, actorRole, notes, createdAt, buildId, artifactDigest, targetId, acknowledgedFlagIds, historyFlags }).filter(([, v]) => v !== undefined));
}
