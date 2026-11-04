import {
  Stack,
  CfnOutput,
  CfnParameter,
  RemovalPolicy,
  Duration,
  Tags,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as bedrock from "aws-cdk-lib/aws-bedrock";

/** November 4 design: one artifact store, direct prompt context, no indexed corpus. */
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add("project", "breaking-barriers");
    const agentRoles = new CfnParameter(this, "AgentRoleNames", {
      type: "CommaDelimitedList",
      description: "All agent role names; never supply trusted worker roles.",
    });
    const key = new kms.Key(this, "StorageKey", {
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const artifacts = new s3.Bucket(this, "Artifacts", {
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const [condition, value] of [
      ["s3:x-amz-server-side-encryption", "aws:kms"],
      ["s3:x-amz-server-side-encryption-aws-kms-key-id", key.keyArn],
    ])
      artifacts.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:PutObject"],
          resources: [artifacts.arnForObjects("*")],
          conditions: { StringNotEquals: { [condition!]: value! } },
        }),
      );
    artifacts.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [artifacts.arnForObjects("*")],
        conditions: { Null: { "s3:if-none-match": "true" } },
      }),
    );
    // Preserve the screening resources independently of any source indexing service.
    const guardrail = new bedrock.CfnGuardrail(this, "IngestionGuardrail", {
      name: `${this.stackName}-inputs`,
      blockedInputMessaging: "Input rejected by screening.",
      blockedOutputsMessaging: "Output rejected by screening.",
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          "NAME",
          "EMAIL",
          "PHONE",
          "ADDRESS",
          "AGE",
          "AWS_ACCESS_KEY",
          "AWS_SECRET_KEY",
          "PASSWORD",
        ].map((type) => ({ type, action: "BLOCK" })),
      },
    });
    const version = new bedrock.CfnGuardrailVersion(this, "ScreeningVersion", {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: "Published source and prompt input screening",
    });
    const worker = (name: string, prefixes: string[], screen = false) => {
      const role = new iam.Role(this, name, {
        assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObjectVersion"],
          resources: [artifacts.arnForObjects("docs/*")],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
          resources: prefixes.map((p) => artifacts.arnForObjects(p)),
        }),
      );
      if (screen)
        role.addToPolicy(
          new iam.PolicyStatement({
            actions: ["bedrock:ApplyGuardrail"],
            resources: [guardrail.attrGuardrailArn],
          }),
        );
      key.grantEncryptDecrypt(role);
      return role;
    };
    const contextWorker = worker(
      "PromptContextWorkerRole",
      ["reports/*/context/*"],
      true,
    );
    const sourceWriter = worker("SourceWriterRole", ["docs/*"], true);
    const artifactWorker = worker("ArtifactWorkerRole", [
      "snapshots/*",
      "proposals/*",
      "builds/*",
      "reports/*",
    ]);
    artifactWorker.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucketVersions"],
        resources: [artifacts.bucketArn],
      }),
    );
    new iam.CfnManagedPolicy(this, "AgentStorageDeny", {
      roles: agentRoles.valueAsList,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          // Preserve the previous deny boundary even though none of these services is provisioned.
          {
            Effect: "Deny",
            Action: [
              "bedrock:Retrieve",
              "bedrock:RetrieveAndGenerate",
              "bedrock:StartIngestionJob",
              "bedrock:IngestKnowledgeBaseDocuments",
              "bedrock:DeleteKnowledgeBaseDocuments",
              "s3vectors:*",
            ],
            Resource: "*",
          },
          {
            Effect: "Deny",
            Action: "s3:*",
            Resource: [artifacts.bucketArn, artifacts.arnForObjects("*")],
          },
          {
            Effect: "Deny",
            Action: ["sts:AssumeRole", "iam:PassRole"],
            Resource: [
              contextWorker.roleArn,
              sourceWriter.roleArn,
              artifactWorker.roleArn,
            ],
          },
        ],
      },
    });
    for (const [name, value] of Object.entries({
      ArtifactBucket: artifacts.bucketName,
      KmsKeyArn: key.keyArn,
      PromptContextWorkerRoleArn: contextWorker.roleArn,
      SourceWriterRoleArn: sourceWriter.roleArn,
      ArtifactWorkerRoleArn: artifactWorker.roleArn,
      GuardrailId: guardrail.attrGuardrailId,
      GuardrailVersion: version.attrVersion,
    }))
      new CfnOutput(this, name, { value });
  }
}
