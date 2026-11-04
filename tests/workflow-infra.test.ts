import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { WorkflowDataStack } from "../infra/workflow-data-stack.js";
import { test } from "node:test";
// Exercise CLI metadata defaults as well as the original programmatic synth path.
const app = new App({
  context: {
    "aws:cdk:enable-path-metadata": true,
    "aws:cdk:version-reporting": true,
  },
});
const template = Template.fromStack(
  new WorkflowDataStack(app, "vera-workflow-data"),
).toJSON();
test("IaC provisions exactly four on-demand, encrypted, retained and protected DynamoDB tables", () => {
  const resources = Object.values(template.Resources) as any[];
  assert.equal(resources.length, 4);
  for (const resource of resources) {
    assert.equal(resource.Type, "AWS::DynamoDB::Table");
    assert.equal(resource.Properties.BillingMode, "PAY_PER_REQUEST");
    assert.equal(resource.Properties.DeletionProtectionEnabled, true);
    assert.equal(resource.DeletionPolicy, "Retain");
    assert.equal(resource.UpdateReplacePolicy, "Retain");
    assert.equal(resource.Properties.SSESpecification.SSEEnabled, true);
    assert.equal(
      resource.Properties.PointInTimeRecoverySpecification
        .PointInTimeRecoveryEnabled,
      true,
    );
  }
});
test("only finished Tokens records have a TTL mechanism; callback GSI cannot expose secret attributes", () => {
  const resources = Object.values(template.Resources) as any[];
  const tokens = resources.find((r) =>
    r.Properties.TableName.endsWith("-Tokens"),
  );
  assert.equal(
    tokens.Properties.TimeToLiveSpecification.AttributeName,
    "cleanupAt",
  );
  assert.equal(
    tokens.Properties.GlobalSecondaryIndexes[0].Projection.ProjectionType,
    "KEYS_ONLY",
  );
  assert.equal(
    resources.filter((r) => r.Properties.TimeToLiveSpecification).length,
    1,
  );
  assert.ok(!resources.some((r) => r.Type.includes("IAM")));
});

test("workflow logical IDs, outputs and bootstrap-free template stay compatible with the deployed stack", () => {
  assert.deepEqual(Object.keys(template.Resources).sort(), [
    "Approvals8537C562",
    "Audit3D8ADE0A",
    "Changes510ED4B0",
    "Tokens1180AAEA",
  ]);
  assert.deepEqual(Object.keys(template.Outputs).sort(), [
    "ApprovalsTableArn",
    "ApprovalsTableName",
    "AuditTableArn",
    "AuditTableName",
    "ChangesTableArn",
    "ChangesTableName",
    "TokensTableArn",
    "TokensTableName",
  ]);
  assert.equal(template.Parameters, undefined);
  assert.equal(template.Rules, undefined);
});

test("workflow stack retains prefix overrides and rejects invalid resource names", () => {
  const custom = Template.fromStack(
    new WorkflowDataStack(new App(), "custom-workflow", {
      tablePrefix: "custom-tables",
    }),
  ).toJSON();
  assert.deepEqual(
    Object.values(custom.Resources)
      .map((r: any) => r.Properties.TableName)
      .sort(),
    [
      "custom-tables-Approvals",
      "custom-tables-Audit",
      "custom-tables-Changes",
      "custom-tables-Tokens",
    ],
  );
  for (const tablePrefix of ["", "invalid/prefix", "0invalid"]) {
    assert.throws(
      () => new WorkflowDataStack(new App(), "valid", { tablePrefix }),
      /Invalid resource prefix/,
    );
  }
  assert.throws(
    () => new WorkflowDataStack(new App(), "invalid/name"),
    /Invalid resource prefix/,
  );
});
