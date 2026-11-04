import assert from "node:assert/strict";
import test from "node:test";
import {
  runChangePlannerAgent,
  ChangePlannerAgentError,
  type ConverseFn,
} from "../src/agent.js";
import { computeSnapshotHash, canonicalStringify } from "../src/logicModel.js";
import { fixture } from "../src/fixture.js";
import type { ChangePlan } from "../src/schema.js";
import { config } from "../src/config.js";
function end(text: string) {
  return {
    $metadata: {},
    stopReason: "end_turn" as const,
    output: { message: { role: "assistant" as const, content: [{ text }] } },
    usage: {
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      cacheReadInputTokens: 4,
      cacheWriteInputTokens: 0,
    },
    metrics: { latencyMs: 1 },
  };
}
function harness() {
  const f = fixture();
  const writes: ChangePlan[] = [];
  let reads = 0;
  const tools = {
    async getBaselineSnapshot() {
      reads++;
      return structuredClone(f.baseline);
    },
    async writeChangePlanDraft(p: ChangePlan) {
      writes.push(p);
    },
  };
  return {
    ...f,
    tools,
    writes,
    get reads() {
      return reads;
    },
  };
}
async function code(p: Promise<unknown>, expected: string) {
  await assert.rejects(
    p,
    (e) => e instanceof ChangePlannerAgentError && e.code === expected,
  );
}
test("ADR-011: one Bedrock call, cached primer/full guideline, no model tools, deterministic read/write", async () => {
  const h = harness();
  let calls = 0;
  const before = structuredClone(h.baseline);
  const plan = await runChangePlannerAgent(
    h.request,
    h.tools,
    async (input) => {
      calls++;
      assert.equal(input.toolConfig, undefined);
      const content = input.messages![0]!.content!;
      assert.ok(content[1]?.cachePoint);
      const reference = content[0]!.text!;
      assert.ok(reference.includes("CHT engineering primer"));
      assert.ok(reference.includes(h.baseline.guideline!.text));
      assert.ok(!content[0]!.text!.includes(h.request.editText));
      return end(JSON.stringify(h.proposal));
    },
  );
  assert.equal(calls, 1);
  assert.equal(h.reads, 1);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.baseline, before);
  assert.equal(plan.riskLevel, "logic_clinical");
  assert.equal(plan.approvalStatus, "unapproved");
  assert.equal(plan.status, "proposed");
  assert.equal(plan.operations[0]!.op, "modify_rule");
  assert.equal(plan.snapshotHash, computeSnapshotHash(plan.hashInputs));
  assert.equal(plan.execution.usage[0]!.cacheReadInputTokens, 4);
});
test("code assigns fresh identifier and binds versioned primer to full bundle", async () => {
  const h = harness();
  const p = await runChangePlannerAgent(h.request, h.tools, async () =>
    end(JSON.stringify(h.proposal)),
  );
  assert.notEqual(p.snapshotId, h.baseline.logicModel.snapshotId);
  assert.equal(p.proposedLogicModel.snapshotId, p.snapshotId);
  assert.ok(
    p.hashInputs.evidenceVersions.some(
      (e) => e.sourceId === "cht-conventions-primer",
    ),
  );
  assert.deepEqual(p.hashInputs.spec, p.proposedLogicModel);
  assert.equal(p.hashInputs.baselineRevision, h.baseline.snapshotHash);
});
test("repair stays on primary; final repair escalates, three calls maximum", async () => {
  const h = harness();
  const models: string[] = [];
  const p = await runChangePlannerAgent(h.request, h.tools, async (input) => {
    models.push(input.modelId!);
    if (models.length > 1)
      assert.equal(input.messages!.at(-2)!.role, "assistant");
    return end(models.length < 3 ? "bad JSON" : JSON.stringify(h.proposal));
  });
  assert.deepEqual(models, [
    config.bedrock.draftModelId,
    config.bedrock.draftModelId,
    config.bedrock.escalationModelId,
  ]);
  assert.equal(p.execution.escalated, true);
});
test("exhausted repairs return no guessed or persisted proposal", async () => {
  const h = harness();
  let calls = 0;
  await code(
    runChangePlannerAgent(h.request, h.tools, async () => {
      calls++;
      return end("bad JSON");
    }),
    "INVALID_MODEL_OUTPUT",
  );
  assert.equal(calls, 3);
  assert.equal(h.writes.length, 0);
});
for (const reason of [
  "guardrail_intervened",
  "content_filtered",
  "tool_use",
  "max_tokens",
] as const)
  test(`${reason} is terminal, no repair/persistence`, async () => {
    const h = harness();
    let calls = 0;
    await assert.rejects(
      runChangePlannerAgent(h.request, h.tools, async () => {
        calls++;
        return { ...end("{}"), stopReason: reason };
      }),
    );
    assert.equal(calls, 1);
    assert.equal(h.writes.length, 0);
  });
