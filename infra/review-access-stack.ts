import {
  BootstraplessSynthesizer,
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";

/** Identity and scoped credentials for the trusted review storage/decision worker. */
export class ReviewAccessStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, { synthesizer: new BootstraplessSynthesizer(), ...props });
    const bucket = new CfnParameter(this, "ArtifactBucket", { type: "String" });
    const key = new CfnParameter(this, "KmsKeyArn", { type: "String" });
    const guardrail = new CfnParameter(this, "GuardrailArn", {
      type: "String",
    });
    const workshopRole = new CfnParameter(this, "WorkshopRoleArn", {
      type: "String",
    });
    const callbackUrls = new CfnParameter(this, "CallbackUrls", {
      type: "CommaDelimitedList",
      default: "http://localhost:5173/",
    });
    const pool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "vera-review",
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const role of [
      "program_officer",
      "program_reviewer",
      "clinician",
      "it_deploy",
    ])
      new cognito.CfnUserPoolGroup(this, role, {
        userPoolId: pool.userPoolId,
        groupName: role,
      });
    const client = pool.addClient("BrowserClient", {
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true, adminUserPassword: true },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: callbackUrls.valueAsList,
        logoutUrls: callbackUrls.valueAsList,
      },
    });
    const domain = pool.addDomain("HostedLogin", {
      cognitoDomain: { domainPrefix: `vera-review-${this.account}` },
    });
    const worker = new iam.Role(this, "StorageDecisionWorkerRole", {
      assumedBy: new iam.ArnPrincipal(workshopRole.valueAsString),
      maxSessionDuration: Duration.hours(1),
    });
    const tableArn = (name: string) =>
      this.formatArn({
        service: "dynamodb",
        resource: "table",
        resourceName: `vera-workflow-${name}`,
      });
    worker.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: ["Changes", "Approvals", "Audit", "Tokens"].flatMap(
          (name) => [tableArn(name), `${tableArn(name)}/index/*`],
        ),
      }),
    );
    worker.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"],
        resources: ["docs", "snapshots", "reports", "proposals", "builds"].map(
          (prefix) =>
            `arn:${this.partition}:s3:::${bucket.valueAsString}/${prefix}/*`,
        ),
      }),
    );
    worker.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ],
        resources: [key.valueAsString],
      }),
    );
    worker.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:ApplyGuardrail"],
        resources: [guardrail.valueAsString],
      }),
    );
    for (const [name, value] of Object.entries({
      UserPoolId: pool.userPoolId,
      ClientId: client.userPoolClientId,
      HostedDomain: domain.baseUrl(),
      StorageDecisionWorkerRoleArn: worker.roleArn,
    }))
      new CfnOutput(this, name, { value });
  }
}
