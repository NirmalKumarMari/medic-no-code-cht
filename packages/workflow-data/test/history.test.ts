import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, test } from 'node:test';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { fingerprintRules, type HumanContext, type SnapshotBundle } from '../src/index.js';
import { author, bundle, clinician, createTables, it, makeHarness } from './harness.js';
let h: ReturnType<typeof makeHarness>;
before(async () => { const { client, tables } = await createTables(`vera-history-${Date.now()}`); h = makeHarness(client, tables); });
const rule = { id: 'fixture-rule', when: { all: [{ input: 'fixture_flag', eq: 'yes' }, { input: 'fixture_group', eq: 'a' }] }, then: { action: 'fixture_follow_up' }, followUp: { dueInDays: 1 } };
const withRules = (action = 'fixture_follow_up'): SnapshotBundle => ({ ...bundle, spec: { ...bundle.spec, rules: [{ ...rule, then: { action } }] } });
async function draft(action: string, pathwayId = 'synthetic-pathway', person: HumanContext = author) {
  const changeId = `fixture-${randomUUID()}`, b = withRules(action);
  const worker = { tenantId: person.tenantId, executionArn: `arn:aws:states:us-west-2:000000000000:execution:synthetic:${changeId}`, actorId: 'synthetic-workflow' };
  const row = await h.repo.createDraft(person, { changeId, pathwayId, snapshotId: 'v1', executionArn: worker.executionArn, bundle: b, artifact: h.ref(b, 'snapshots') });
  await h.repo.recordValidation(worker, { changeId, snapshotHash: row.snapshotHash, passed: true, requiresClinician: true, openAmbiguities: 0, report: h.ref({ fixture: 'validation' }) });
  return { changeId, hash: row.snapshotHash, worker, draft: row };
}
async function reject(action: string) {
  const f = await draft(action); await h.open(f, 'content');
  const decision = await h.decide(f, 'content', clinician, { decision: 'reject', notes: 'Synthetic rejection for exact-history testing; not a clinical recommendation.' });
  return { ...f, decision };
}
test('fingerprint ignores IDs/citations/object order, sorts all/any conditions and binds follow-up meaning', () => {
  const first = fingerprintRules({ rules: [rule] })[0]!.fingerprint;
  assert.equal(first, fingerprintRules({ rules: [{ ...rule, id: 'renamed', source: { page: 2 }, when: { all: rule.when.all.slice().reverse() } }] })[0]!.fingerprint);
  assert.notEqual(first, fingerprintRules({ rules: [{ ...rule, followUp: { dueInDays: 2 } }] })[0]!.fingerprint);
  assert.notEqual(first, fingerprintRules({ rules: [{ ...rule, then: { action: 'different' } }] })[0]!.fingerprint);
});
test('rejection and materialized fingerprint index commit atomically; replay is idempotent', async () => {
  const f = await reject('fixture-index'); await h.repo.recordDecision(clinician, f.decision.input);
  const fingerprint = fingerprintRules(withRules('fixture-index').spec)[0]!.fingerprint;
  const rows = await h.repo.client.send(new QueryCommand({ TableName: h.repo.tables.approvals, ConsistentRead: true,
    KeyConditionExpression: 'changeId = :key', ExpressionAttributeValues: { ':key': `HISTORY#${author.tenantId}#synthetic-pathway#${fingerprint}` } }));
  assert.equal(rows.Items?.length, 1); assert.equal(rows.Items![0]!.sourceChangeId, f.changeId);
  assert.equal((await h.repo.listDecisions(author, f.changeId)).length, 1);
});
test('exact rejected rule surfaces a high-severity content flag without auto-blocking human approval', async () => {
  const prior = await reject('fixture-advisory'); const f = await draft('fixture-advisory');
  const flags = await h.repo.checkRuleHistory(f.worker, f.changeId, f.hash);
  assert.equal(flags.length, 1); assert.equal(flags[0]!.advisory, true); assert.equal(flags[0]!.severity, 'high'); assert.equal(flags[0]!.sourceChangeId, prior.changeId);
  assert.equal((await h.repo.getChange(author, f.changeId)).state, 'checked');
  await h.open(f, 'content'); const decision = await h.decide(f, 'content');
  assert.equal(decision.result.decision, 'approve'); assert.equal(decision.result.historyFlags[0].decisionId, prior.decision.result.decisionId);
});
test('history is isolated by tenant/pathway and ignores a different structural action', async () => {
  await reject('fixture-scope');
  for (const f of [await draft('fixture-scope', 'different-pathway'), await draft('fixture-different'), await draft('fixture-scope', 'synthetic-pathway', { ...author, tenantId: 'different-tenant' })])
    assert.deepEqual(await h.repo.checkRuleHistory(f.worker, f.changeId, f.hash), []);
});
test('content approvals and IT deployment rejections never create rejected-clinical-rule history', async () => {
  const f = await draft('fixture-it-only'); await h.open(f, 'content'); await h.decide(f, 'content'); await h.dispatch(f);
  const buildId = await h.build(f); await h.testResult(f, buildId); await h.open(f, 'deploy');
  await h.decide(f, 'deploy', it, { decision: 'reject', notes: 'Synthetic environment unavailable, not a rule rejection.' });
  const next = await draft('fixture-it-only'); assert.deepEqual(await h.repo.checkRuleHistory(next.worker, next.changeId, next.hash), []);
});
test('losing concurrent rejection leaves no index entry without a committed decision', async () => {
  const f = await draft('fixture-race'); await h.open(f, 'content');
  const results = await Promise.allSettled([h.decide(f, 'content'), h.decide(f, 'content', { ...clinician, subject: 'another-reviewer' }, { decision: 'reject', notes: 'Synthetic concurrent rejection' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const [decision] = await h.repo.listDecisions(author, f.changeId); const next = await draft('fixture-race');
  const flags = await h.repo.checkRuleHistory(next.worker, next.changeId, next.hash);
  assert.equal(flags.length, decision!.decision === 'reject' ? 1 : 0);
});
test('malformed rules, duplicate IDs and snapshots beyond atomic bound are rejected', () => {
  for (const rules of [[{ id: 'missing-structure' }], [rule, rule], Array.from({ length: 81 }, (_, i) => ({ ...rule, id: `r${i}` }))]) assert.throws(() => fingerprintRules({ rules }));
});

test('a clinical snapshot without rules cannot pass validation and silently skip history checking', async () => {
  const f = await h.create({ ...bundle, spec: { title: 'Synthetic incomplete draft', rules: [] } });
  await assert.rejects(h.repo.recordValidation(f.worker, { changeId: f.changeId, snapshotHash: f.hash, passed: true, requiresClinician: true, openAmbiguities: 0, report: h.ref({}) }), (e: any) => e.code === 'MISSING_RULES');
  assert.equal((await h.repo.getChange(author, f.changeId)).state, 'draft');
});

test('action-array order is preserved even when a parameter happens to be named all', () => {
  const a = fingerprintRules({ rules: [{ ...rule, then: { action: 'ordered_fixture', all: ['first', 'second'] } }] })[0]!.fingerprint;
  const b = fingerprintRules({ rules: [{ ...rule, then: { action: 'ordered_fixture', all: ['second', 'first'] } }] })[0]!.fingerprint;
  assert.notEqual(a, b);
});