test("provider/screening failures never escalate or persist", async () => {
  const h = harness();
  let calls = 0;
  await assert.rejects(
    runChangePlannerAgent(h.request, h.tools, async () => {
      calls++;
      throw Error("screening failed");
    }),
  );
  assert.equal(calls, 1);
  assert.equal(h.writes.length, 0);
});
for (const [name, mutate] of [
  [
    "tampered hash",
    (h: ReturnType<typeof harness>) => {
      h.baseline.snapshotHash = "a".repeat(64);
    },
  ],
  [
    "tampered bytes",
    (h: ReturnType<typeof harness>) => {
      h.baseline.logicModel.inputs[0]!.label = "Tampered";
    },
  ],
  [
    "wrong snapshot ID",
    (h: ReturnType<typeof harness>) => {
      h.baseline.logicModel.snapshotId = "wrong";
    },
  ],
  [
    "wrong primer pin",
    (h: ReturnType<typeof harness>) => {
      h.baseline.plannerContext.source.sourceS3Ref.sha256 = "a".repeat(64);
    },
  ],
  [
    "wrong guideline text",
    (h: ReturnType<typeof harness>) => {
      h.baseline.guideline!.text = "Changed guideline";
    },
  ],
] as const)
  test(`rejects ${name} before Bedrock`, async () => {
    const h = harness();
    mutate(h);
    let calls = 0;
    await assert.rejects(
      runChangePlannerAgent(h.request, h.tools, async () => {
        calls++;
        return end("{}");
      }),
    );
    assert.equal(calls, 0);
    assert.equal(h.writes.length, 0);
  });
test("uncited clinical edit becomes needs_clarification, never silently approved", async () => {
  const h = harness();
  delete h.proposal.proposedLogicModel.rules[0]!.source;
  const p = await runChangePlannerAgent(h.request, h.tools, async () =>
    end(JSON.stringify(h.proposal)),
  );
  assert.equal(p.status, "needs_clarification");
  assert.ok(p.flags.some((f) => f.text.includes("no guideline citation")));
  assert.deepEqual(p.flags, p.proposedLogicModel.flags);
});
test("missing guideline flags clinical edits, no fabricated grounding", async () => {
  const h = harness();
  delete h.baseline.guideline;
  const p = await runChangePlannerAgent(h.request, h.tools, async () =>
    end(JSON.stringify(h.proposal)),
  );
  assert.equal(p.status, "needs_clarification");
  assert.ok(p.flags.some((f) => f.text.includes("source quote")));
});
for (const [name, mutate] of [
  [
    "unknown field",
    (p: any) => {
      p.proposedLogicModel.rules[0].when = { input: "invented", eq: "yes" };
    },
  ],
  [
    "duplicate IDs",
    (p: any) => {
      p.proposedLogicModel.inputs.push(p.proposedLogicModel.inputs[0]);
    },
  ],
  [
    "invented approval",
    (p: any) => {
      p.approved = true;
    },
  ],
  [
    "pathway change",
    (p: any) => {
      p.proposedLogicModel.pathway = "Other";
    },
  ],
  [
    "raw expression",
    (p: any) => {
      p.proposedLogicModel.rules[0].when = "return true";
    },
  ],
] as const)
  test(`rejects ${name} after bounded repair`, async () => {
    const h = harness();
    mutate(h.proposal);
    await code(
      runChangePlannerAgent(h.request, h.tools, async () =>
        end(JSON.stringify(h.proposal)),
      ),
      "INVALID_MODEL_OUTPUT",
    );
    assert.equal(h.writes.length, 0);
  });
test("wording edit stays wording; metadata key order does not invent a diff", async () => {
  const h = harness();
  h.proposal.proposedLogicModel = structuredClone(h.baseline.logicModel);
  h.proposal.proposedLogicModel.inputs[1]!.label = "Visit notes";
  const p = await runChangePlannerAgent(h.request, h.tools, async () =>
    end(JSON.stringify(h.proposal)),
  );
  assert.equal(p.riskLevel, "wording");
  assert.equal(p.operations.length, 1);
});
test("rule reordering is a visible clinical change", async () => {
  const h = harness();
  h.proposal.proposedLogicModel = structuredClone(h.baseline.logicModel);
  h.proposal.proposedLogicModel.rules.reverse();
  const p = await runChangePlannerAgent(h.request, h.tools, async () =>
    end(JSON.stringify(h.proposal)),
  );
  assert.equal(p.riskLevel, "logic_clinical");
  assert.ok(p.operations.some((o) => o.op === "reorder_rules"));
});
test("missing request identifiers fail before any calls", async () => {
  const h = harness();
  await assert.rejects(
    runChangePlannerAgent({ ...h.request, changeId: "" }, h.tools, async () =>
      end("{}"),
    ),
  );
  assert.equal(h.reads, 0);
});
test("proposal store failure propagates instead of claiming success", async () => {
  const h = harness();
  h.tools.writeChangePlanDraft = async () => {
    throw Error("store unavailable");
  };
  await assert.rejects(
    runChangePlannerAgent(h.request, h.tools, async () =>
      end(JSON.stringify(h.proposal)),
    ),
  );
});
test("baseline flags cannot be silently cleared by a model", async () => {
  const h = harness();
  h.baseline.logicModel.flags = [{ type: "ambiguity", text: "Unresolved" }];
  h.baseline.hashInputs.spec = JSON.parse(
    JSON.stringify(h.baseline.logicModel),
  );
  h.baseline.snapshotHash = computeSnapshotHash(h.baseline.hashInputs);
  h.request.baselineSnapshotHash = h.baseline.snapshotHash;
  await code(
    runChangePlannerAgent(h.request, h.tools, async () =>
      end(JSON.stringify(h.proposal)),
    ),
    "INVALID_MODEL_OUTPUT",
  );
});
