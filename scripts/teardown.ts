import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { KMSClient, ScheduleKeyDeletionCommand } from "@aws-sdk/client-kms";
import { execFileSync } from "node:child_process";
const stack = "BreakingBarriersStorage";
if (process.env.CONFIRM_DELETE_STACK !== stack)
  throw Error(
    `This permanently deletes all object versions and schedules KMS deletion. Set CONFIRM_DELETE_STACK=${stack} only after exporting evidence.`,
  );
const r = await new CloudFormationClient({}).send(
  new DescribeStacksCommand({ StackName: stack }),
);
const outputs = Object.fromEntries(
  (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]),
);
for (const k of ["ArtifactBucket", "KbSourceBucket", "KmsKeyArn"])
  if (!outputs[k]) throw Error(`Missing stack output ${k}`);
const s3 = new S3Client({});
// Retain evidence by default; only this explicit command purges it. Never use on shared production resources.
for (const bucket of [outputs.ArtifactBucket, outputs.KbSourceBucket]) {
  for (;;) {
    const page = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }),
    );
    const Objects = [
      ...(page.Versions ?? []),
      ...(page.DeleteMarkers ?? []),
    ].map((v) => ({ Key: v.Key!, VersionId: v.VersionId! }));
    if (!Objects.length) break;
    const deleted = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects, Quiet: true },
      }),
    );
    if (deleted.Errors?.length)
      throw Error(
        "Object version deletion failed; stop before destroying stack",
      );
  }
}
// Deletes KB/data sources/index/vector bucket/IAM and policies. Sources must be quiescent before this command.
execFileSync("npx", ["cdk", "destroy", stack, "--force"], { stdio: "inherit" });
for (const Bucket of [outputs.ArtifactBucket, outputs.KbSourceBucket])
  await s3.send(new DeleteBucketCommand({ Bucket }));
await new KMSClient({}).send(
  new ScheduleKeyDeletionCommand({
    KeyId: outputs.KmsKeyArn,
    PendingWindowInDays: 7,
  }),
);
console.log(
  "Storage removed. Retained KMS key deletion is scheduled in seven days (AWS minimum). Verify CloudFormation and billing.",
);
