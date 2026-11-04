import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DescribeContinuousBackupsCommand, DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

// Real AWS storage probe, never a fabricated clinical approval or build/test result.
// Four explicitly labeled probe records are retained for audit; no real data is deleted.
assert.equal(process.env.ALLOW_AWS_SMOKE, '1', 'Set ALLOW_AWS_SMOKE=1 for the authorized sandbox storage probe');
const region = process.env.AWS_REGION ?? 'us-west-2'; const prefix = process.env.WORKFLOW_TABLE_PREFIX ?? 'vera-workflow';
const low = new DynamoDBClient({ region }); const doc = DynamoDBDocumentClient.from(low);
const names = ['Changes', 'Approvals', 'Audit', 'Tokens'].map(v => `${prefix}-${v}`);
for (const TableName of names) {
  const result = await low.send(new DescribeTableCommand({ TableName }));
  assert.equal(result.Table?.TableStatus, 'ACTIVE'); assert.equal(result.Table?.BillingModeSummary?.BillingMode, 'PAY_PER_REQUEST');
  assert.equal(result.Table?.DeletionProtectionEnabled, true); assert.equal(result.Table?.SSEDescription?.Status, 'ENABLED');
  const backup = await low.send(new DescribeContinuousBackupsCommand({ TableName }));
  assert.equal(backup.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus, 'ENABLED');
}
const ttl = await low.send(new DescribeTimeToLiveCommand({ TableName: `${prefix}-Tokens` }));
assert.ok(['ENABLED', 'ENABLING'].includes(ttl.TimeToLiveDescription?.TimeToLiveStatus ?? ''));
const changeId = `synthetic-storage-probe-${randomUUID()}`; const key = { changeId, sk: 'PROBE' };
const now = new Date().toISOString();
await doc.send(new TransactWriteCommand({ TransactItems: names.map(TableName => ({ Put: { TableName,
  Item: { ...key, tenantId: 'synthetic-storage-probe', recordType: 'storage_probe_not_an_approval', createdAt: now,
    description: 'Synthetic atomic-write smoke probe. Not application state, an approval, a callback token or release evidence.' },
  ConditionExpression: 'attribute_not_exists(changeId) AND attribute_not_exists(sk)' } })) }));
for (const TableName of names) assert.equal((await doc.send(new GetCommand({ TableName, Key: key, ConsistentRead: true }))).Item?.recordType, 'storage_probe_not_an_approval');
let duplicateRejected = false;
try { await doc.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: names[0]!, Item: { ...key, corrupted: true }, ConditionExpression: 'attribute_not_exists(changeId)' } },
  { Put: { TableName: names[2]!, Item: { changeId, sk: 'MUST_NOT_COMMIT', recordType: 'invalid_probe' } } }] })); }
catch (error) { assert.equal((error as Error).name, 'TransactionCanceledException'); duplicateRejected = true; }
assert.ok(duplicateRejected);
assert.equal((await doc.send(new GetCommand({ TableName: names[2]!, Key: { changeId, sk: 'MUST_NOT_COMMIT' }, ConsistentRead: true }))).Item, undefined);
assert.equal((await doc.send(new GetCommand({ TableName: names[0]!, Key: key, ConsistentRead: true }))).Item?.corrupted, undefined);
console.log(JSON.stringify({ result: 'PASS', region, tables: names, checks: ['active', 'on-demand', 'encryption', 'PITR', 'deletion-protection', 'token-TTL', 'cross-table-atomic-write', 'conditional-overwrite-rejection', 'transaction-rollback'], syntheticProbeId: changeId }, null, 2));
