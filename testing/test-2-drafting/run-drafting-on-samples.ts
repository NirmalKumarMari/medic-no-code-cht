// Test 2: runs the team's real Drafting agent on every sample guideline and saves
// what it produced, so check-golden-cases.mjs can grade each one.
//
// Where to put it: copy this file into the repo's `scripts/` folder, and copy
// the `testing/` folder into the repo root.
//
// Run from the repo root (needs AWS credentials with Bedrock access in us-west-2):
//   npm install
//   npx tsx scripts/run-drafting-on-samples.ts
//
// Output: testing/drafting-outputs/<sample>.json (+ .error.txt if it failed)

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { DraftingAgent, BedrockModelClient, DEFAULT_MODEL_IDS } from "../agents/drafting/src/index.js";
import { StructuredSpecSchema } from "../schemas/src/structured-spec.js";

const TEXT_DIR = "testing/sample-pdfs/text";
const OUT_DIR = "testing/drafting-outputs";
const tier = (process.env.VERA_MODEL_TIER ?? "haiku") as "haiku" | "sonnet";
const modelId = process.env.VERA_MODEL_ID ?? DEFAULT_MODEL_IDS[tier];

mkdirSync(OUT_DIR, { recursive: true });
const agent = new DraftingAgent(new BedrockModelClient({ modelId, region: "us-west-2" }));

for (const file of readdirSync(TEXT_DIR).filter((f) => f.endsWith(".txt")).sort()) {
  const name = basename(file, ".txt");
  const spec = StructuredSpecSchema.parse({
    changeId: `test2-${name}`,
    requestKind: "guideline_upload",
    pathway: "Newborn danger signs at a postnatal visit",
    guideline: { name, version: "test" },
    submittedBy: { role: "program_officer", userId: "test-runner" },
  });
  const guidelineText = readFileSync(join(TEXT_DIR, file), "utf8");

  process.stdout.write(`${name} ... `);
  const started = Date.now();
  try {
    const result = await agent.draft({ spec, guidelineText });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (result.ok) {
      writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(result.logicModel, null, 2) + "\n");
      const flags = result.logicModel.flags?.length ?? 0;
      console.log(`OK in ${secs}s: ${result.logicModel.rules.length} rules, ${flags} flags, ` +
        `${result.usage.inputTokens ?? "?"} in / ${result.usage.outputTokens ?? "?"} out tokens`);
    } else {
      writeFileSync(join(OUT_DIR, `${name}.error.txt`), `${result.reason}\n\n${result.detail}\n\n${result.rawOutput ?? ""}`);
      console.log(`FAILED (${result.reason}) in ${secs}s. See ${name}.error.txt`);
    }
  } catch (err) {
    writeFileSync(join(OUT_DIR, `${name}.error.txt`), String(err));
    console.log(`ERROR: ${(err as Error).message}`);
  }
}
console.log(`\nNext: node testing/golden-cases/check-golden-cases.mjs ${OUT_DIR}/<sample>.json`);
