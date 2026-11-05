import { App } from "aws-cdk-lib";
import { StorageStack } from "./storage-stack.js";
import { WorkflowDataStack } from "./workflow-data-stack.js";

// One app, independently deployable stacks. Preserve existing stack/resource identities.
const app = new App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.AWS_REGION ?? "us-west-2",
};
new StorageStack(app, "BreakingBarriersStorage", { env });
new WorkflowDataStack(
  app,
  process.env.WORKFLOW_STACK_NAME ?? "vera-workflow-data",
  {
    env,
    tablePrefix: process.env.WORKFLOW_TABLE_PREFIX,
  },
);

// Opt-in identity/worker access stack; existing storage/table stack identities are preserved.
if (process.env.INCLUDE_REVIEW_ACCESS === "1") {
  const { ReviewAccessStack } = await import("./review-access-stack.js");
  new ReviewAccessStack(app, "VeraReviewAccess", { env });
}
