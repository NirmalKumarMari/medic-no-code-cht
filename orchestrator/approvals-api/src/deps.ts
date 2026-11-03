import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { config } from "./config.js";
import type { ApprovalKind } from "./schema.js";
import type { ApprovalRecord, AuditRecord, Deps, PendingToken } from "./approvals.js";

// Duplicated from orchestrator/cdk/lambda/request-approval/index.ts on purpose —
// the two packages don't share a module today. If that drifts, a pending token
// written by one and looked up by the other silently never matches, so keep
// these two definitions identical until there's a shared package.
function tokenSortKey(kind: ApprovalKind): string {
  return kind === "content" ? "token#content_review" : "token#deploy_review";
}

export function createAwsDeps(): Deps {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
  const sfn = new SFNClient({ region: config.region });

  return {
    async getPendingToken(changeId, kind) {
      const result = await ddb.send(
        new GetCommand({ TableName: config.tables.tokens, Key: { changeId, sk: tokenSortKey(kind) } }),
      );
      if (!result.Item || result.Item.status !== "pending") return undefined;
      return { taskToken: result.Item.taskToken, summary: result.Item.summary ?? {} } satisfies PendingToken;
    },

    async getChangeAuthorId(changeId) {
      const result = await ddb.send(
        new GetCommand({ TableName: config.tables.changes, Key: { changeId, sk: "spec" } }),
      );
      return result.Item?.submittedBy?.userId as string | undefined;
    },

    async getOtherGateApproverId(changeId, otherKind) {
      const result = await ddb.send(
        new QueryCommand({
          TableName: config.tables.approvals,
          KeyConditionExpression: "changeId = :cid AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":cid": changeId, ":prefix": `approval#${otherKind}#` },
        }),
      );
      const items = result.Items ?? [];
      if (items.length === 0) return undefined;
      // Most recent decision wins, in case the gate was re-run across snapshot versions.
      items.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
      return items[0]!.approverId as string;
    },

    async putApprovalRecord(record: ApprovalRecord) {
      await ddb.send(
        new PutCommand({
          TableName: config.tables.approvals,
          Item: {
            ...record,
            sk: `approval#${record.kind}#${record.snapshotHash ?? "unknown"}`,
          },
        }),
      );
    },

    async putAuditRecord(record: AuditRecord) {
      await ddb.send(
        new PutCommand({
          TableName: config.tables.audit,
          Item: { ...record, sk: `ts#${record.ulid}` },
        }),
      );
    },

    async markTokenCompleted(changeId, kind) {
      await ddb.send(
        new UpdateCommand({
          TableName: config.tables.tokens,
          Key: { changeId, sk: tokenSortKey(kind) },
          UpdateExpression: "SET #status = :completed, completedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":completed": "completed", ":now": new Date().toISOString() },
        }),
      );
    },

    async sendTaskSuccess(taskToken, outputPayload) {
      await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(outputPayload) }));
    },
  };
}
