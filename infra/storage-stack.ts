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
import * as vectors from "aws-cdk-lib/aws-s3vectors";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Tags.of(this).add("project", "breaking-barriers");
    const agentRoles = new CfnParameter(this, "AgentRoleNames", {
      type: "CommaDelimitedList",
      description:
        "Every agent IAM role name; required explicit-deny attachment. Agents must also lack access to assume the service roles.",
    });
    const key = new kms.Key(this, "StorageKey", {
      enableKeyRotation: true,
      pendingWindow: Duration.days(7),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const makeBucket = (id: string) =>
      new s3.Bucket(this, id, {
        versioned: true,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: key,
        bucketKeyEnabled: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    const artifacts = makeBucket("Artifacts"),
      sources = makeBucket("KbSources");
    for (const b of [artifacts, sources]) {
      b.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:PutObject"],
          resources: [b.arnForObjects("*")],
          conditions: {
            StringNotEquals: { "s3:x-amz-server-side-encryption": "aws:kms" },
          },
        }),
      );
      b.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:PutObject"],
          resources: [b.arnForObjects("*")],
          conditions: {
            StringNotEquals: {
              "s3:x-amz-server-side-encryption-aws-kms-key-id": key.keyArn,
            },
          },
        }),
      );
      b.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:PutObject"],
          resources: [b.arnForObjects("*")],
          conditions: { Null: { "s3:if-none-match": "true" } },
        }),
      );
    }
    const vb = new vectors.CfnVectorBucket(this, "Vectors", {
      encryptionConfiguration: { sseType: "aws:kms", kmsKeyArn: key.keyArn },
    });
    const index = new vectors.CfnIndex(this, "EvidenceIndex", {
      vectorBucketArn: vb.attrVectorBucketArn,
      indexName: "evidence",
      dataType: "float32",
      dimension: 1024,
      distanceMetric: "cosine",
      metadataConfiguration: {
        nonFilterableMetadataKeys: [
          "AMAZON_BEDROCK_TEXT",
          "AMAZON_BEDROCK_METADATA",
        ],
      },
    });
    const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:${this.partition}:bedrock:${this.region}:${this.account}:knowledge-base/*`,
          },
        },
      }),
    });
    sources.grantRead(kbRole);
    key.grantEncryptDecrypt(kbRole);
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      }),
    );
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:GetIndex",
          "s3vectors:PutVectors",
          "s3vectors:DeleteVectors",
          "s3vectors:QueryVectors",
          "s3vectors:GetVectors",
          "s3vectors:ListVectors",
        ],
        resources: [index.attrIndexArn],
      }),
    );
    const kb = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${this.stackName}-evidence`,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: 1024,
              embeddingDataType: "FLOAT32",
            },
          },
        },
      },
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: { indexArn: index.attrIndexArn },
      },
    });
    kb.node.addDependency(kbRole);
    kb.node.addDependency(kbRole.node.findChild("DefaultPolicy"));

    for (const prefix of ["guideline", "cht-docs", "reference-config"]) {
      const source = new bedrock.CfnDataSource(this, `Source-${prefix}`, {
        knowledgeBaseId: kb.attrKnowledgeBaseId,
        name: prefix,
        dataDeletionPolicy: "DELETE",
        dataSourceConfiguration: {
          type: "S3",
          s3Configuration: {
            bucketArn: sources.bucketArn,
            inclusionPrefixes: [prefix + "/"],
          },
        },
        vectorIngestionConfiguration: {
          chunkingConfiguration: { chunkingStrategy: "NONE" },
        },
      });
      new CfnOutput(this, `${prefix}DataSourceId`, {
        value: source.attrDataSourceId,
      });
    }
    const guardrail = new bedrock.CfnGuardrail(this, "IngestionGuardrail", {
      name: `${this.stackName}-ingestion`,
      blockedInputMessaging: "Source rejected by screening.",
      blockedOutputsMessaging: "Source rejected by screening.",
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
    const gv = new bedrock.CfnGuardrailVersion(this, "ScreeningVersion", {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: "Published ingestion screening policy",
    });
    const retrieval = new iam.Role(this, "RetrievalServiceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    retrieval.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:Retrieve"],
        resources: [kb.attrKnowledgeBaseArn],
      }),
    );
    retrieval.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObjectVersion"],
        resources: [sources.arnForObjects("*")],
      }),
    );
    retrieval.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
        resources: [artifacts.arnForObjects("reports/*")],
      }),
    );
    key.grantEncryptDecrypt(retrieval);
    const ingestion = new iam.Role(this, "IngestionWorkerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    ingestion.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
        resources: [
          sources.arnForObjects("*"),
          artifacts.arnForObjects("docs/*"),
          artifacts.arnForObjects("reports/ingestion/*"),
        ],
      }),
    );
    ingestion.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:StartIngestionJob", "bedrock:GetIngestionJob"],
        resources: [kb.attrKnowledgeBaseArn],
      }),
    );
    key.grantEncryptDecrypt(ingestion);
    const artifactWorker = new iam.Role(this, "ArtifactWorkerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    artifactWorker.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
        resources: [artifacts.arnForObjects("*")],
      }),
    );
    artifactWorker.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucketVersions"],
        resources: [artifacts.bucketArn],
      }),
    );
    key.grantEncryptDecrypt(artifactWorker);
    for (const role of [retrieval, ingestion])
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:ApplyGuardrail"],
          resources: [guardrail.attrGuardrailArn],
        }),
      );
    new iam.CfnManagedPolicy(this, "AgentStorageDeny", {
      roles: agentRoles.valueAsList,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
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
            Resource: [sources.bucketArn, sources.arnForObjects("*")],
          },
          {
            Effect: "Deny",
            Action: ["sts:AssumeRole", "iam:PassRole"],
            Resource: [
              kbRole.roleArn,
              retrieval.roleArn,
              ingestion.roleArn,
              artifactWorker.roleArn,
            ],
          },
        ],
      },
    });
    for (const [name, value] of Object.entries({
      ArtifactBucket: artifacts.bucketName,
      KbSourceBucket: sources.bucketName,
      KmsKeyArn: key.keyArn,
      VectorBucketArn: vb.attrVectorBucketArn,
      VectorIndexArn: index.attrIndexArn,
      KnowledgeBaseId: kb.attrKnowledgeBaseId,
      KnowledgeBaseArn: kb.attrKnowledgeBaseArn,
      RetrievalServiceRoleArn: retrieval.roleArn,
      IngestionWorkerRoleArn: ingestion.roleArn,
      ArtifactWorkerRoleArn: artifactWorker.roleArn,
      GuardrailId: guardrail.attrGuardrailId,
      GuardrailVersion: gv.attrVersion,
    }))
      new CfnOutput(this, name, { value });
  }
}
