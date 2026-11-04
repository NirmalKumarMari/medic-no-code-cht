import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { StorageStack } from "../../infra/storage-stack.js";
test("one private retained versioned KMS artifact bucket; no knowledge base, vector or ingestion resources", () => {
  const t = Template.fromStack(new StorageStack(new App(), "test"));
  t.resourceCountIs("AWS::S3::Bucket", 1);
  t.hasResourceProperties("AWS::S3::Bucket", {
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        Match.objectLike({
          ServerSideEncryptionByDefault: Match.objectLike({
            SSEAlgorithm: "aws:kms",
          }),
        }),
      ],
    },
  });
  for (const type of [
    "AWS::Bedrock::KnowledgeBase",
    "AWS::Bedrock::DataSource",
    "AWS::S3Vectors::VectorBucket",
    "AWS::S3Vectors::Index",
    "AWS::BedrockAgentCore::Memory",
  ])
    t.resourceCountIs(type, 0);
  t.resourceCountIs("AWS::Bedrock::Guardrail", 1);
  t.resourceCountIs("AWS::Bedrock::GuardrailVersion", 1);
  const allows = Object.values(t.toJSON().Resources)
    .flatMap((r: any) => r.Properties?.PolicyDocument?.Statement ?? [])
    .filter((s: any) => s.Effect === "Allow");
  const json = JSON.stringify(allows);
  for (const action of [
    "bedrock:Retrieve",
    "bedrock:InvokeModel",
    "s3vectors:",
    "bedrock:StartIngestionJob",
  ])
    assert.ok(!json.includes(action), action);
  t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: "Deny", Action: "s3:*" }),
      ]),
    },
  });
  const bucket = Object.values(t.toJSON().Resources).find(
    (r: any) => r.Type === "AWS::S3::Bucket",
  ) as any;
  assert.equal(bucket.DeletionPolicy, "Retain");
  assert.ok(
    !Object.keys(t.toJSON().Outputs).some((k) =>
      /KnowledgeBase|Vector|DataSource|KbSource/i.test(k),
    ),
  );
});
