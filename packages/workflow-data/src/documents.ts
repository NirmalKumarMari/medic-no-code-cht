import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  artifactRefSchema,
  hasRole,
  idSchema,
  requireData,
  type ArtifactRef,
  type HumanContext,
  type Item,
  type Tables,
} from "./model.js";

/** Uploaded originals are separate from reviewed/published prompt sources. */
export class DocumentRepository {
  constructor(
    private client: DynamoDBDocumentClient,
    private tables: Tables,
  ) {}
  private key(tenant: string, documentId: string) {
    idSchema.parse(documentId);
    return `DOCUMENT#${tenant}#${documentId}`;
  }
  async get(ctx: HumanContext, documentId: string, revisionId?: string) {
    hasRole(ctx, [
      "program_officer",
      "program_reviewer",
      "clinician",
      "it_deploy",
    ]);
    if (revisionId) idSchema.parse(revisionId);
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tables.changes,
        Key: {
          changeId: this.key(ctx.tenantId, documentId),
          sk: revisionId ? `VERSION#${revisionId}` : "META",
        },
        ConsistentRead: true,
      }),
    );
    requireData(
      result.Item?.tenantId === ctx.tenantId,
      "NOT_FOUND",
      "Document not found",
    );
    return result.Item!;
  }
  async save(
    ctx: HumanContext,
    input: {
      documentId: string;
      requestId: string;
      expectedVersion: number;
      filename: string;
      artifact: ArtifactRef;
    },
  ) {
    hasRole(ctx, ["program_officer"]);
    idSchema.parse(input.requestId);
    const pk = this.key(ctx.tenantId, input.documentId);
    requireData(
      Number.isInteger(input.expectedVersion) && input.expectedVersion >= 0,
      "INVALID_VERSION",
      "Invalid document version",
    );
    const ref = artifactRefSchema.parse(input.artifact);
    requireData(
      ref.key ===
        `docs/${ctx.tenantId}/${input.documentId}/${input.requestId}/original.pdf`,
      "INVALID_ARTIFACT",
      "Document location mismatch",
    );
    let prior: Item | undefined;
    try {
      const replay = await this.get(ctx, input.documentId, input.requestId);
      requireData(
        replay.artifact.sha256 === ref.sha256 &&
          replay.filename === input.filename &&
          replay.actorId === ctx.subject,
        "IDEMPOTENCY_CONFLICT",
        "Upload request already used for different bytes",
      );
      return replay;
    } catch (e) {
      if ((e as { code?: string }).code !== "NOT_FOUND") throw e;
    }
    try {
      prior = await this.get(ctx, input.documentId);
    } catch (e) {
      if ((e as { code?: string }).code !== "NOT_FOUND") throw e;
    }
    requireData(
      (prior?.version ?? 0) === input.expectedVersion,
      "CONFLICT",
      "A newer document version exists. Reload before uploading.",
    );
    const time = new Date().toISOString();
    const row = {
      changeId: pk,
      sk: "META",
      kind: "document",
      tenantId: ctx.tenantId,
      documentId: input.documentId,
      revisionId: input.requestId,
      version: input.expectedVersion + 1,
      filename: input.filename,
      artifact: ref,
      actorId: ctx.subject,
      createdAt: prior?.createdAt ?? time,
      updatedAt: time,
    };
    const insert = (table: string, item: Item) => ({
      Put: {
        TableName: table,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(changeId) AND attribute_not_exists(sk)",
      },
    });
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tables.changes,
              Item: {
                ...row,
                inbox: `${ctx.tenantId}#documents`,
                inboxSort: `${time}#${input.documentId}`,
              },
              ConditionExpression: prior
                ? "#v = :v"
                : "attribute_not_exists(changeId) AND attribute_not_exists(sk)",
              ...(prior
                ? {
                    ExpressionAttributeNames: { "#v": "version" },
                    ExpressionAttributeValues: { ":v": input.expectedVersion },
                  }
                : {}),
            },
          },
          insert(this.tables.changes, {
            ...row,
            sk: `VERSION#${input.requestId}`,
          }),
          insert(this.tables.audit, {
            changeId: pk,
            sk: `${time}#${randomUUID()}`,
            tenantId: ctx.tenantId,
            type: "document.uploaded",
            actorId: ctx.subject,
            documentId: input.documentId,
            version: row.version,
            artifact: ref,
            createdAt: time,
          }),
        ],
      }),
    );
    return row;
  }
  async list(ctx: HumanContext, cursor?: Item) {
    hasRole(ctx, [
      "program_officer",
      "program_reviewer",
      "clinician",
      "it_deploy",
    ]);
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.tables.changes,
        IndexName: "ReviewInboxIndex",
        KeyConditionExpression: "inbox = :inbox",
        ExpressionAttributeValues: { ":inbox": `${ctx.tenantId}#documents` },
        Limit: 50,
        ExclusiveStartKey: cursor,
        ScanIndexForward: false,
      }),
    );
    return { items: r.Items ?? [], cursor: r.LastEvaluatedKey };
  }
  async versions(ctx: HumanContext, documentId: string, cursor?: Item) {
    await this.get(ctx, documentId);
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.tables.changes,
        KeyConditionExpression: "changeId = :id AND begins_with(sk,:prefix)",
        ExpressionAttributeValues: {
          ":id": this.key(ctx.tenantId, documentId),
          ":prefix": "VERSION#",
        },
        ConsistentRead: true,
        Limit: 100,
        ExclusiveStartKey: cursor,
      }),
    );
    return { items: r.Items ?? [], cursor: r.LastEvaluatedKey };
  }
}
