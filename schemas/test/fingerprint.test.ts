import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintRule, fingerprintLogicModel } from "../src/fingerprint.js";
import type { Rule, LogicModel } from "../src/logic-model.js";
import { LOGIC_MODEL_SCHEMA_VERSION } from "../src/logic-model.js";

const ruleA: Rule = {
  id: "r1",
  when: { all: [{ input: "danger_sign", eq: "yes" }, { input: "age_months", gte: 2 }] },
  then: { action: "refer_urgently" },
  source: { section: "Danger signs", page: 12, chunkId: "c1" },
};

test("fingerprint ignores rule id and citation", () => {
  const ruleB: Rule = {
    ...ruleA,
    id: "completely-different-id",
    source: { section: "Elsewhere", page: 99, chunkId: "c2" },
  };
  assert.equal(fingerprintRule(ruleA), fingerprintRule(ruleB));
});

test("fingerprint is order-independent inside all/any", () => {
  const reordered: Rule = {
    ...ruleA,
    when: { all: [{ input: "age_months", gte: 2 }, { input: "danger_sign", eq: "yes" }] },
  };
  assert.equal(fingerprintRule(ruleA), fingerprintRule(reordered));
});

test("fingerprint changes when the action changes", () => {
  const different: Rule = { ...ruleA, then: { action: "home_care_advice" } };
  assert.notEqual(fingerprintRule(ruleA), fingerprintRule(different));
});

test("fingerprint changes when follow-up changes", () => {
  const withFollowUp: Rule = { ...ruleA, followUp: { dueInDays: 3, openForDays: 4 } };
  assert.notEqual(fingerprintRule(ruleA), fingerprintRule(withFollowUp));
});

test("fingerprintLogicModel returns one fingerprint per rule, keyed by id", () => {
  const model: LogicModel = {
    schemaVersion: LOGIC_MODEL_SCHEMA_VERSION,
    snapshotId: "s1",
    pathway: "p",
    guideline: { name: "g", version: "1" },
    inputs: [{ id: "danger_sign", type: "yes_no", label: "x" }],
    rules: [
      {
        id: "r1",
        when: { input: "danger_sign", eq: "yes" },
        then: { action: "refer_urgently" },
        source: { section: "s", page: 1, chunkId: "c" },
      },
      { id: "default", when: { otherwise: true }, then: { action: "home_care_advice" } },
    ],
    flags: [],
  };
  const fps = fingerprintLogicModel(model);
  assert.equal(fps.length, 2);
  assert.deepEqual(fps.map((f) => f.ruleId), ["r1", "default"]);
});
