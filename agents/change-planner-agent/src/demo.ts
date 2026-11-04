import { runChangePlannerAgent } from "./agent.js";
import { fixture } from "./fixture.js";
const f = fixture();
const plan = await runChangePlannerAgent(
  f.request,
  {
    async getBaselineSnapshot() {
      return f.baseline;
    },
    async writeChangePlanDraft() {},
  },
  async () => ({
    $metadata: {},
    stopReason: "end_turn",
    output: {
      message: {
        role: "assistant",
        content: [{ text: JSON.stringify(f.proposal) }],
      },
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    metrics: { latencyMs: 0 },
  }),
);
console.log(JSON.stringify({ mode: "fixture-no-ai-no-aws", plan }, null, 2));
