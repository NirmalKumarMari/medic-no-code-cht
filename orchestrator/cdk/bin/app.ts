import { App } from "aws-cdk-lib";
import { OrchestratorStack } from "../lib/orchestrator-stack.js";

const app = new App();

new OrchestratorStack(app, "MedicNoCodeOrchestrator", {
  description: "Step Functions orchestrator and approval-wait glue for the Medic No-Code CHT Configuration project. Uses the existing vera-workflow tables.",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
  // Same variable infra/app.ts reads, so both stacks resolve the same table names.
  tablePrefix: process.env.WORKFLOW_TABLE_PREFIX,
});
