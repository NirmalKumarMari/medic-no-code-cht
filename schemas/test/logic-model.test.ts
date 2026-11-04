import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOGIC_MODEL_SCHEMA_VERSION,
  parseLogicModel,
} from "../src/logic-model.js";

/** A known-good child-cough LogicModel — the lock's positive fixture. */
const validModel = {
  schemaVersion: LOGIC_MODEL_SCHEMA_VERSION,
  snapshotId: "child-cough-v1",
  pathway: "Child cough and fast breathing",
  guideline: { name: "IMCI", version: "2014" },
  inputs: [
    { id: "age_months", type: "integer", label: "Child's age in months" },
    { id: "breaths_per_min", type: "integer", label: "Breaths per minute" },
    { id: "danger_sign", type: "yes_no", label: "Any danger sign?" },
  ],
  rules: [
    {
      id: "r1",
      when: { all: [{ input: "danger_sign", eq: "yes" }] },
      then: { action: "refer_urgently" },
      source: { section: "Danger signs", page: 12, chunkId: "gl-cc-danger-signs" },
    },
    {
      id: "r2",
      when: {
        all: [
          { input: "danger_sign", eq: "no" },
          { input: "age_months", gte: 2 },
          { input: "age_months", lt: 12 },
          { input: "breaths_per_min", gte: 50 },
        ],
      },
      then: { action: "treat_at_home" },
      followUp: { dueInDays: 3, openForDays: 4 },
      source: { section: "Classify and treat", page: 14, chunkId: "gl-cc-pneumonia-treatment" },
    },
    {
      id: "default",
      when: { otherwise: true },
      then: { action: "home_care_advice" },
      source: { section: "Classify and treat", page: 14, chunkId: "gl-cc-no-pneumonia" },
    },
  ],
  flags: [],
};

test("accepts a valid child-cough LogicModel", () => {
  const res = parseLogicModel(validModel);
  assert.equal(res.success, true, res.success ? "" : JSON.stringify(res.error.flatten()));
});

test("rejects an unknown condition operator", () => {
  const bad = structuredClone(validModel);
  // @ts-expect-error intentionally invalid operator
  bad.rules[0].when = { input: "danger_sign", matches: "yes" };
  assert.equal(parseLogicModel(bad).success, false);
});

test("rejects an unknown action", () => {
  const bad = structuredClone(validModel);
  // @ts-expect-error intentionally invalid action
  bad.rules[0].then.action = "escalate_to_doctor";
  assert.equal(parseLogicModel(bad).success, false);
});

test("rejects a model with no catch-all rule", () => {
  const bad = structuredClone(validModel);
  bad.rules = bad.rules.filter((r) => r.id !== "default");
  assert.equal(parseLogicModel(bad).success, false);
});

test("rejects more than one catch-all rule", () => {
  const bad = structuredClone(validModel);
  bad.rules.push({
    id: "default2",
    when: { otherwise: true },
    then: { action: "home_care_advice" },
    source: { section: "x", page: 1, chunkId: "c" },
  });
  assert.equal(parseLogicModel(bad).success, false);
});

test("rejects a condition referencing an undeclared input", () => {
  const bad = structuredClone(validModel);
  bad.rules[1].when = { all: [{ input: "temperature_c", gte: 38 }] };
  assert.equal(parseLogicModel(bad).success, false);
});

test("rejects duplicate rule ids", () => {
  const bad = structuredClone(validModel);
  bad.rules[1].id = "r1";
  assert.equal(parseLogicModel(bad).success, false);
});

test("rejects an unknown input type", () => {
  const bad = structuredClone(validModel);
  // @ts-expect-error intentionally invalid input type
  bad.inputs[0].type = "percentage";
  assert.equal(parseLogicModel(bad).success, false);
});
