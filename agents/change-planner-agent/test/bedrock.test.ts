import assert from "node:assert/strict";
import test from "node:test";
import { createBedrockConverse } from "../src/agent.js";
import { config } from "../src/config.js";
const settings = {
  ...config,
  bedrock: {
    ...config.bedrock,
    guardrailId: "test-guardrail",
    guardrailVersion: "1",
  },
};
const input = {
  modelId: settings.bedrock.draftModelId,
  system: [{ text: "instructions" }],
  messages: [
    { role: "user" as const, content: [{ text: "guideline and request" }] },
  ],
};
test("complete system/messages are screened before Converse; records cache usage without content", async () => {
  const calls: string[] = [];
  const events: Record<string, unknown>[] = [];
  const converse = createBedrockConverse(
    {
      async send(command: any) {
        calls.push(command.constructor.name);
        if (command.constructor.name === "ApplyGuardrailCommand") {
          const screened = command.input.content[0].text.text;
          assert.ok(screened.includes("instructions"));
          assert.ok(screened.includes("guideline and request"));
          return { action: "NONE", assessments: [] };
        }
        return {
          stopReason: "end_turn",
          usage: { inputTokens: 12, outputTokens: 5, cacheReadInputTokens: 8 },
          output: { message: { role: "assistant", content: [{ text: "{}" }] } },
        };
      },
    } as any,
    settings,
    (e) => events.push(e),
  );
  await converse(input);
  assert.deepEqual(calls, ["ApplyGuardrailCommand", "ConverseCommand"]);
  assert.equal(events[1]!.cacheReadInputTokens, 8);
  assert.ok(!JSON.stringify(events).includes("guideline and request"));
});
for (const screen of [
  { action: "GUARDRAIL_INTERVENED" },
  {},
  {
    action: "NONE",
    assessments: [
      {
        sensitiveInformationPolicy: {
          piiEntities: [
            { type: "NAME", action: "ANONYMIZED", match: "secret" },
          ],
        },
      },
    ],
  },
])
  test("screening block/malformed/masked input never reaches model", async () => {
    let calls = 0;
    const converse = createBedrockConverse(
      {
        async send() {
          calls++;
          return screen;
        },
      } as any,
      settings,
    );
    await assert.rejects(converse(input));
    assert.equal(calls, 1);
  });
test("screening service error is terminal without model call", async () => {
  let calls = 0;
  const converse = createBedrockConverse(
    {
      async send() {
        calls++;
        throw Error("unavailable");
      },
    } as any,
    settings,
  );
  await assert.rejects(converse(input));
  assert.equal(calls, 1);
});
test("live setup refuses missing mandatory Guardrails", () => {
  assert.throws(() =>
    createBedrockConverse({} as any, {
      ...settings,
      bedrock: { ...settings.bedrock, guardrailId: undefined },
    }),
  );
});
