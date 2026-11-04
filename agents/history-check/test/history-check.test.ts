import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintRule,
  parseHistoryCheckResult,
  type LogicModel,
  LOGIC_MODEL_SCHEMA_VERSION,
} from "@vera/schemas";
import { runHistoryCheck, StubDecisionLog } from "../src/index.js";

const referRule = {
  id: "r1",
  when: { input: "danger_sign", eq: "yes" } as const,
  then: { action: "refer_urgently" as const },
  source: { section: "Danger signs", page: 12 },
};

const model: LogicModel = {
  schemaVersion: LOGIC_MODEL_SCHEMA_VERSION,
  snapshotId: "child-cough-v2",
  pathway: "Child cough and fast breathing",
  guideline: { name: "IMCI", version: "2014" },
  inputs: [{ id: "danger_sign", type: "yes_no", label: "Any danger sign?" }],
  rules: [
    referRule,
    { id: "default", when: { otherwise: true }, then: { action: "home_care_advice" } },
  ],
  flags: [],
};

test("output always validates against the HistoryCheckResult schema", async () => {
  const result = await runHistoryCheck(
    { logicModel: model, tenant: "t1" },
    { decisionLog: new StubDecisionLog() },
  );
  assert.equal(parseHistoryCheckResult(result).success, true);
});

test("raises a high-severity flag on an exact match to a rejected rule", async () => {
  const fp = fingerprintRule(referRule);
  const result = await runHistoryCheck(
    { logicModel: model, tenant: "t1" },
    {
      decisionLog: new StubDecisionLog([
        {
          fingerprint: fp,
          changeId: "chg-123",
          disposition: "rejected",
          pathway: "Child cough and fast breathing",
          note: "clinician rejected: referral threshold too aggressive",
        },
      ]),
    },
  );

  const high = result.flags.find((f) => f.severity === "high");
  assert.ok(high, "expected a high-severity flag");
  assert.equal(high!.kind, "exact_fingerprint");
  assert.equal(high!.pastDisposition, "rejected");
  assert.equal(high!.ruleId, "r1");
  assert.match(high!.text, /REJECTED/);
});

test("exact match to an approved rule is info severity", async () => {
  const fp = fingerprintRule(referRule);
  const result = await runHistoryCheck(
    { logicModel: model, tenant: "t1" },
    {
      decisionLog: new StubDecisionLog([
        { fingerprint: fp, changeId: "chg-9", disposition: "approved", pathway: "Child cough and fast breathing" },
      ]),
    },
  );
  assert.equal(result.flags.length, 1);
  assert.equal(result.flags[0]!.severity, "info");
});

test("produces no flags when there is no history", async () => {
  const result = await runHistoryCheck(
    { logicModel: model, tenant: "t1" },
    { decisionLog: new StubDecisionLog() },
  );
  assert.equal(result.flags.length, 0);
});

test("high-severity flags sort to the top", async () => {
  const fp = fingerprintRule(referRule);
  const result = await runHistoryCheck(
    { logicModel: model, tenant: "t1" },
    {
      decisionLog: new StubDecisionLog([
        { fingerprint: fp, changeId: "chg-rej", disposition: "rejected", pathway: "Child cough and fast breathing" },
      ]),
    },
  );
  assert.equal(result.flags[0]!.severity, "high");
});
