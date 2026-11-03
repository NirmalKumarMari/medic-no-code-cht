import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalError, completeApproval, type Deps } from "../src/approvals.js";
import type { ApprovalDecisionRequest } from "../src/schema.js";

function fakeDeps(overrides: Partial<Deps> = {}): Deps & { sentTaskSuccess: unknown[]; approvalsWritten: unknown[] } {
  const sentTaskSuccess: unknown[] = [];
  const approvalsWritten: unknown[] = [];
  return {
    sentTaskSuccess,
    approvalsWritten,
    async getPendingToken(_changeId, kind) {
      return { taskToken: `token-${kind}`, summary: { changeId: "c1", snapshotHash: "hash-1", passed: true } };
    },
    async getChangeAuthorId() {
      return "officer-1";
    },
    async getOtherGateApproverId() {
      return undefined;
    },
    async putApprovalRecord(record) {
      approvalsWritten.push(record);
    },
    async putAuditRecord() {},
    async markTokenCompleted() {},
    async sendTaskSuccess(taskToken, outputPayload) {
      sentTaskSuccess.push({ taskToken, outputPayload });
    },
    ...overrides,
  };
}

const clinicianApproves: ApprovalDecisionRequest = {
  approverId: "clinician-1",
  approverRole: "clinician",
  decision: "approved",
};

test("happy path: content approval completes the token and writes an append-only record", async () => {
  const deps = fakeDeps();
  const result = await completeApproval("c1", "content", clinicianApproves, deps);

  assert.equal(result.approved, true);
  assert.equal(deps.sentTaskSuccess.length, 1);
  assert.equal(deps.approvalsWritten.length, 1);
  const [sent] = deps.sentTaskSuccess as { taskToken: string; outputPayload: Record<string, unknown> }[];
  assert.equal(sent.taskToken, "token-content");
  assert.equal(sent.outputPayload.approved, true);
  assert.equal(sent.outputPayload.snapshotHash, "hash-1", "must carry the exact snapshot forward, never a conversation");
});

test("rejects when there is no pending token for that gate", async () => {
  const deps = fakeDeps({ getPendingToken: async () => undefined });
  await assert.rejects(() => completeApproval("c1", "content", clinicianApproves, deps), ApprovalError);
  assert.equal(deps.sentTaskSuccess.length, 0);
});

test("separation of duties: the author cannot approve their own change", async () => {
  const deps = fakeDeps({ getChangeAuthorId: async () => "clinician-1" });
  await assert.rejects(() => completeApproval("c1", "content", clinicianApproves, deps), ApprovalError);
  assert.equal(deps.sentTaskSuccess.length, 0, "must not complete the token if SoD fails");
});

test("separation of duties: the same person cannot approve both gates", async () => {
  const deps = fakeDeps({ getOtherGateApproverId: async () => "clinician-1" });
  await assert.rejects(() => completeApproval("c1", "content", clinicianApproves, deps), ApprovalError);
});

test("role eligibility: only it_deploy may approve the deploy gate", async () => {
  const deps = fakeDeps();
  await assert.rejects(
    () => completeApproval("c1", "deploy", { ...clinicianApproves, approverRole: "clinician" }, deps),
    ApprovalError,
  );
});

test("role eligibility: it_deploy may not give content approval", async () => {
  const deps = fakeDeps();
  await assert.rejects(
    () => completeApproval("c1", "content", { ...clinicianApproves, approverRole: "it_deploy" }, deps),
    ApprovalError,
  );
});

test("a rejection still completes the token (so the reject loop can proceed), approved=false", async () => {
  const deps = fakeDeps();
  const result = await completeApproval("c1", "content", { ...clinicianApproves, decision: "rejected" }, deps);
  assert.equal(result.approved, false);
  assert.equal(deps.sentTaskSuccess.length, 1);
});
