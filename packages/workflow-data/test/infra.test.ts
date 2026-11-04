import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
await import('../infra/app.js');
const template = JSON.parse(readFileSync('.artifacts/vera-workflow-data.template.json', 'utf8'));
test('IaC provisions exactly four on-demand, encrypted, retained and protected DynamoDB tables', () => {
  const resources = Object.values(template.Resources) as any[];
  assert.equal(resources.length, 4);
  for (const resource of resources) {
    assert.equal(resource.Type, 'AWS::DynamoDB::Table'); assert.equal(resource.Properties.BillingMode, 'PAY_PER_REQUEST');
    assert.equal(resource.Properties.DeletionProtectionEnabled, true); assert.equal(resource.DeletionPolicy, 'Retain');
    assert.equal(resource.UpdateReplacePolicy, 'Retain'); assert.equal(resource.Properties.SSESpecification.SSEEnabled, true);
    assert.equal(resource.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  }
});
test('only finished Tokens records have a TTL mechanism; callback GSI cannot expose secret attributes', () => {
  const resources = Object.values(template.Resources) as any[];
  const tokens = resources.find(r => r.Properties.TableName.endsWith('-Tokens'));
  assert.equal(tokens.Properties.TimeToLiveSpecification.AttributeName, 'cleanupAt');
  assert.equal(tokens.Properties.GlobalSecondaryIndexes[0].Projection.ProjectionType, 'KEYS_ONLY');
  assert.equal(resources.filter(r => r.Properties.TimeToLiveSpecification).length, 1);
  assert.ok(!resources.some(r => r.Type.includes('IAM')));
});
