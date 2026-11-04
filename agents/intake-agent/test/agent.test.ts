import assert from "node:assert/strict";
import test from "node:test";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { IntakeAgentError, type ConverseFn, runIntakeAgent } from "../src/agent.js";
import type { Tools } from "../src/tools.js";

function fakeTools(): Tools & { written: unknown[] } {
  const written: unknown[] = [];
  return {
    written,
    async writeSpecDraft(spec) {
      written.push(spec);
    },
  };
}

/** What a well-behaved model returns: the spec body, minus the fields the agent overwrites. */
const modelReply = {
  changeId: "IGNORED-model-should-not-set-this",
  requestKind: "guideline_upload",
  pathway: "Child cough and fast breathing",
  guideline: { name: "WHO IMCI", version: "2023" },
  submittedBy: { role: "program_officer", userId: "IGNORED" },
};

const baseRequest = {
  changeId: "01JREQUEST000000000000000",
  requestKind: "guideline_upload",
  pathway: "Child cough and fast breathing",
  guideline: { name: "WHO IMCI", version: "2023" },
  requestText: "Draft a pathway for the attached WHO IMCI guideline, child cough and fast breathing.",
  submittedBy: { role: "program_officer", userId: "officer-1" },
};

const editRequest = {
  changeId: "01JREQUEST000000000000001",
  requestKind: "plain_language_edit",
  pathway: "Child cough and fast breathing",
  guideline: { name: "WHO IMCI", version: "2023" },
  requestText: "Raise the fast-breathing threshold for 12-59 month olds.",
  baselineSnapshotHash: "a".repeat(64),
  editText: "Raise the fast-breathing threshold for 12-59 month olds.",
  submittedBy: { role: "program_officer", userId: "officer-1" },
};

function endTurn(text: string): ConverseCommandOutput {
  return {
    stopReason: "end_turn",
    output: { message: { role: "assistant", content: [{ text }] } },
  } as ConverseCommandOutput;
}

test("happy path: one call, authoritative fields come from the request, not the model", async () => {
  const tools = fakeTools();
  let calls = 0;
  const converse: ConverseFn = async () => {
    calls += 1;
    return endTurn(JSON.stringify(modelReply));
  };

  const spec = await runIntakeAgent(baseRequest, tools, converse);

  assert.equal(calls, 1, "intake makes exactly one Bedrock call on the happy path");
  assert.equal(spec.changeId, "01JREQUEST000000000000000", "changeId comes from the request");
  assert.equal(spec.submittedBy.userId, "officer-1", "submittedBy comes from the request");
  assert.equal(spec.pathway, "Child cough and fast breathing");
  assert.equal(tools.written.length, 1);
});

test("edit: copies baseline hash and edit text through character for character", async () => {
  const tools = fakeTools();
  const converse: ConverseFn = async () =>
    endTurn(JSON.stringify({ ...modelReply, requestKind: "plain_language_edit" }));

  const spec = await runIntakeAgent(editRequest, tools, converse);
  assert.equal(spec.requestKind, "plain_language_edit");
  assert.equal(spec.baselineSnapshotHash, "a".repeat(64));
  assert.equal(spec.editText, "Raise the fast-breathing threshold for 12-59 month olds.");
});

test("schema repair: first response is malformed, second is valid", async () => {
  const tools = fakeTools();
  let call = 0;
  const converse: ConverseFn = async () => {
    call += 1;
    if (call === 1) return endTurn("not json at all");
    return endTurn(JSON.stringify(modelReply));
  };

  const spec = await runIntakeAgent(baseRequest, tools, converse);
  assert.equal(call, 2);
  assert.equal(spec.changeId, "01JREQUEST000000000000000");
});

test("gives up after exhausting repair attempts, never guesses", async () => {
  const tools = fakeTools();
  const converse: ConverseFn = async () => endTurn("still not json");

  await assert.rejects(() => runIntakeAgent(baseRequest, tools, converse), IntakeAgentError);
  assert.equal(tools.written.length, 0, "must never persist a guessed spec");
});

test("guardrail intervention fails immediately, no retry", async () => {
  const tools = fakeTools();
  let calls = 0;
  const converse: ConverseFn = async () => {
    calls += 1;
    return { stopReason: "guardrail_intervened", output: { message: { role: "assistant", content: [] } } } as ConverseCommandOutput;
  };

  await assert.rejects(() => runIntakeAgent(baseRequest, tools, converse), IntakeAgentError);
  assert.equal(calls, 1, "must not retry past a Guardrails block");
});

test("caller bug: guideline_upload without a guideline throws before calling Bedrock", async () => {
  const tools = fakeTools();
  let calls = 0;
  const converse: ConverseFn = async () => {
    calls += 1;
    return endTurn(JSON.stringify(modelReply));
  };

  await assert.rejects(
    () => runIntakeAgent({ ...baseRequest, guideline: undefined }, tools, converse),
    IntakeAgentError,
  );
  assert.equal(calls, 0);
});

test("caller bug: plain_language_edit without baseline hash throws before calling Bedrock", async () => {
  const tools = fakeTools();
  let calls = 0;
  const converse: ConverseFn = async () => {
    calls += 1;
    return endTurn(JSON.stringify(modelReply));
  };

  await assert.rejects(
    () => runIntakeAgent({ ...editRequest, baselineSnapshotHash: undefined }, tools, converse),
    IntakeAgentError,
  );
  assert.equal(calls, 0);
});
