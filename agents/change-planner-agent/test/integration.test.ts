import test from "node:test";
import assert from "node:assert/strict";
import {
  StructuredSpecSchema,
  LogicModel as SharedLogicModel,
} from "@vera/schemas";
import { snapshotHash } from "@vera/workflow-data";
import { fixture } from "../src/fixture.js";
import { runChangePlannerAgent } from "../src/agent.js";
import { computeSnapshotHash } from "../src/logicModel.js";
test("current shared Intake -> planner -> shared LogicModel and workflow bundle", async () => {
  const f = fixture();
  const spec = StructuredSpecSchema.parse(f.request);
  let written: unknown;
  const result = await runChangePlannerAgent(
    spec,
    {
      async getBaselineSnapshot(ref, changeId) {
        assert.deepEqual(ref, { snapshotHash: spec.baselineSnapshotHash });
        assert.equal(changeId, spec.changeId);
        return f.baseline;
      },
      async writeChangePlanDraft(plan) {
        written = plan;
      },
    },
    async () => ({
      $metadata: {},
      stopReason: "end_turn",
      output: {
        message: {
          role: "assistant",
          content: [{ text: JSON.stringify(f.proposal) }],
        },
      },
    }),
  );
  assert.equal(result.requestKind, "plain_language_edit");
  assert.ok(SharedLogicModel.safeParse(result.proposedLogicModel).success);
  assert.equal(result.snapshotHash, snapshotHash(result.hashInputs));
  assert.equal(
    result.hashInputs.retrievalEvidenceRefs.at(-1)?.sha256,
    f.baseline.plannerContext.evidenceRef.sha256,
  );
  assert.equal(written, result);
});
test("new-pathway requests never call tools or model", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    runChangePlannerAgent(
      {
        ...f.request,
        requestKind: "pathway_pick",
        baselineSnapshotHash: undefined,
        editText: undefined,
      },
      {
        async getBaselineSnapshot() {
          calls++;
          return f.baseline;
        },
        async writeChangePlanDraft() {
          calls++;
        },
      },
      async () => {
        calls++;
        throw Error("must not call");
      },
    ),
  );
  assert.equal(calls, 0);
});
test("shared decimal, options and neq/in operators remain intact in a proposal", async () => {
  const f = fixture();
  f.baseline.logicModel.inputs.push(
    { id: "temperature", type: "decimal", label: "Temperature" },
    { id: "choice", type: "select_one", label: "Choice", options: ["a", "b"] },
  );
  f.baseline.logicModel.rules[0]!.when = {
    all: [
      { input: "temperature", gte: 38.5 },
      { input: "choice", in: ["a", "b"] },
      { input: "danger_sign", neq: "no" },
    ],
  };
  f.baseline.hashInputs.spec = JSON.parse(
    JSON.stringify(f.baseline.logicModel),
  );
  f.baseline.snapshotHash = computeSnapshotHash(f.baseline.hashInputs);
  f.request.baselineSnapshotHash = f.baseline.snapshotHash;
  f.proposal.proposedLogicModel = structuredClone(f.baseline.logicModel);
  f.proposal.proposedLogicModel.inputs[1]!.label = "Visit notes";
  const result = await runChangePlannerAgent(
    f.request,
    {
      async getBaselineSnapshot() {
        return f.baseline;
      },
      async writeChangePlanDraft() {},
    },
    async () => ({
      $metadata: {},
      stopReason: "end_turn",
      output: {
        message: {
          role: "assistant",
          content: [{ text: JSON.stringify(f.proposal) }],
        },
      },
    }),
  );
  assert.deepEqual(
    result.proposedLogicModel.rules[0]!.when,
    f.baseline.logicModel.rules[0]!.when,
  );
  assert.deepEqual(result.proposedLogicModel.inputs.at(-1)?.options, [
    "a",
    "b",
  ]);
});
