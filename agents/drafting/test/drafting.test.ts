import { test } from "node:test";
import assert from "node:assert/strict";
import { createStubRetriever } from "@vera/retrieval";
import { StructuredSpecPlaceholder } from "@vera/schemas";
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

const spec = StructuredSpecPlaceholder.parse({
  pathway: "Child cough and fast breathing",
  guideline: { name: "IMCI", version: "2014" },
  requirements: [
    { id: "req1", text: "A child with a danger sign is referred urgently." },
    { id: "req2", text: "Fast breathing without a danger sign is treated at home with follow-up." },
  ],
  candidateInputs: [
    { id: "age_months", label: "Age in months", type: "integer" },
    { id: "breaths_per_min", label: "Breaths per minute", type: "integer" },
    { id: "danger_sign", label: "Any danger sign?", type: "yes_no" },
  ],
  openQuestions: [],
});

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
      source: { section: "Danger signs", page: 12, chunkId: "gl-cc-danger-signs" },
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

test("produces a valid LogicModel from a well-formed model reply", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model, createStubRetriever());
  const result = await agent.draft({ spec });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.logicModel.pathway, "Child cough and fast breathing");
    assert.equal(result.logicModel.rules.length, 2);
    assert.ok(result.usage.toolCalls > 0);
    assert.ok(result.usage.toolCalls <= AGENT_LIMITS.maxToolCalls);
    assert.equal(result.usage.modelTurns, 1);
  }
});

test("passes retrieved guideline chunks into the prompt", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const agent = new DraftingAgent(model, createStubRetriever());
  await agent.draft({ spec });
  assert.match(model.lastRequest!.user, /RETRIEVED GUIDELINE PASSAGES/);
  assert.match(model.lastRequest!.user, /gl-cc-/); // a real chunkId made it in
});

test("returns schema_invalid with Zod detail on a malformed model", async () => {
  const bad = structuredClone(goodLogicModel);
  // remove the catch-all -> schema violation
  bad.rules = bad.rules.filter((r) => r.id !== "default");
  const model = new FakeModel(JSON.stringify(bad));
  const agent = new DraftingAgent(model, createStubRetriever());
  const result = await agent.draft({ spec });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "schema_invalid");
    assert.ok(result.detail.length > 0);
  }
});

test("returns no_json when the model emits prose", async () => {
  const model = new FakeModel("I'm sorry, I can't help with that.");
  const agent = new DraftingAgent(model, createStubRetriever());
  const result = await agent.draft({ spec });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_json");
});

test("blocks the model call when the guardrail intervenes", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const guardrail = new FakeGuardrail({
    intervened: true,
    reasons: ["pii:NAME"],
  });
  const agent = new DraftingAgent(model, createStubRetriever(), { guardrail });
  const result = await agent.draft({ spec });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "guardrail_blocked");
    assert.match(result.detail, /pii:NAME/);
  }
  assert.equal(model.invoked, 0, "model must not be called after a guardrail block");
});

test("screens the full prompt (spec + retrieved chunks) as input", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const guardrail = new FakeGuardrail({ intervened: false, reasons: [] });
  const agent = new DraftingAgent(model, createStubRetriever(), { guardrail });
  await agent.draft({ spec });

  assert.ok(guardrail.screened, "guardrail received input");
  assert.match(guardrail.screened!, /SPECIFICATION/);
  assert.match(guardrail.screened!, /RETRIEVED GUIDELINE PASSAGES/);
});

test("proceeds to the model when the guardrail passes", async () => {
  const model = new FakeModel(JSON.stringify(goodLogicModel));
  const guardrail = new FakeGuardrail({ intervened: false, reasons: [] });
  const agent = new DraftingAgent(model, createStubRetriever(), { guardrail });
  const result = await agent.draft({ spec });

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
