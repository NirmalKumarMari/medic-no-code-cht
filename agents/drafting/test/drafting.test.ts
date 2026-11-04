import { test } from "node:test";
import assert from "node:assert/strict";
import { StructuredSpecSchema, type StructuredSpec } from "@vera/schemas";
import { DraftingAgent, extractJson, AGENT_LIMITS } from "../src/index.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model.js";
import type { Guardrail, GuardrailDecision } from "../src/guardrail.js";

class FakeModel implements ModelClient {
  readonly modelId = "fake";
  public lastRequest?: ModelRequest;
  public invoked = 0;
  constructor(private readonly reply: string) {}
  async invoke(req: ModelRequest): Promise<ModelResponse> {
    this.invoked += 1;
    this.lastRequest = req;
    return { text: this.reply, inputTokens: 100, outputTokens: 200 };
  }
}

class FakeGuardrail implements Guardrail {
  public screened?: string;
  constructor(private readonly decision: GuardrailDecision) {}
  async screenInput(text: string): Promise<GuardrailDecision> {
    this.screened = text;
    return this.decision;
  }
}

const spec: StructuredSpec = StructuredSpecSchema.parse({
  changeType: "new_pathway",
  changeId: "01JTESTCHANGEID0000000000",
  specVersion: 1,
  pathway: { id: "child-cough-fast-breathing", title: "Child cough and fast breathing" },
  guideline: { docId: "guidelines/imci-2014.pdf", title: "IMCI", version: "2014" },
  requestText: "Build the child cough and fast breathing pathway from the IMCI guideline.",
  constraints: ["Children under 2 months are out of scope."],
  submittedBy: { role: "program_officer", userId: "officer-1" },
  submittedAt: "2026-11-04T10:00:00.000Z",
  flags: [{ type: "missing_input", text: "Referral destination not specified." }],
});

const editSpec: StructuredSpec = StructuredSpecSchema.parse({
  changeType: "edit",
  changeId: "01JTESTCHANGEID0000000001",
  specVersion: 1,
  pathway: { id: "child-cough-fast-breathing", title: "Child cough and fast breathing" },
  requestText: "Raise the fast-breathing threshold for 12-59 month olds.",
  submittedBy: { role: "program_officer", userId: "officer-1" },
  submittedAt: "2026-11-04T10:00:00.000Z",
  baseline: { snapshotId: "child-cough-v1", snapshotHash: "abc123" },
});

const guidelineText = `Section: Danger signs (page 12)
A child with any general danger sign must be referred urgently.

Section: Classify and treat (page 14)
A child with fast breathing and no danger sign is treated at home with follow-up.`;

const goodLogicModel = {
  schemaVersion: "logic-model/v1",
  snapshotId: "child-cough-v1",
  pathway: "Child cough and fast breathing",
  guideline: { name: "IMCI", version: "2014" },
  inputs: [
    { id: "age_months", type: "integer", label: "Age in months" },
    { id: "breaths_per_min", type: "integer", label: "Breaths per minute" },
    { id: "danger_sign", type: "yes_no", label: "Any danger sign?" },
  ],
  rules: [
    {
      id: "r1",
      when: { input: "danger_sign", eq: "yes" },
      then: { action: "refer_urgently" },
      source: { section: "Danger signs", page: 12 },
    },
    {
      id: "default",
      when: { otherwise: true },
      then: { action: "home_care_advice" },
      source: { section: "Classify and treat", page: 14 },
    },
  ],
  flags: [],
};

test("produces a valid LogicModel from a well-formed model reply", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model);
  const result = await agent.draft({ spec, guidelineText });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.logicModel.pathway, "Child cough and fast breathing");
    assert.equal(result.logicModel.rules.length, 2);
    assert.equal(result.usage.modelTurns, AGENT_LIMITS.maxModelTurns);
  }
});

