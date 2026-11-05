import { App, BootstraplessSynthesizer } from "aws-cdk-lib";
import { StorageStack } from "./storage-stack.js";
import { WorkflowDataStack } from "./workflow-data-stack.js";
import { OrchestratorStack } from "../orchestrator/cdk/lib/orchestrator-stack.js";

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-west-2" };
new StorageStack(app, "VeraPreviewStorage", { env });
new WorkflowDataStack(app, "VeraPreviewData", { env, tablePrefix: "vera-preview" });
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw Error(`Missing ${name}`);
  return value;
};
new OrchestratorStack(app, "VeraPreviewPipeline", {
  env,
  synthesizer: new BootstraplessSynthesizer(),
  tablePrefix: "vera-preview",
  approvalWaitDays: 1,
  preview: {
    bucketArn: required("PREVIEW_BUCKET_ARN"),
    keyArn: required("PREVIEW_KEY_ARN"),
    guardrailArn: required("PREVIEW_GUARDRAIL_ARN"),
    workshopRoleArn: required("PREVIEW_WORKSHOP_ROLE_ARN"),
  },
});
