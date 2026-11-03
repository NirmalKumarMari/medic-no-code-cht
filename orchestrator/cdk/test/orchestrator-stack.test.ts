import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { OrchestratorStack } from "../lib/orchestrator-stack.js";

function synth() {
  const app = new App();
  const stack = new OrchestratorStack(app, "TestStack", { env: { account: "123456789012", region: "us-west-2" } });
  return Template.fromStack(stack);
}

test("provisions the four DynamoDB tables the design doc specifies", () => {
  const template = synth();
  for (const tableName of ["Changes", "Approvals", "Audit", "Tokens"]) {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: tableName,
      KeySchema: [
        { AttributeName: "changeId", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    });
  }
});

test("provisions exactly the two glue Lambdas, nothing else running app logic", () => {
  const template = synth();
  template.resourceCountIs("AWS::Lambda::Function", 2);
});

test("the two approval states use WAIT_FOR_TASK_TOKEN, not a plain invoke", () => {
  const template = synth();
  const stateMachines = template.findResources("AWS::StepFunctions::StateMachine");
  const [, machine] = Object.entries(stateMachines)[0]!;
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  const tokenMatches = definition.match(/waitForTaskToken/g) ?? [];
  assert.equal(tokenMatches.length, 2, "expected exactly two waitForTaskToken states (content + deploy approval)");
});

test("points-in-time recovery is on and tables are retained, never auto-deleted", () => {
  const template = synth();
  template.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain",
    Properties: { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } },
  });
});
