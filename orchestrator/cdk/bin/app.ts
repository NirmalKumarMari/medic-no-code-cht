import { App } from "aws-cdk-lib";
import { OrchestratorStack } from "../lib/orchestrator-stack.js";

const app = new App();

new OrchestratorStack(app, "MedicNoCodeOrchestrator", {
  description: "Step Functions orchestrator, pipeline state, and approval-wait glue for the Medic No-Code CHT Configuration project.",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
});