test("puts the guideline text in the cached context, spec in the user message", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model);
  await agent.draft({ spec, guidelineText });
  assert.match(model.lastRequest!.cachedContext!, /GUIDELINE TEXT/);
  assert.match(model.lastRequest!.cachedContext!, /A child with any general danger sign/);
  assert.match(model.lastRequest!.user, /SPECIFICATION/);
  assert.doesNotMatch(model.lastRequest!.user, /GUIDELINE TEXT/);
});

test("returns schema_invalid with Zod detail on a malformed model", async () => {
  const bad = structuredClone(goodLogicModel);
  // remove the catch-all -> schema violation
  bad.rules = bad.rules.filter((r) => r.id !== "default");
  const model = new FakeModel(JSON.stringify(bad));
  const agent = new DraftingAgent(model);
  const result = await agent.draft({ spec, guidelineText });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "schema_invalid");
    assert.ok(result.detail.length > 0);
  }
});

test("tells the model to flag a gap when no guideline text is supplied", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model);
  await agent.draft({ spec, guidelineText: "   " });
  assert.match(model.lastRequest!.cachedContext!, /no guideline text was provided/);
});

test("puts request text, constraints and intake flags in the prompt", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model);
  await agent.draft({ spec, guidelineText });
  const user = model.lastRequest!.user;
  assert.match(user, /Child cough and fast breathing \(id: child-cough-fast-breathing\)/);
  assert.match(user, /Guideline: IMCI \(version 2014\)/);
  assert.match(user, /Build the child cough and fast breathing pathway/);
  assert.match(user, /Children under 2 months are out of scope/);
  assert.match(user, /\[missing_input\] Referral destination not specified/);
});

test("edit spec: uses the caller-supplied guideline and shows the baseline", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model);
  const result = await agent.draft({
    spec: editSpec,
    guidelineText,
    guideline: { name: "IMCI", version: "2014" },
  });
  assert.equal(result.ok, true);
  assert.match(model.lastRequest!.user, /Baseline snapshot: child-cough-v1 \(hash abc123\)/);
  assert.match(model.lastRequest!.user, /Guideline: IMCI \(version 2014\)/);
});

test("edit spec without a guideline ref fails with invalid_input and no model call", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model);
  const result = await agent.draft({ spec: editSpec, guidelineText });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_input");
  assert.equal(model.invoked, 0);
});

test("returns no_json when the model emits prose", async () => {
  const model = new FakeModel("I'm sorry, I can't help with that.");
  const agent = new DraftingAgent(model);
  const result = await agent.draft({ spec, guidelineText });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_json");
});

test("blocks the model call when the guardrail intervenes", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const guardrail = new FakeGuardrail({
    intervened: true,
    reasons: ["pii:NAME"],
  });
  const agent = new DraftingAgent(model, { guardrail });
  const result = await agent.draft({ spec, guidelineText });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "guardrail_blocked");
    assert.match(result.detail, /pii:NAME/);
  }
  assert.equal(model.invoked, 0, "model must not be called after a guardrail block");
});

test("screens the full prompt (spec + guideline text) as input", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const guardrail = new FakeGuardrail({ intervened: false, reasons: [] });
  const agent = new DraftingAgent(model, { guardrail });
  await agent.draft({ spec, guidelineText });

  assert.ok(guardrail.screened, "guardrail received input");
  assert.match(guardrail.screened!, /SPECIFICATION/);
  assert.match(guardrail.screened!, /GUIDELINE TEXT/);
});

test("proceeds to the model when the guardrail passes", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const guardrail = new FakeGuardrail({ intervened: false, reasons: [] });
  const agent = new DraftingAgent(model, { guardrail });
  const result = await agent.draft({ spec, guidelineText });

  assert.equal(result.ok, true);
  assert.equal(model.invoked, 1);
});

test("extractJson handles fenced code blocks", () => {
  const wrapped = "Here you go:\n```json\n{\"a\":1}\n```\nthanks";
  assert.deepEqual(extractJson(wrapped), { a: 1 });
});

test("extractJson handles bare objects with trailing prose", () => {
  const messy = '{"a":{"b":2}} and some notes';
  assert.deepEqual(extractJson(messy), { a: { b: 2 } });
});
