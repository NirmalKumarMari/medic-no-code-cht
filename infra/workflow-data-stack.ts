import {
  BootstraplessSynthesizer,
  CfnOutput,
  RemovalPolicy,
  Stack,
  Tags,
  aws_dynamodb as dynamodb,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface WorkflowDataStackProps extends StackProps {
  tablePrefix?: string;
}

/** Keep these resources directly under the stack to preserve deployed logical IDs. */
export class WorkflowDataStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: WorkflowDataStackProps = {},
  ) {
    const { tablePrefix: prefix = "vera-workflow", ...stackProps } = props;
    if (
      !/^[a-zA-Z][a-zA-Z0-9-]{0,70}$/.test(stackProps.stackName ?? id) ||
      !/^[a-zA-Z][a-zA-Z0-9-]{0,70}$/.test(prefix)
    ) {
      throw new Error("Invalid resource prefix");
    }
    super(scope, id, {
      synthesizer: new BootstraplessSynthesizer(),
      analyticsReporting: false,
      description:
        "Vera workflow persistence: four encrypted on-demand DynamoDB tables; no IAM roles or public access.",
      ...stackProps,
    });
    // Match the original directly synthesized template even when using the CDK CLI.
    this.node.setContext("aws:cdk:enable-path-metadata", false);
    Tags.of(this).add("Project", "vera-cht");
    Tags.of(this).add("Component", "workflow-data");
    Tags.of(this).add("Environment", "hackathon");
    for (const kind of ["Changes", "Approvals", "Audit", "Tokens"]) {
      const table = new dynamodb.Table(this, kind, {
        tableName: `${prefix}-${kind}`,
        partitionKey: { name: "changeId", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        ...(kind === "Tokens" ? { timeToLiveAttribute: "cleanupAt" } : {}),
      });
      if (kind === "Changes")
        table.addGlobalSecondaryIndex({
          indexName: "ReviewInboxIndex",
          partitionKey: { name: "inbox", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "inboxSort", type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        });
      if (kind === "Tokens")
        table.addGlobalSecondaryIndex({
          indexName: "CallbackDeliveryIndex",
          partitionKey: {
            name: "callbackQueue",
            type: dynamodb.AttributeType.STRING,
          },
          sortKey: {
            name: "callbackDueAt",
            type: dynamodb.AttributeType.STRING,
          },
          projectionType: dynamodb.ProjectionType.KEYS_ONLY,
        });
      new CfnOutput(this, `${kind}TableName`, { value: table.tableName });
      new CfnOutput(this, `${kind}TableArn`, { value: table.tableArn });
    }
  }
}
