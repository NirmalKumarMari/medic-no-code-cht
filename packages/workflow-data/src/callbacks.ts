import { randomUUID } from 'node:crypto';
import { GetExecutionHistoryCommand, SendTaskSuccessCommand, SFNClient } from '@aws-sdk/client-sfn';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { requireData, type CallbackPayload, type Item } from './model.js';
import { WorkflowRepository } from './repository.js';

export interface CallbackTransport {
  sendSuccess(taskToken: string, payload: CallbackPayload): Promise<void>;
  hasCompleted(executionArn: string, payload: CallbackPayload): Promise<boolean>;
}
export class SfnCallbackTransport implements CallbackTransport {
  constructor(private client: SFNClient) {}
  async sendSuccess(taskToken: string, payload: CallbackPayload): Promise<void> {
    await this.client.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(payload) }));
  }
  async hasCompleted(executionArn: string, payload: CallbackPayload): Promise<boolean> {
    let nextToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const history = await this.client.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 100, reverseOrder: true, includeExecutionData: true, nextToken }));
      for (const event of history.events ?? []) {
        const output = event.taskSucceededEventDetails?.output;
        if (!output) continue;
        try {
          const result = JSON.parse(output);
          if (result.decisionId === payload.decisionId && result.snapshotHash === payload.snapshotHash && result.changeId === payload.changeId && result.gate === payload.gate && result.decision === payload.decision) return true;
        } catch { /* Non-JSON outputs belong to other workflow tasks. */ }
      }
      nextToken = history.nextToken; if (!nextToken) break;
    }
    return false;
  }
}

/** Internal worker only. Never expose this class or Tokens read permissions to UI/agents. */
export class CallbackDispatcher {
  constructor(private repo: WorkflowRepository, private transport: CallbackTransport) {}
  async due(tenantId: string): Promise<{ changeId: string; sk: string }[]> {
    const result = await this.repo.client.send(new QueryCommand({ TableName: this.repo.tables.tokens, IndexName: 'CallbackDeliveryIndex',
      KeyConditionExpression: 'callbackQueue = :tenant AND callbackDueAt <= :now',
      ExpressionAttributeValues: { ':tenant': tenantId, ':now': this.repo.stamp() }, Limit: 50 }));
    return (result.Items ?? []).map(({ changeId, sk }) => ({ changeId, sk }));
  }
  async dispatchOne(tenantId: string, changeId: string, sk: string): Promise<'delivered' | 'retry' | 'busy' | 'needs_attention'> {
    const row = await this.repo.getChange({ tenantId }, changeId);
    const token = await this.repo.read(this.repo.tables.tokens, changeId, sk);
    requireData(token?.tenantId === tenantId, 'NOT_FOUND', 'Callback attempt not found');
    if (token.status === 'delivered') return 'delivered';
    requireData(token.status === 'decided' && token.snapshotHash === row.snapshotHash && row.activeWaitSk === sk && row.callbackPending, 'STALE_TOKEN', 'Callback is not the active decided attempt');
    const owner = randomUUID(); const now = this.repo.stamp();
    const leaseUntil = new Date(this.repo.clock().getTime() + 60_000).toISOString();
    let claimed: Item;
    try {
      claimed = (await this.repo.client.send(new UpdateCommand({ TableName: this.repo.tables.tokens, Key: { changeId, sk },
        UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :until, callbackDueAt = :until, deliveryAttempts = deliveryAttempts + :one',
        ConditionExpression: '#status = :decided AND callbackDueAt <= :now AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':owner': owner, ':until': leaseUntil, ':one': 1, ':decided': 'decided', ':now': now }, ReturnValues: 'ALL_NEW' }))).Attributes!;
    } catch (error) { if ((error as Error).name === 'ConditionalCheckFailedException') return 'busy'; throw error; }
    let delivered = false; let errorCode = 'CallbackError';
    try {
      if (claimed.expiresAt <= this.repo.stamp()) delivered = await this.transport.hasCompleted(claimed.executionArn, claimed.decisionPayload);
      else { await this.transport.sendSuccess(claimed.taskToken, claimed.decisionPayload); delivered = true; }
    } catch (error) {
      const name = (error as Error).name;
      errorCode = /^[A-Za-z0-9_]{1,80}$/.test(name) ? name : 'CallbackError';
      try { delivered = await this.transport.hasCompleted(claimed.executionArn, claimed.decisionPayload); } catch { /* A later worker retries the persisted decision. */ }
    }
    if (!delivered) {
      const terminal = claimed.expiresAt <= this.repo.stamp() || (['TaskDoesNotExist', 'TaskTimedOut', 'InvalidToken'].includes(errorCode) && claimed.deliveryAttempts >= 3);
      const due = new Date(this.repo.clock().getTime() + Math.min(300, 5 * 2 ** Math.min(claimed.deliveryAttempts, 6)) * 1000).toISOString();
      await this.repo.client.send(new UpdateCommand({ TableName: this.repo.tables.tokens, Key: { changeId, sk },
        UpdateExpression: terminal ? 'SET #status = :attention, lastErrorCode = :code REMOVE leaseOwner, leaseExpiresAt, callbackQueue, callbackDueAt' : 'SET callbackDueAt = :due, lastErrorCode = :code REMOVE leaseOwner, leaseExpiresAt',
        ConditionExpression: 'leaseOwner = :owner AND #status = :decided',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':owner': owner, ':decided': 'decided', ':code': errorCode, ...(terminal ? { ':attention': 'needs_attention' } : { ':due': due }) } }));
      return terminal ? 'needs_attention' : 'retry';
    }
    // The callback may have succeeded before this worker crashed. A future attempt
    // verifies the exact decision in execution history, rather than assuming timeout=success.
    const current = await this.repo.getChange({ tenantId }, changeId);
    requireData(current.activeWaitSk === sk && current.snapshotHash === claimed.snapshotHash, 'STALE_TOKEN', 'Callback completed for a superseded snapshot; do not alter new state');
    const eventId = randomUUID();
    await this.repo.commit([
      { Update: { TableName: this.repo.tables.tokens, Key: { changeId, sk },
        UpdateExpression: 'SET #status = :done, completedAt = :now, cleanupAt = :cleanup REMOVE taskToken, callbackQueue, callbackDueAt, leaseOwner, leaseExpiresAt',
        ConditionExpression: 'leaseOwner = :owner AND #status = :decided', ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':done': 'delivered', ':now': this.repo.stamp(), ':cleanup': Math.floor(this.repo.clock().getTime() / 1000) + 86400, ':owner': owner, ':decided': 'decided' } } },
      { Update: { TableName: this.repo.tables.changes, Key: { changeId, sk: 'META' },
        UpdateExpression: 'SET callbackPending = :false, #v = #v + :one REMOVE activeWaitSk',
        ConditionExpression: '#v = :version AND activeWaitSk = :sk AND snapshotHash = :hash', ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':false': false, ':one': 1, ':version': current.version, ':sk': sk, ':hash': current.snapshotHash } } },
      { Put: { TableName: this.repo.tables.audit, Item: { changeId, sk: `${this.repo.stamp()}#${eventId}`, tenantId,
        eventId, type: 'callback.delivered', actorId: 'callback-dispatcher', snapshotHash: claimed.snapshotHash,
        decisionId: claimed.decisionPayload.decisionId, gate: claimed.gate, createdAt: this.repo.stamp() },
        ConditionExpression: 'attribute_not_exists(changeId) AND attribute_not_exists(sk)' } },
    ]);
    return 'delivered';
  }
}
