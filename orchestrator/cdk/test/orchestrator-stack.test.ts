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

test("creates no DynamoDB tables; the workflow-data stack owns them", () => {
  const template = synth();
  template.resourceCountIs("AWS::DynamoDB::Table", 0);
});

test("references the existing vera-workflow tables by default", () => {
  const json = JSON.stringify(synth().toJSON());
  assert.match(json, /table\/vera-workflow-Changes/);
  assert.match(json, /table\/vera-workflow-Tokens/);
  assert.match(json, /table\/vera-workflow-Approvals/);
  assert.match(json, /table\/vera-workflow-Audit/);
  // The approval-wait Lambda resolves all four names through workflow-data's tablesFromEnvironment.
  assert.match(json, /"WORKFLOW_TABLE_PREFIX":"vera-workflow"/);
  // No bare legacy names left over from this stack's old tables.
  assert.doesNotMatch(json, /table\/(Changes|Approvals|Audit|Tokens)"/);
});

test("honours a custom table prefix", () => {
  const app = new App();
  const stack = new OrchestratorStack(app, "PrefixStack", {
    env: { account: "123456789012", region: "us-west-2" },
    tablePrefix: "vera-test",
  });
  const json = JSON.stringify(Template.fromStack(stack).toJSON());
  assert.match(json, /"WORKFLOW_TABLE_PREFIX":"vera-test"/);
  assert.match(json, /table\/vera-test-Tokens/);
  assert.throws(() => new OrchestratorStack(new App(), "Bad", { tablePrefix: "bad prefix!" }));
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


