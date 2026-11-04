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
import { execFileSync } from "node:child_process";
const stack = "BreakingBarriersStorage";
if (process.env.CONFIRM_DELETE_STACK !== stack)
  throw Error(
    `This permanently deletes artifact object versions. Set CONFIRM_DELETE_STACK=${stack} only after exporting evidence.`,
  );
const r = await new CloudFormationClient({}).send(
  new DescribeStacksCommand({ StackName: stack }),
);
const outputs = Object.fromEntries(
  (r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]),
);
if (
  outputs.KbSourceBucket ||
  outputs.KnowledgeBaseId ||
  outputs.VectorBucketArn
)
  throw Error(
    "Legacy indexed-storage stack detected. Review/export its resources before any destructive migration.",
  );
for (const k of ["ArtifactBucket", "KmsKeyArn"])
  if (!outputs[k]) throw Error(`Missing stack output ${k}`);
const s3 = new S3Client({});
// Retain evidence by default; only this explicit command purges it. Never use on shared production resources.
for (const bucket of [outputs.ArtifactBucket]) {
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
// Deletes input-screening and worker IAM resources. Stop all writers before this command.
// Legacy retained source buckets, if any, are deliberately never purged by this script.
execFileSync("npx", ["cdk", "destroy", stack, "--force"], { stdio: "inherit" });
for (const Bucket of [outputs.ArtifactBucket])
  await s3.send(new DeleteBucketCommand({ Bucket }));
console.log(
  "Current artifact store removed. The retained KMS key is NOT scheduled for deletion; review all historical encrypted objects before separate key cleanup. Verify CloudFormation and billing.",
);
