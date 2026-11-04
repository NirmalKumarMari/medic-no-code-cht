import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, test } from 'node:test';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { WorkflowRepository, snapshotHash, type WorkflowDataError } from '../src/index.js';
import { author, bundle, clinician, createTables, it, makeHarness, reviewer, tenantId } from './harness.js';

let h: ReturnType<typeof makeHarness>;
before(async () => { const { client, tables } = await createTables(`vera-local-${Date.now()}`); h = makeHarness(client, tables); });
const code = (expected: string) => (error: unknown) => (error as WorkflowDataError).code === expected;

test('snapshot hash is independent of object insertion order and changes with toolchain/evidence', () => {
  assert.equal(snapshotHash(bundle), snapshotHash({ ...bundle, spec: { fields: bundle.spec.fields!, title: bundle.spec.title! } }));
  assert.notEqual(snapshotHash(bundle), snapshotHash({ ...bundle, compilerVersion: 'fixture-compiler-v2' }));
  assert.notEqual(snapshotHash(bundle), snapshotHash({ ...bundle, evidenceVersions: [{ ...bundle.evidenceVersions[0]!, version: 'v2' }] }));
});
test('stored snapshot artifact is verified before any DynamoDB registration', async () => {
  const f = await h.create(); const fake = h.ref(bundle, 'snapshots'); fake.sha256 = '0'.repeat(64);
  await assert.rejects(() => h.repo.createDraft(author, { changeId: randomUUID(), pathwayId: 'fixture', snapshotId: 'v1', executionArn: f.worker.executionArn, bundle, artifact: fake }));
});
test('same snapshot and ID cannot silently overwrite immutable version or change metadata', async () => {
  const f = await h.create();
  await assert.rejects(() => h.repo.createDraft(author, { changeId: f.changeId, pathwayId: 'synthetic-pathway', snapshotId: 'v1', executionArn: f.worker.executionArn, bundle, artifact: h.ref(bundle, 'snapshots') }), code('CONFLICT'));
  assert.equal((await h.repo.getChange(author, f.changeId)).version, 1);
});
test('cross-tenant change and audit reads are denied', async () => {
  const f = await h.create();
  await assert.rejects(() => h.repo.getChange({ tenantId: 'other-tenant' }, f.changeId), code('NOT_FOUND'));
  await assert.rejects(() => h.repo.listAudit({ tenantId: 'other-tenant' }, f.changeId), code('NOT_FOUND'));
});
test('an agent-like principal cannot author human decisions', async () => {
  const f = await h.checked(); await h.open(f, 'content');
  await assert.rejects(() => h.decide(f, 'content', { tenantId, subject: 'synthetic-agent', groups: [] }), code('FORBIDDEN'));
});
test('open ambiguity blocks review even when a caller marks validation passed', async () => {
  const f = await h.create();
  await h.repo.recordValidation(f.worker, { changeId: f.changeId, snapshotHash: f.hash, passed: true, requiresClinician: true, openAmbiguities: 1, report: h.ref({}) });
  assert.equal((await h.repo.getChange(author, f.changeId)).state, 'draft_failed');
  await assert.rejects(() => h.open(f, 'content'), code('INVALID_STATE'));
});
test('content review requires frozen retrieval evidence, not only source/version labels', async () => {
  const f = await h.create({ ...bundle, retrievalEvidenceRefs: [] });
  await h.repo.recordValidation(f.worker, { changeId: f.changeId, snapshotHash: f.hash, passed: true, requiresClinician: false, openAmbiguities: 0, report: h.ref({}) });
  await assert.rejects(() => h.open(f, 'content'), code('MISSING_EVIDENCE'));
  assert.notEqual(snapshotHash(bundle), snapshotHash({ ...bundle, retrievalEvidenceRefs: [] }));
});
test('retrieval audit indexes the exact receipt once and rejects altered or stale request IDs', async () => {
  const f = await h.create(); const requestId = randomUUID();
  const evidenceRef = { ...h.ref({ fixture: 'retrieved chunks' }), key: `reports/${f.changeId}/retrieval/v1/${requestId}.json` };
  const input = { changeId: f.changeId, snapshotId: 'v1', requestId, queryHash: 'a'.repeat(64), evidenceRef };
  await h.repo.recordRetrievalAudit(f.worker, input); await h.repo.recordRetrievalAudit(f.worker, input);
  assert.equal((await h.repo.listAudit(author, f.changeId)).items.filter(r => r.type === 'retrieval.recorded').length, 1);
  await assert.rejects(() => h.repo.recordRetrievalAudit(f.worker, { ...input, queryHash: 'b'.repeat(64) }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(() => h.repo.recordRetrievalAudit(f.worker, { ...input, snapshotId: 'v2' }), code('STALE_SNAPSHOT'));
  await assert.rejects(() => h.repo.recordRetrievalAudit({ ...f.worker, tenantId: 'other' }, input), code('NOT_FOUND'));
});
test('clinical content requires clinician and author cannot decide own content', async () => {
  const f = await h.checked(); await h.open(f, 'content');
  await assert.rejects(() => h.decide(f, 'content', reviewer), code('FORBIDDEN'));
  await assert.rejects(() => h.decide(f, 'content', { ...author, groups: ['clinician'] }), code('SEPARATION_OF_DUTIES'));
});
test('wording-only content can be decided by program reviewer', async () => {
  const f = await h.checked(false); await h.open(f, 'content'); await h.decide(f, 'content', reviewer);
  assert.equal(await h.dispatch(f), 'delivered');
});
test('a human rejection requires notes and cannot authorize a release after callback delivery', async () => {
  const f = await h.checked(); await h.open(f, 'content');
  await assert.rejects(() => h.decide(f, 'content', clinician, { decision: 'reject' }), code('MISSING_NOTES'));
  await h.decide(f, 'content', clinician, { decision: 'reject', notes: 'Synthetic unresolved logic, revise and review again' });
  await h.dispatch(f); assert.equal((await h.repo.getChange(author, f.changeId)).state, 'rejected');
  await assert.rejects(() => h.build(f), code('MISSING_CONTENT_APPROVAL'));
});
test('decision retries are idempotent and altered reuse is rejected', async () => {
  const f = await h.checked(); await h.open(f, 'content'); const first = await h.decide(f, 'content');
  const second = await h.repo.recordDecision(clinician, first.input); assert.deepEqual(second, first.result);
  await assert.rejects(() => h.repo.recordDecision(clinician, { ...first.input, decision: 'reject', notes: 'different request' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal((await h.repo.listDecisions(author, f.changeId)).length, 1); await h.dispatch(f);
});
test('competing reviewers cannot both commit a gate decision', async () => {
  const f = await h.checked(); await h.open(f, 'content');
  const results = await Promise.allSettled([h.decide(f, 'content'), h.decide(f, 'content', { ...clinician, subject: 'second-clinician' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await h.repo.listDecisions(author, f.changeId)).length, 1); await h.dispatch(f);
});
test('callback and approval wait survive repository restart; raw token is removed after delivery', async () => {
  const f = await h.checked(); await h.open(f, 'content'); const row = await h.repo.getChange(author, f.changeId);
  const restarted = new WorkflowRepository({ client: h.repo.client, tables: h.repo.tables, now: h.repo.clock, verifySnapshot: async () => { throw new Error('No artifact writes in this restarted read/decision test'); } });
  await restarted.recordDecision(clinician, { changeId: f.changeId, snapshotHash: f.hash, gate: 'content', decisionId: randomUUID(), idempotencyKey: randomUUID(), decision: 'approve' });
  assert.equal(await h.dispatch(f), 'delivered');
  const stored = await h.repo.read(h.repo.tables.tokens, f.changeId, row.activeWaitSk); assert.equal(stored?.status, 'delivered'); assert.equal(stored?.taskToken, undefined);
  assert.equal((await h.repo.getChange(author, f.changeId)).callbackPending, false);
});
test('lost callback response is reconciled against exact execution result', async () => {
  const f = await h.checked(); await h.open(f, 'content'); await h.decide(f, 'content'); h.transport.loseResponse = true;
  try { assert.equal(await h.dispatch(f), 'delivered'); } finally { h.transport.loseResponse = false; }
});
test('transient callback failure preserves the decision and retries without a second approval', async () => {
  const f = await h.checked(); await h.open(f, 'content'); await h.decide(f, 'content'); h.transport.failBeforeSend = true;
  try { assert.equal(await h.dispatch(f), 'retry'); } finally { h.transport.failBeforeSend = false; }
  assert.equal((await h.repo.listDecisions(author, f.changeId)).length, 1);
  h.advance(60_000); assert.equal(await h.dispatch(f), 'delivered');
});
test('expired tokens are rejected in code regardless of TTL deletion', async () => {
  const f = await h.checked(); await h.open(f, 'content'); h.advance(3_600_001);
  await assert.rejects(() => h.decide(f, 'content'), code('EXPIRED_TOKEN'));
});
test('revision invalidates prior approval and stale workflow/snapshot cannot advance it', async () => {
  const f = await h.approved(); const revised = { ...bundle, spec: { ...bundle.spec, title: 'Revised synthetic specification' } };
  const next = await h.repo.registerRevision(author, { changeId: f.changeId, expectedHash: f.hash, pathwayId: 'synthetic-pathway', snapshotId: 'v2',
    executionArn: f.worker.executionArn.replace(f.changeId, `revision-${randomUUID()}`), bundle: revised, artifact: h.ref(revised, 'snapshots') });
  assert.notEqual(next.snapshotHash, f.hash); assert.equal(next.contentDecisionKey, undefined);
  assert.ok(await h.repo.getSnapshot(author, f.changeId, 'v1'));
  await assert.rejects(() => h.repo.assertContentApproved(f.worker, f.changeId, f.hash), code('STALE_EXECUTION'));
});
test('revision supersedes an undecided gate; old token cannot decide or resume the new version', async () => {
  const f = await h.checked(); await h.open(f, 'content'); const old = await h.repo.getChange(author, f.changeId);
  const revised = { ...bundle, goldenCaseVersion: 'v2' };
  await h.repo.registerRevision(author, { changeId: f.changeId, expectedHash: f.hash, pathwayId: 'synthetic-pathway', snapshotId: 'v2', executionArn: f.worker.executionArn, bundle: revised, artifact: h.ref(revised, 'snapshots') });
  assert.equal((await h.repo.read(h.repo.tables.tokens, f.changeId, old.activeWaitSk))?.status, 'superseded');
  await assert.rejects(() => h.decide(f, 'content'), code('STALE_SNAPSHOT'));
});
test('release build is denied before content approval; preview never advances release state', async () => {
  const f = await h.create(); await assert.rejects(() => h.build(f), code('MISSING_CONTENT_APPROVAL'));
  await h.build(f, 'preview'); assert.equal((await h.repo.getChange(author, f.changeId)).state, 'draft');
  await assert.rejects(() => h.repo.getReleaseCandidate(f.worker, f.changeId, f.hash), code('MISSING_CONTENT_APPROVAL'));
});
test('changed compiler identity cannot reuse an approval', async () => {
  const f = await h.approved(); await assert.rejects(() => h.build(f, 'release', { compilerVersion: 'new-compiler' }), code('TOOLCHAIN_CHANGED'));
});
test('identical-input build retry preserves content decision', async () => {
  const f = await h.approved(); const before = await h.repo.getChange(author, f.changeId);
  await h.repo.recordBuildFailure(f.worker, { changeId: f.changeId, snapshotHash: f.hash, code: 'SYNTHETIC_INFRA_FAILURE' });
  await h.build(f); assert.equal((await h.repo.getChange(author, f.changeId)).contentDecisionKey, before.contentDecisionKey);
});
test('incomplete branch coverage or failed tests prevent deployment review', async () => {
  const f = await h.approved(); const id = await h.build(f); await h.testResult(f, id, false);
  assert.equal((await h.repo.getChange(author, f.changeId)).state, 'test_failed');
  await assert.rejects(() => h.open(f, 'deploy'), code('INVALID_STATE'));
});
test('deploy reviewer must be different from author and content reviewer', async () => {
  const f = await h.tested(); await h.open(f, 'deploy');
  await assert.rejects(() => h.decide(f, 'deploy', { ...clinician, groups: ['clinician', 'it_deploy'] }), code('SEPARATION_OF_DUTIES'));
  await assert.rejects(() => h.decide(f, 'deploy', { ...author, groups: ['it_deploy'] }), code('SEPARATION_OF_DUTIES'));
});
test('optional history flags are advisory but explicit IT acknowledgements are recorded', async () => {
  const f = await h.tested(); await h.open(f, 'deploy', ['history-1']);
  await assert.rejects(() => h.decide(f, 'deploy'), code('UNACKNOWLEDGED_FLAGS'));
  const result = await h.decide(f, 'deploy', it, { acknowledgedFlagIds: ['history-1'] });
  assert.deepEqual(result.result.acknowledgedFlagIds, ['history-1']); await h.dispatch(f);
});
test('release binds the exact artifact and verified deployment remains queryable for rollback', async () => {
  const f = await h.tested(); await h.open(f, 'deploy'); await h.decide(f, 'deploy'); await h.dispatch(f);
  const release = await h.repo.getReleaseCandidate(f.worker, f.changeId, f.hash); assert.equal(release.buildId, f.buildId);
  const deploymentId = randomUUID(); await h.repo.acquireDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId });
  await h.repo.completeDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId, verification: h.ref({ fixture: 'served-settings-verification' }) });
  assert.equal((await h.repo.getChange(author, f.changeId)).state, 'deployed');
  assert.equal((await h.repo.getTarget(author, 'synthetic-cht'))?.currentDeploymentId, deploymentId);
  assert.equal((await h.repo.listVerifiedReleases(author, f.changeId)).length, 1);
  const audit = await h.repo.listAudit(author, f.changeId); assert.ok(audit.items.some(e => e.type === 'deployment.verified'));
});
test('a stale target revision blocks an old deployment approval', async () => {
  const f = await h.tested(); await h.open(f, 'deploy', [], 'no-longer-current-release'); await h.decide(f, 'deploy'); await h.dispatch(f);
  await assert.rejects(() => h.repo.acquireDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId: randomUUID() }), code('STALE_TARGET'));
});
test('a revision between release lookup and deployment claim cannot deploy an old artifact against a new snapshot', async () => {
  const f = await h.tested(); const target = await h.repo.getTarget(author, 'synthetic-cht');
  await h.open(f, 'deploy', [], target?.currentDeploymentId ?? undefined); await h.decide(f, 'deploy'); await h.dispatch(f);
  const racing = new WorkflowRepository({ client: h.repo.client, tables: h.repo.tables, now: h.repo.clock,
    verifySnapshot: async () => { throw new Error('This deploy-only repository cannot register snapshots'); } });
  const lookup = racing.getReleaseCandidate.bind(racing);
  racing.getReleaseCandidate = async (...args) => {
    const release = await lookup(...args);
    const revised = { ...bundle, spec: { ...bundle.spec, title: 'Concurrent new synthetic revision' } };
    await h.repo.registerRevision(author, { changeId: f.changeId, expectedHash: f.hash, pathwayId: 'synthetic-pathway', snapshotId: 'v2',
      executionArn: f.worker.executionArn.replace(f.changeId, `revision-${randomUUID()}`), bundle: revised, artifact: h.ref(revised, 'snapshots') });
    return release;
  };
  await assert.rejects(() => racing.acquireDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId: randomUUID() }), code('STALE_EXECUTION'));
  assert.equal((await h.repo.getChange(author, f.changeId)).state, 'draft');
  assert.equal((await h.repo.getTarget(author, 'synthetic-cht'))?.deploymentInProgress, false);
});
test('two callback workers cannot deliver the same token concurrently', async () => {
  const f = await h.checked(); await h.open(f, 'content'); await h.decide(f, 'content');
  const row = await h.repo.getChange(author, f.changeId); const calls = h.transport.calls;
  const results = await Promise.all([h.dispatcher.dispatchOne(tenantId, f.changeId, row.activeWaitSk), h.dispatcher.dispatchOne(tenantId, f.changeId, row.activeWaitSk)]);
  assert.ok(results.includes('delivered')); assert.ok(results.every(r => ['delivered', 'busy'].includes(r)));
  assert.equal(h.transport.calls - calls, 1);
});
test('deployment recovery never steals an expired unresolved target lease', async () => {
  const f = await h.tested(); const target = await h.repo.getTarget(author, 'synthetic-cht');
  await h.open(f, 'deploy', [], target?.currentDeploymentId ?? undefined); await h.decide(f, 'deploy'); await h.dispatch(f);
  const deploymentId = randomUUID(); await h.repo.acquireDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId, leaseSeconds: 30 });
  h.advance(31_000);
  const next = await h.tested(); await h.open(next, 'deploy', [], target?.currentDeploymentId ?? undefined); await h.decide(next, 'deploy'); await h.dispatch(next);
  await assert.rejects(() => h.repo.acquireDeployment(next.worker, { changeId: next.changeId, snapshotHash: next.hash, deploymentId: randomUUID() }), code('TARGET_BUSY'));
  await h.repo.completeDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId, verification: h.ref({ fixture: 'reconciled target matches exact release' }) });
});
test('verified rollback releases only its owning target and permits retry of the same approved release', async () => {
  const f = await h.tested(); const target = await h.repo.getTarget(author, 'synthetic-cht');
  await h.open(f, 'deploy', [], target?.currentDeploymentId ?? undefined); await h.decide(f, 'deploy'); await h.dispatch(f);
  const deploymentId = randomUUID(); await h.repo.acquireDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId });
  await assert.rejects(() => h.repo.reconcileFailedDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId: 'wrong-owner', rollbackVerification: h.ref({}) }), code('INVALID_STATE'));
  await h.repo.reconcileFailedDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId, rollbackVerification: h.ref({ fixture: 'CHT verified restored baseline' }) });
  assert.equal((await h.repo.getTarget(author, 'synthetic-cht'))?.currentDeploymentId, target?.currentDeploymentId);
  assert.equal((await h.repo.getTarget(author, 'synthetic-cht'))?.deploymentInProgress, false);
  const retryId = randomUUID(); await h.repo.acquireDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId: retryId });
  await h.repo.completeDeployment(f.worker, { changeId: f.changeId, snapshotHash: f.hash, deploymentId: retryId, verification: h.ref({ fixture: 'retry verified' }) });
  assert.equal((await h.repo.listVerifiedReleases(author, f.changeId)).length, 1);
});
test('decision and verified-release history continues beyond the first query page', async () => {
  const f = await h.create();
  for (let i = 0; i < 105; i++) {
    await h.repo.client.send(new PutCommand({ TableName: h.repo.tables.approvals, Item: { changeId: f.changeId, sk: `CONTENT#fixture#${String(i).padStart(3, '0')}`, tenantId, decisionId: `fixture-${i}`, decision: 'reject' } }));
    await h.repo.client.send(new PutCommand({ TableName: h.repo.tables.changes, Item: { changeId: f.changeId, sk: `DEPLOY#fixture-${String(i).padStart(3, '0')}`, tenantId, status: 'verified' } }));
  }
  assert.equal((await h.repo.listDecisions(author, f.changeId)).length, 105);
  assert.equal((await h.repo.listVerifiedReleases(author, f.changeId)).length, 105);
});
test('Tokens callback index does not project raw task tokens', async () => {
  const f = await h.checked(); await h.open(f, 'content'); await h.decide(f, 'content');
  const refs = await h.dispatcher.due(tenantId);
  assert.ok(refs.every(r => Object.keys(r).sort().join(',') === 'changeId,sk')); await h.dispatch(f);
});
test('inbox and ordinary decision/audit reads do not expose callback tokens', async () => {
  const f = await h.checked(); await h.open(f, 'content');
  const result = await h.repo.listInbox({ tenantId }, 'content_review');
  assert.ok(result.items.some(row => row.changeId === f.changeId));
  const encoded = JSON.stringify({ inbox: result, audit: await h.repo.listAudit(author, f.changeId), decisions: await h.repo.listDecisions(author, f.changeId) });
  assert.ok(!encoded.includes('synthetic-token-'));
});
