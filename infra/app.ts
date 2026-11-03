import { App } from "aws-cdk-lib";
import { StorageStack } from "./storage-stack.js";
const app = new App();
new StorageStack(app, "BreakingBarriersStorage", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? "us-west-2",
  },
});
