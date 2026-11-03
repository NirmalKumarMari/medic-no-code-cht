import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Small event glue, invoked by a `.waitForTaskToken` state the moment it
 * starts. Its only job is to persist the task token somewhere a human-facing
 * API can find it later — it must NOT call SendTaskSuccess/SendTaskFailure
 * itself. That is the Approvals API's job, after a human actually decides
 * (design rule 2: nothing may be approved by anything other than a person).
 *
 * This is the only thing standing between "pending approval" and "the
 * orchestrator has no idea an approval is needed" — if this Lambda fails,
 * the task token is lost and the execution hangs until it times out, so
 * failures here are loud by design (no silent catch).
 */
export interface RequestApprovalEvent {
  taskToken: string;
  changeId: string;
  approvalKind: "content" | "deploy";
  summary?: unknown; // small context for the approver UI to render without a second lookup
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event: RequestApprovalEvent): Promise<void> {
  const tableName = requireEnv("TOKENS_TABLE_NAME");
  const sk = approvalSortKey(event.approvalKind);

  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        changeId: event.changeId,
        sk,
        taskToken: event.taskToken,
        status: "pending",
        approvalKind: event.approvalKind,
        summary: event.summary ?? null,
        requestedAt: new Date().toISOString(),
      },
      // Defensive only: refuse to clobber a token row already marked completed.
      // A fresh "pending" row (e.g. from a retried wait state) is fine to overwrite.
      ConditionExpression: "attribute_not_exists(#status) OR #status <> :completed",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":completed": "completed" },
    }),
  );
}

export function approvalSortKey(kind: "content" | "deploy"): string {
  return kind === "content" ? "token#content_review" : "token#deploy_review";
}
