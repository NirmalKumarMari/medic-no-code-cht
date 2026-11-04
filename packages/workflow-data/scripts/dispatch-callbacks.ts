import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { CallbackDispatcher, callbackTenants, SfnCallbackTransport, tablesFromEnvironment, WorkflowRepository } from '../src/index.js';

const region = process.env.AWS_REGION ?? 'us-west-2';
const tenants = callbackTenants();
const low = new DynamoDBClient({ region }); const sfn = new SFNClient({ region });
const repo = new WorkflowRepository({ client: DynamoDBDocumentClient.from(low), tables: tablesFromEnvironment(),
  verifySnapshot: async () => { throw new Error('The callback process cannot register artifacts'); } });
const dispatcher = new CallbackDispatcher(repo, new SfnCallbackTransport(sfn));
let stop = false; process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
try {
  do {
    let failures = 0;
    for (const tenantId of tenants) {
      try {
        for (const { changeId, sk } of await dispatcher.due(tenantId)) {
          if (stop) break;
          try {
            const result = await dispatcher.dispatchOne(tenantId, changeId, sk);
            console.log(JSON.stringify({ event: 'callback.delivery', tenantId, changeId, result }));
            if (result === 'needs_attention') failures++;
          } catch { failures++; console.error(JSON.stringify({ event: 'callback.dispatch_failed', tenantId, changeId })); }
        }
      } catch { failures++; console.error(JSON.stringify({ event: 'callback.query_failed', tenantId })); }
    }
    // Never log SDK error objects: request metadata could contain the raw task token.
    if (process.argv.includes('--once')) { if (failures) process.exitCode = 1; break; }
    if (!stop) await delay(failures ? 10_000 : 2_000);
  } while (!stop);
} finally { low.destroy(); sfn.destroy(); }
