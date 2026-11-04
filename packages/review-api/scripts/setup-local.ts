import {
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:18000";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint))
  throw Error("This setup command only accepts DynamoDB Local");
const client = new DynamoDBClient({
  endpoint,
  region: "us-west-2",
  credentials: {
    accessKeyId: "localdevelopment",
    secretAccessKey: "localdevelopment",
  },
});
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      break;
    } catch (error) {
      if (attempt >= 39) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  for (const kind of ["Changes", "Approvals", "Audit", "Tokens"]) {
    const TableName = `vera-ui-local-${kind}`;
    const index =
      kind === "Changes"
        ? {
            name: "ReviewInboxIndex",
            pk: "inbox",
            sk: "inboxSort",
            projection: "ALL" as const,
          }
        : kind === "Tokens"
          ? {
              name: "CallbackDeliveryIndex",
              pk: "callbackQueue",
              sk: "callbackDueAt",
              projection: "KEYS_ONLY" as const,
            }
          : undefined;
    try {
      await client.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "changeId", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "changeId", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            ...(index
              ? [
                  { AttributeName: index.pk, AttributeType: "S" as const },
                  { AttributeName: index.sk, AttributeType: "S" as const },
                ]
              : []),
          ],
          ...(index
            ? {
                GlobalSecondaryIndexes: [
                  {
                    IndexName: index.name,
                    KeySchema: [
                      { AttributeName: index.pk, KeyType: "HASH" },
                      { AttributeName: index.sk, KeyType: "RANGE" },
                    ],
                    Projection: { ProjectionType: index.projection },
                  },
                ],
              }
            : {}),
        }),
      );
    } catch (error) {
      if ((error as Error).name !== "ResourceInUseException") throw error;
    }
    await waitUntilTableExists(
      { client, maxWaitTime: 30, minDelay: 1, maxDelay: 2 },
      { TableName },
    );
    const table = await client.send(new DescribeTableCommand({ TableName }));
    if (
      JSON.stringify(table.Table?.KeySchema) !==
      JSON.stringify([
        { AttributeName: "changeId", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ])
    )
      throw Error(`Unexpected schema for ${TableName}`);
  }
  console.log(
    "Local review tables ready. No demo records, approvals, callback tokens or AWS resources created.",
  );
} finally {
  client.destroy();
}
