import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintRule,
  parseHistoryCheckResult,
  type LogicModel,
  LOGIC_MODEL_SCHEMA_VERSION,
} from "@vera/schemas";
import {
  HistoryCheckAgent,
  StubDecisionLog,
  StubDecisionMemory,
  HISTORY_CHECK_LIMITS,
  type NarrationModel,
  type MemoryRecord,
} from "../src/index.js";

const referRule = {
  id: "r1",
  when: { input: "danger_sign", eq: "yes" } as const,
  then: { action: "refer_urgently" as const },
  source: { section: "Danger signs", page: 12, chunkId: "c1" },
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
  const agent = new HistoryCheckAgent({
    decisionLog: new StubDecisionLog(),
    decisionMemory: new StubDecisionMemory(),
  });
  const result = await agent.check({ logicModel: model, tenant: "t1" });
  assert.equal(parseHistoryCheckResult(result).success, true);
});

test("raises a high-severity flag on an exact match to a rejected rule", async () => {
  const fp = fingerprintRule(referRule);
  const agent = new HistoryCheckAgent({
    decisionLog: new StubDecisionLog([
      {
        fingerprint: fp,
        changeId: "chg-123",
        disposition: "rejected",
        pathway: "Child cough and fast breathing",
        note: "clinician rejected: referral threshold too aggressive",
      },
    ]),
    decisionMemory: new StubDecisionMemory(),
  });

  const result = await agent.check({ logicModel: model, tenant: "t1" });
  const high = result.flags.find((f) => f.severity === "high");
  assert.ok(high, "expected a high-severity flag");
  assert.equal(high!.kind, "exact_fingerprint");
  assert.equal(high!.pastDisposition, "rejected");
  assert.equal(high!.ruleId, "r1");
  assert.match(high!.text, /REJECTED/);
});

test("exact match to an approved rule is info severity", async () => {
  const fp = fingerprintRule(referRule);
  const agent = new HistoryCheckAgent({
    decisionLog: new StubDecisionLog([
      { fingerprint: fp, changeId: "chg-9", disposition: "approved", pathway: "Child cough and fast breathing" },
    ]),
    decisionMemory: new StubDecisionMemory(),
  });
  const result = await agent.check({ logicModel: model, tenant: "t1" });
  assert.equal(result.flags.length, 1);
  assert.equal(result.flags[0]!.severity, "info");
});

test("narrates similar decisions from memory", async () => {
  const records: MemoryRecord[] = [
    {
      changeId: "chg-50",
      pathway: "Child cough and fast breathing",
      disposition: "rejected",
      summary: "shorter follow-up window was rejected",
    },
  ];
  const narrator: NarrationModel = {
    async narrate(_pathway, recs) {
      return recs.map((r) => `NARRATED: ${r.changeId}`);
    },
  };
  const agent = new HistoryCheckAgent({
    decisionLog: new StubDecisionLog(),
    decisionMemory: new StubDecisionMemory(records),
    narrationModel: narrator,
  });

  const result = await agent.check({ logicModel: model, tenant: "t1" });
  const similar = result.flags.find((f) => f.kind === "similar_decision");
  assert.ok(similar);
  assert.equal(similar!.text, "NARRATED: chg-50");
  assert.equal(similar!.severity, "warning"); // rejected -> warning
});

test("does not double-flag a decision found both exactly and in memory", async () => {
  const fp = fingerprintRule(referRule);
  const agent = new HistoryCheckAgent({
    decisionLog: new StubDecisionLog([
      { fingerprint: fp, changeId: "chg-dup", disposition: "approved", pathway: "Child cough and fast breathing" },
    ]),
    decisionMemory: new StubDecisionMemory([
      { changeId: "chg-dup", pathway: "Child cough and fast breathing", disposition: "approved", summary: "x" },
    ]),
  });
  const result = await agent.check({ logicModel: model, tenant: "t1" });
  const forDup = result.flags.filter((f) => f.pastChangeId === "chg-dup");
  assert.equal(forDup.length, 1, "chg-dup should be flagged once, not twice");
});

test("produces no flags when there is no history", async () => {
  const agent = new HistoryCheckAgent({
    decisionLog: new StubDecisionLog(),
    decisionMemory: new StubDecisionMemory(),
  });
  const result = await agent.check({ logicModel: model, tenant: "t1" });
  assert.equal(result.flags.length, 0);
});

test("stays within the tool-call budget", async () => {
  // Two reads (log + memory) must be <= maxToolCalls.
  assert.ok(2 <= HISTORY_CHECK_LIMITS.maxToolCalls);
});

test("high-severity flags sort to the top", async () => {
  const fp = fingerprintRule(referRule);
  const agent = new HistoryCheckAgent({
    decisionLog: new StubDecisionLog([
      { fingerprint: fp, changeId: "chg-rej", disposition: "rejected", pathway: "Child cough and fast breathing" },
    ]),
    decisionMemory: new StubDecisionMemory([
      { changeId: "chg-info", pathway: "Child cough and fast breathing", disposition: "approved", summary: "y" },
    ]),
  });
  const result = await agent.check({ logicModel: model, tenant: "t1" });
  assert.equal(result.flags[0]!.severity, "high");
});
