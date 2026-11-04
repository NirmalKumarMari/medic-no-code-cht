import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CallbackDispatcher, WorkflowRepository, canonicalJson, sha256, snapshotHash,
  type ArtifactRef, type CallbackPayload, type CallbackTransport, type HumanContext, type SnapshotBundle, type Tables } from '../src/index.js';

export const tenantId = 'synthetic-test';
export const author: HumanContext = { tenantId, subject: 'synthetic-author', groups: ['program_officer'] };
export const clinician: HumanContext = { tenantId, subject: 'synthetic-clinician', groups: ['clinician'] };
export const it: HumanContext = { tenantId, subject: 'synthetic-it', groups: ['it_deploy'] };
export const reviewer: HumanContext = { tenantId, subject: 'synthetic-reviewer', groups: ['program_reviewer'] };
const evidenceFixture: ArtifactRef = { bucket: 'synthetic-artifact-fixture', key: 'reports/synthetic-evidence.json', versionId: 'fixture-version', sha256: sha256('synthetic evidence'), contentType: 'application/json' };
export const bundle: SnapshotBundle = { schemaVersion: '1', baselineRevision: 'fixture-baseline-v1',
  spec: { title: 'Synthetic configuration test - not a clinical pathway', fields: [{ id: 'sample', type: 'text' }], rules: [{ id: 'fixture-rule', when: { input: 'sample', eq: 'synthetic' }, then: { action: 'record_synthetic_sample' } }] },
  evidenceVersions: [{ sourceId: 'synthetic-source', version: 'fixture-v1', sha256: sha256('synthetic source'), sourceS3Ref: evidenceFixture }],
  retrievalEvidenceRefs: [evidenceFixture],
  goldenCaseVersion: 'fixture-golden-v1', compilerVersion: 'fixture-compiler-v1', toolchainImageDigest: `sha256:${'a'.repeat(64)}` };

export class FakeCallback implements CallbackTransport {
  completed = new Set<string>(); calls = 0; failBeforeSend = false; loseResponse = false;
  async sendSuccess(_token: string, payload: CallbackPayload): Promise<void> {
    this.calls++;
    if (this.failBeforeSend) { const error = new Error('simulated transport failure'); error.name = 'NetworkError'; throw error; }
    this.completed.add(canonicalJson(payload));
    if (this.loseResponse) { const error = new Error('simulated lost response'); error.name = 'TaskDoesNotExist'; throw error; }
  }
  async hasCompleted(_arn: string, payload: CallbackPayload): Promise<boolean> { return this.completed.has(canonicalJson(payload)); }
}

export async function createTables(prefix: string): Promise<{ client: DynamoDBDocumentClient; tables: Tables }> {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:18000';
  assert.match(endpoint, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Integration tests only use a local DynamoDB endpoint');
  const low = new DynamoDBClient({ region: 'us-west-2', endpoint, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' } });
  const tables = { changes: `${prefix}-Changes`, approvals: `${prefix}-Approvals`, audit: `${prefix}-Audit`, tokens: `${prefix}-Tokens` };
  for (const [kind, TableName] of Object.entries(tables)) {
    const index = kind === 'changes' ? { name: 'ReviewInboxIndex', pk: 'inbox', sk: 'inboxSort', projection: 'ALL' as const } : kind === 'tokens' ? { name: 'CallbackDeliveryIndex', pk: 'callbackQueue', sk: 'callbackDueAt', projection: 'KEYS_ONLY' as const } : undefined;
    await low.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'changeId', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }, ...(index ? [{ AttributeName: index.pk, AttributeType: 'S' as const }, { AttributeName: index.sk, AttributeType: 'S' as const }] : [])],
      KeySchema: [{ AttributeName: 'changeId', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      ...(index ? { GlobalSecondaryIndexes: [{ IndexName: index.name, KeySchema: [{ AttributeName: index.pk, KeyType: 'HASH' as const }, { AttributeName: index.sk, KeyType: 'RANGE' as const }], Projection: { ProjectionType: index.projection } }] } : {}) }));
    await waitUntilTableExists({ client: low, maxWaitTime: 30, minDelay: 1, maxDelay: 2 }, { TableName });
  }
  return { client: DynamoDBDocumentClient.from(low, { marshallOptions: { removeUndefinedValues: true } }), tables };
}

