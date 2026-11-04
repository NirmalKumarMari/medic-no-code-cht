import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSnapshotHash,
  diffLogic,
  canonicalStringify,
  validateReferences,
} from "../src/logicModel.js";
import { fixture } from "../src/fixture.js";
test("bundle hash is deterministic, key-order-independent and binds every required component", () => {
  const { baseline } = fixture();
  const a = computeSnapshotHash(baseline.hashInputs);
  const reordered = Object.fromEntries(
    Object.entries(baseline.hashInputs).reverse(),
  );
  assert.equal(computeSnapshotHash(reordered as any), a);
  assert.equal(
    canonicalStringify({ z: 1, a: 2 }),
    canonicalStringify({ a: 2, z: 1 }),
  );
  for (const key of [
    "goldenCaseVersion",
    "compilerVersion",
    "baselineRevision",
  ] as const) {
    assert.notEqual(
      computeSnapshotHash({ ...baseline.hashInputs, [key]: "changed" }),
      a,
    );
  }
  assert.throws(() => computeSnapshotHash({ spec: {} } as any));
});
test("key ordering cannot create a fake clinical diff", () => {
  const { baseline } = fixture();
  const proposed = structuredClone(baseline.logicModel);
  const r = proposed.rules[0]!;
  proposed.rules[0] = {
    source: r.source,
    followUp: r.followUp,
    then: r.then,
    when: r.when,
    id: r.id,
  };
  assert.equal(diffLogic(baseline.logicModel, proposed).operations.length, 0);
});
test("adding/removing fields and reordering inputs are explicit clinical differences", () => {
  const { baseline } = fixture();
  const p = structuredClone(baseline.logicModel);
  p.inputs.reverse();
  assert.ok(
    diffLogic(baseline.logicModel, p).operations.some(
      (o) => o.op === "reorder_inputs",
    ),
  );
  p.inputs.push({ id: "new", type: "text", label: "New" });
  assert.ok(
    diffLogic(baseline.logicModel, p).operations.some(
      (o) => o.op === "add_input",
    ),
  );
  p.inputs = p.inputs.filter((f) => f.id !== "notes");
  assert.ok(
    diffLogic(baseline.logicModel, p).operations.some(
      (o) => o.op === "remove_input",
    ),
  );
});
test("typed numeric and select comparisons reject incompatible references", () => {
  const { baseline } = fixture();
  baseline.logicModel.rules[0]!.when = { input: "danger_sign", gt: 3 };
  assert.ok(validateReferences(baseline.logicModel).length);
  baseline.logicModel.inputs.push({
    id: "choice",
    type: "select_one",
    label: "Choose",
  });
  assert.ok(
    validateReferences(baseline.logicModel).some((i) =>
      i.includes("explicit options"),
    ),
  );
});
test("flags are visible in diff and force conservative classification", () => {
  const { baseline } = fixture();
  const p = structuredClone(baseline.logicModel);
  p.flags = [{ type: "ambiguity", text: "Review" }];
  const d = diffLogic(baseline.logicModel, p);
  assert.equal(d.operations[0]!.op, "set_flags");
  assert.equal(d.riskLevel, "logic_clinical");
});
