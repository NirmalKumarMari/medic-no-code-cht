import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetExecutionHistoryCommand, SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { SfnCallbackTransport, type CallbackPayload } from '../src/index.js';

const payload: CallbackPayload = { changeId: 'fixture-change', snapshotHash: 'a'.repeat(64), gate: 'content', decisionId: 'fixture-decision', decision: 'reject' };
test('Step Functions history reconciliation requires exact decision output across paginated history', async () => {
  const calls: unknown[] = [];
  const transport = new SfnCallbackTransport({ send: async (command: GetExecutionHistoryCommand) => {
    calls.push(command.input);
    if (!command.input.nextToken) return { nextToken: 'next', events: [
      { taskSucceededEventDetails: { output: 'not JSON' } },
      { taskSucceededEventDetails: { output: JSON.stringify({ ...payload, decision: 'approve' }) } },
    ] };
    return { events: [{ taskSucceededEventDetails: { output: JSON.stringify(payload) } }] };
  } } as unknown as SFNClient);
  assert.equal(await transport.hasCompleted('fixture-execution', payload), true);
  assert.equal(calls.length, 2);
});
test('token disappearance or another snapshot output does not prove callback delivery', async () => {
  const transport = new SfnCallbackTransport({ send: async () => ({ events: [
    { taskSucceededEventDetails: { output: JSON.stringify({ ...payload, snapshotHash: 'b'.repeat(64) }) } },
  ] }) } as unknown as SFNClient);
  assert.equal(await transport.hasCompleted('fixture-execution', payload), false);
});
test('both approve/reject are sent as exact callback payloads for the state machine Choice', async () => {
  let input: unknown;
  const transport = new SfnCallbackTransport({ send: async (command: SendTaskSuccessCommand) => { input = command.input; return {}; } } as unknown as SFNClient);
  await transport.sendSuccess('synthetic-token', payload);
  assert.deepEqual(input, { taskToken: 'synthetic-token', output: JSON.stringify(payload) });
});
