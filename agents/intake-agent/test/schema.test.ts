import assert from "node:assert/strict";
import test from "node:test";
import { IntakeRequestSchema, StructuredSpecSchema } from "../src/schema.js";

test("IntakeRequestSchema rejects a request with no requestText", () => {
  const result = IntakeRequestSchema.safeParse({
    changeId: "c1",
    requestKind: "guideline_upload",
    submittedBy: { role: "program_officer", userId: "x" },
  });
  assert.equal(result.success, false);
});

test("StructuredSpecSchema (shared) requires baseline + edit text for a plain_language_edit", () => {
  const edit = StructuredSpecSchema.safeParse({
    changeId: "c1",
    requestKind: "plain_language_edit",
    pathway: "P",
    guideline: { name: "IMCI", version: "2014" },
    submittedBy: { role: "program_officer", userId: "x" },
    baselineSnapshotHash: "a".repeat(64),
    editText: "shorten the follow-up to 2 days",
  });
  assert.equal(edit.success, true);

  const missingBaseline = StructuredSpecSchema.safeParse({
    changeId: "c1",
    requestKind: "plain_language_edit",
    pathway: "P",
    guideline: { name: "IMCI", version: "2014" },
    submittedBy: { role: "program_officer", userId: "x" },
    editText: "x",
  });
  assert.equal(missingBaseline.success, false, "edit specs must include a baseline snapshot hash");
});
