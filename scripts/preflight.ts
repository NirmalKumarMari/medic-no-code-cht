import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CloudFormationClient,
  DescribeTypeCommand,
} from "@aws-sdk/client-cloudformation";
try {
  const region = process.env.AWS_REGION ?? "us-west-2";
  const identity = await new STSClient({ region }).send(
    new GetCallerIdentityCommand({}),
  );
  console.log({
    account: identity.Account,
    principal: identity.Arn,
    region: process.env.AWS_REGION ?? "us-west-2",
  });
  const cfn = new CloudFormationClient({ region });
  for (const TypeName of [
    "AWS::S3Vectors::VectorBucket",
    "AWS::S3Vectors::Index",
    "AWS::Bedrock::KnowledgeBase",
  ])
    await cfn.send(new DescribeTypeCommand({ Type: "RESOURCE", TypeName }));
  console.log(
    "Identity and regional CloudFormation resource types verified. Deploy still needs quota/model/KMS/IAM permissions and a live ingestion/retrieval smoke test.",
  );
} catch (error) {
  console.error(
    "AWS preflight blocked:",
    (error as Error).name,
    (error as Error).message,
  );
  process.exitCode = 1;
}