export function makeHarness(client: DynamoDBDocumentClient, tables: Tables) {
  let clock = new Date('2026-11-03T23:00:00Z'); const objects = new Map<string, string>();
  const ref = (value: unknown, prefix = 'reports'): ArtifactRef => {
    const bytes = JSON.stringify(value); const key = `${prefix}/${randomUUID()}.json`; objects.set(key, bytes);
    return { bucket: 'synthetic-artifact-fixture', key, versionId: randomUUID(), sha256: sha256(bytes), contentType: 'application/json' };
  };
  const repo = new WorkflowRepository({ client, tables, now: () => clock, verifySnapshot: async (r, b) => {
    const bytes = objects.get(r.key); assert.ok(bytes); assert.equal(sha256(bytes), r.sha256); assert.equal(snapshotHash(JSON.parse(bytes)), snapshotHash(b));
  } });
  const transport = new FakeCallback(); const dispatcher = new CallbackDispatcher(repo, transport);
  const create = async (inputBundle = bundle) => {
    const changeId = `fixture-${randomUUID()}`; const executionArn = `arn:aws:states:us-west-2:000000000000:execution:synthetic:${changeId}`;
    const worker = { tenantId, executionArn, actorId: 'synthetic-workflow' };
    const draft = await repo.createDraft(author, { changeId, pathwayId: 'synthetic-pathway', snapshotId: 'v1', executionArn, bundle: inputBundle, artifact: ref(inputBundle, 'snapshots') });
    return { changeId, hash: draft.snapshotHash, worker, draft };
  };
  const checked = async (requiresClinician = true) => {
    const f = await create(); await repo.recordValidation(f.worker, { changeId: f.changeId, snapshotHash: f.hash, passed: true, requiresClinician, openAmbiguities: 0, report: ref({ fixture: 'validation' }) }); return f;
  };
  const open = async (f: Awaited<ReturnType<typeof create>>, gate: 'content' | 'deploy', flags: string[] = [], expectedPriorDeploymentId?: string) => {
    await repo.openApprovalWait(f.worker, { changeId: f.changeId, snapshotHash: f.hash, gate, attemptId: randomUUID(), taskToken: `synthetic-token-${randomUUID()}`,
      expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(), ...(gate === 'deploy' ? { targetId: 'synthetic-cht', expectedPriorDeploymentId, historyFlagIds: flags } : {}) });
  };
  const decide = async (f: Awaited<ReturnType<typeof create>>, gate: 'content' | 'deploy', person = gate === 'content' ? clinician : it, extra: Record<string, unknown> = {}) => {
    const input = { changeId: f.changeId, snapshotHash: f.hash, gate, decisionId: randomUUID(), idempotencyKey: randomUUID(), decision: 'approve' as const, ...extra };
    const result = await repo.recordDecision(person, input); return { result, input };
  };
  const dispatch = async (f: Awaited<ReturnType<typeof create>>) => {
    const row = await repo.getChange({ tenantId }, f.changeId); return dispatcher.dispatchOne(tenantId, f.changeId, row.activeWaitSk);
  };
  const approved = async () => { const f = await checked(); await open(f, 'content'); await decide(f, 'content'); assert.equal(await dispatch(f), 'delivered'); return f; };
  const build = async (f: Awaited<ReturnType<typeof create>>, kind: 'release' | 'preview' = 'release', overrides: Record<string, unknown> = {}) => {
    const buildId = randomUUID(); const artifacts = ref({ fixture: 'build', buildId }, 'builds');
    await repo.recordBuild(f.worker, { changeId: f.changeId, snapshotHash: f.hash, buildId, buildKind: kind,
      compilerVersion: bundle.compilerVersion, toolchainImageDigest: bundle.toolchainImageDigest,
      artifacts, artifactDigest: artifacts.sha256, diff: ref({ fixture: 'diff' }), ...overrides }); return buildId;
  };
  const testResult = async (f: Awaited<ReturnType<typeof create>>, buildId: string, passed = true) => {
    await repo.recordTestResult(f.worker, { changeId: f.changeId, snapshotHash: f.hash, buildId, attemptId: randomUUID(), report: ref({ fixture: 'harness' }),
      summary: { passed, branchCount: 4, coveredBranches: passed ? 4 : 3, goldenCaseCount: 12, passedGoldenCases: 12, errorCount: passed ? 0 : 1 } });
  };
  const tested = async () => { const f = await approved(); const buildId = await build(f); await testResult(f, buildId); return { ...f, buildId }; };
  return { repo, ref, create, checked, open, decide, dispatch, approved, build, testResult, tested, transport, dispatcher,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
