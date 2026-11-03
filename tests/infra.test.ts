import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { StorageStack } from "../infra/storage-stack.js";
test("two private versioned KMS buckets, one matching vector index and three unchunked sources", () => {
  const t = Template.fromStack(new StorageStack(new App(), "TestStorage"));
  t.resourceCountIs("AWS::S3::Bucket", 2);
  t.allResourcesProperties("AWS::S3::Bucket", {
    VersioningConfiguration: { Status: "Enabled" },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: Match.objectLike({
      ServerSideEncryptionConfiguration: [
        Match.objectLike({
          ServerSideEncryptionByDefault: Match.objectLike({
            SSEAlgorithm: "aws:kms",
          }),
        }),
      ],
    }),
  });
  t.resourceCountIs("AWS::S3Vectors::VectorBucket", 1);
  t.hasResourceProperties("AWS::S3Vectors::Index", {
    Dimension: 1024,
    DistanceMetric: "cosine",
    MetadataConfiguration: {
      NonFilterableMetadataKeys: [
        "AMAZON_BEDROCK_TEXT",
        "AMAZON_BEDROCK_METADATA",
      ],
    },
  });
  t.resourceCountIs("AWS::Bedrock::DataSource", 3);
  t.allResourcesProperties("AWS::Bedrock::DataSource", {
    VectorIngestionConfiguration: {
      ChunkingConfiguration: { ChunkingStrategy: "NONE" },
    },
  });
  const doc = JSON.stringify(t.toJSON());
  assert.match(doc, /bedrock:Retrieve/);
  assert.match(doc, /AgentRoleNames/);
  assert.match(doc, /s3:if-none-match/);
  t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: "Deny",
          Action: Match.arrayWith(["bedrock:Retrieve", "s3vectors:*"]),
        }),
      ]),
    }),
  });
  t.resourceCountIs("AWS::DynamoDB::Table", 0);
  t.resourceCountIs("AWS::Lambda::Function", 0);
});
