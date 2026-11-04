import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callbackTenants, tablesFromEnvironment } from '../src/index.js';
test('configuration requires explicit tenants and four distinct safe table names', () => {
  assert.deepEqual(callbackTenants({ WORKFLOW_TENANT_IDS: 'demo, demo, second' }), ['demo', 'second']);
  assert.throws(() => callbackTenants({})); assert.throws(() => callbackTenants({ WORKFLOW_TENANT_IDS: 'bad#tenant' }));
  assert.equal(tablesFromEnvironment({}).tokens, 'vera-workflow-Tokens');
  assert.throws(() => tablesFromEnvironment({ CHANGES_TABLE: 'same', TOKENS_TABLE: 'same' }));
});
