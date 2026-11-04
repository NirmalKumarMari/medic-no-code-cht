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
  console.log({ account: identity.Account, principal: identity.Arn, region });
  const cfn = new CloudFormationClient({ region });
  for (const TypeName of [
    "AWS::S3::Bucket",
    "AWS::KMS::Key",
    "AWS::Bedrock::Guardrail",
    "AWS::Bedrock::GuardrailVersion",
  ])
    await cfn.send(new DescribeTypeCommand({ Type: "RESOURCE", TypeName }));
  console.log(
    "Source storage and input-screening resource types verified. Live S3/KMS/Guardrail permissions still require a smoke test. No indexing or embeddings are required.",
  );
} catch (error) {
  console.error("AWS preflight blocked:", (error as Error).name);
  process.exitCode = 1;
}
