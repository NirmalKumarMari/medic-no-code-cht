import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  artifactRefSchema,
  canonicalJson,
  digestSchema,
  hasRole,
  idSchema,
  requireData,
  sha256,
  type ArtifactRef,
  type HumanContext,
  type Item,
  type Tables,
  WorkflowDataError,
} from "./model.js";

export interface AuthoringRecord {
  changeId: string;
  tenantId: string;
  authorId: string;
  title: string;
  version: number;
  revisionId: string;
  contentHash: string;
  artifact: ArtifactRef;
  createdAt: string;
  updatedAt: string;
  sk: string;
  kind: "authoring";
}
export interface SaveAuthoringInput {
  changeId: string;
  requestId: string;
  expectedVersion: number;
  title: string;
  contentHash: string;
  artifact: ArtifactRef;
}
/** Pre-workflow drafts have separate keys. They cannot satisfy workflow approval prerequisites. */
export class AuthoringRepository {
  constructor(
    private client: DynamoDBDocumentClient,
    private tables: Tables,
  ) {}
  private async read(changeId: string, sk: string): Promise<Item | undefined> {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.tables.changes,
          Key: { changeId, sk },
          ConsistentRead: true,
        }),
      )
    ).Item;
  }
  async get(
    ctx: HumanContext,
    changeId: string,
    revisionId?: string,
  ): Promise<AuthoringRecord> {
    hasRole(ctx, [
      "program_officer",
      "program_reviewer",
      "clinician",
      "it_deploy",
    ]);
    idSchema.parse(changeId);
    if (revisionId) idSchema.parse(revisionId);
    const row = await this.read(
      changeId,
      revisionId ? `AUTHORING#VERSION#${revisionId}` : "AUTHORING#META",
    );
    requireData(
      row?.kind === "authoring" && row.tenantId === ctx.tenantId,
      "NOT_FOUND",
      "Saved draft not found",
    );
    return row as AuthoringRecord;
  }
  async replay(
    ctx: HumanContext,
    input: SaveAuthoringInput,
  ): Promise<AuthoringRecord | undefined> {
    const receipt = await this.read(
      input.changeId,
      `AUTHORING#REQUEST#${input.requestId}`,
    );
    if (!receipt) return;
    requireData(
      receipt.tenantId === ctx.tenantId &&
        receipt.actorId === ctx.subject &&
        receipt.requestHash === sha256(canonicalJson(input)),
      "IDEMPOTENCY_CONFLICT",
      "Save request was already used for different content",
    );
    return this.get(ctx, input.changeId, receipt.revisionId);
  }
  async save(
    ctx: HumanContext,
    input: SaveAuthoringInput,
  ): Promise<AuthoringRecord> {
    hasRole(ctx, ["program_officer"]);
    idSchema.parse(input.changeId);
    idSchema.parse(input.requestId);
    digestSchema.parse(input.contentHash);
    requireData(
      Number.isInteger(input.expectedVersion) && input.expectedVersion >= 0,
      "INVALID_VERSION",
      "Invalid draft version",
    );
    requireData(
      input.title.trim().length > 0 && input.title.length <= 200,
      "INVALID_TITLE",
      "Invalid pathway title",
    );
    const artifact = artifactRefSchema.parse(input.artifact);
    requireData(
      artifact.key ===
        `snapshots/authoring/${ctx.tenantId}/${input.changeId}/${input.requestId}.json` &&
        artifact.sha256 === input.contentHash,
      "INVALID_ARTIFACT",
      "Draft artifact does not match this request",
    );
    const replay = await this.replay(ctx, input);
    if (replay) return replay;
    const prior = await this.read(input.changeId, "AUTHORING#META");
    if (prior)
      requireData(
        prior.tenantId === ctx.tenantId && prior.authorId === ctx.subject,
        "FORBIDDEN",
        "Only the original author can revise this draft",
      );
    requireData(
      (prior?.version ?? 0) === input.expectedVersion,
      "CONFLICT",
      "A newer draft exists. Reload before saving.",
    );
    const time = new Date().toISOString();
    const row: AuthoringRecord = {
      changeId: input.changeId,
      sk: "AUTHORING#META",
      tenantId: ctx.tenantId,
      authorId: ctx.subject,
      title: input.title,
      version: input.expectedVersion + 1,
      revisionId: input.requestId,
      contentHash: input.contentHash,
      artifact,
      createdAt: prior?.createdAt ?? time,
      updatedAt: time,
      kind: "authoring",
    };
    const insert = (TableName: string, Item: Item) => ({
      Put: {
        TableName,
        Item,
        ConditionExpression:
          "attribute_not_exists(changeId) AND attribute_not_exists(sk)",
      },
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.changes,
                Item: {
                  ...row,
                  inbox: `${ctx.tenantId}#authoring`,
                  inboxSort: `${time}#${row.changeId}`,
                },
                ConditionExpression: prior
                  ? "#v = :v AND tenantId = :tenant AND authorId = :author"
                  : "attribute_not_exists(changeId) AND attribute_not_exists(sk)",
                ...(prior
                  ? {
                      ExpressionAttributeNames: { "#v": "version" },
                      ExpressionAttributeValues: {
                        ":v": input.expectedVersion,
                        ":tenant": ctx.tenantId,
                        ":author": ctx.subject,
                      },
                    }
                  : {}),
              },
            },
            insert(this.tables.changes, {
              ...row,
              sk: `AUTHORING#VERSION#${input.requestId}`,
            }),
            insert(this.tables.changes, {
              changeId: row.changeId,
              sk: `AUTHORING#REQUEST#${input.requestId}`,
              tenantId: ctx.tenantId,
              actorId: ctx.subject,
              requestHash: sha256(canonicalJson(input)),
              revisionId: input.requestId,
            }),
            insert(this.tables.audit, {
              changeId: `AUTHORING#${ctx.tenantId}#${row.changeId}`,
              sk: `${time}#${randomUUID()}`,
              tenantId: ctx.tenantId,
              type: "authoring.saved",
              actorId: ctx.subject,
              version: row.version,
              contentHash: row.contentHash,
              createdAt: time,
            }),
          ],
        }),
      );
    } catch (e) {
      if ((e as Error).name !== "TransactionCanceledException") throw e;
      const replay = await this.replay(ctx, input);
      if (replay) return replay;
      throw new WorkflowDataError(
        "CONFLICT",
        "A newer draft exists. Reload before saving.",
      );
    }
    return row;
  }
  async list(ctx: HumanContext, cursor?: Item) {
    hasRole(ctx, [
      "program_officer",
      "program_reviewer",
      "clinician",
      "it_deploy",
    ]);
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tables.changes,
        IndexName: "ReviewInboxIndex",
        KeyConditionExpression: "inbox = :inbox",
        ExpressionAttributeValues: { ":inbox": `${ctx.tenantId}#authoring` },
        Limit: 50,
        ScanIndexForward: false,
        ExclusiveStartKey: cursor,
      }),
    );
    return {
      items: (result.Items ?? []) as AuthoringRecord[],
      cursor: result.LastEvaluatedKey,
    };
  }
  async audit(ctx: HumanContext, changeId: string, cursor?: Item) {
    await this.get(ctx, changeId);
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tables.audit,
        KeyConditionExpression: "changeId = :id",
        ExpressionAttributeValues: {
          ":id": `AUTHORING#${ctx.tenantId}#${changeId}`,
        },
        ConsistentRead: true,
        Limit: 100,
        ExclusiveStartKey: cursor,
      }),
    );
    return { items: result.Items ?? [], cursor: result.LastEvaluatedKey };
  }
}
