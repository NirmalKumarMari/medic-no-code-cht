import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StructuredSpecSchema } from "../src/structured-spec.js";

/**
 * Shared-contract cases for StructuredSpec. These are the SAME cases the Intake
 * Agent's schema is checked against (its schema.ts is kept byte-identical to
 * schemas/src/structured-spec.ts). Any drift between the two copies shows up
 * here or in the Intake Agent's own suite.
 *
 * Cases marked `docDisagrees` are where this schema (and the Intake code)
 * deliberately differ from .kiro/specs/logic-model-snapshots Requirement 4.
 * They are recorded, not resolved — see that spec's open question #7.
 */
interface Case {
  name: string;
  expect: "accept" | "reject";
  docDisagrees?: boolean;
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
