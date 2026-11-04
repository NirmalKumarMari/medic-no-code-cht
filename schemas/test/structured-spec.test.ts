import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StructuredSpecSchema } from "../src/structured-spec.js";

/**
 * Shared-contract cases for StructuredSpec. The master definition is
 * .kiro/specs/logic-model-snapshots Requirement 4 (reconciled: edit-text cap
 * 2,000 chars, submittedBy included). The Intake Agent imports this schema from
 * @vera/schemas rather than defining its own, so there is a single source of
 * truth and nothing can drift.
 */
interface Case {
  name: string;
  expect: "accept" | "reject";
  input: unknown;
}

const fixturesUrl = new URL("./fixtures/structured-spec-cases.json", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(fileURLToPath(fixturesUrl), "utf8"));

for (const c of cases) {
  test(`StructuredSpec ${c.expect}s: ${c.name}`, () => {
    const result = StructuredSpecSchema.safeParse(c.input);
    assert.equal(result.success, c.expect === "accept");
  });
}
