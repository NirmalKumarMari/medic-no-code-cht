import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { test } from "node:test";
import { matches } from "@vera/review-model/data/evaluate";
// @ts-expect-error plain JavaScript build script
import { chtSources, expression } from "../../scripts/preview-cht.mjs";
import { validateDraft } from "@vera/review-model/data/validate";
import { buildLogicModel } from "@vera/review-model/data/stubGenerator";
import { runChecks } from "../src/data/checks";
import { practiceDraft } from "../src/data/demoPrefill";
import { draftRequest } from "../src/data/draftRequest";
import { parseTestCases } from "../src/data/testCases";
import { runState, statusLabel } from "../src/data/status";

const evaluate = (expr: unknown, patient: Record<string, unknown>) =>
  new Script(`(a) => ${expression(expr)}`).runInNewContext(Object.create(null))(patient) as boolean;

const conditions = [
  { input: "n", eq: 5 }, { input: "n", neq: 5 }, { input: "n", gte: 5 }, { input: "n", gt: 5 },
  { input: "n", lte: 5 }, { input: "n", lt: 5 }, { input: "n", in: [4, 5] },
  { input: "s", eq: "yes" }, { input: "s", neq: "yes" }, { input: "s", in: ["no", "maybe"] },
  { input: "s", eq: true }, { input: "s", neq: false },
  { all: [{ input: "n", gt: 1 }, { input: "n", lte: 5 }] },
  { any: [{ input: "n", lt: 1 }, { input: "s", neq: "no" }] },
  { not: { input: "n", gt: 5 } },
  { otherwise: true },
];
const patients = [
  {}, { n: 4 }, { n: 4.999 }, { n: 5 }, { n: 5.001 }, { n: 6 }, { s: "yes" }, { s: "no" }, { s: "maybe" },
  { n: 5, s: "yes" }, { n: 0, s: "no" },
];

test("the compiled program agrees with the reviewed logic for every condition", () => {
  for (const condition of conditions)
    for (const patient of patients)
      assert.equal(
        evaluate(condition, patient),
        matches(condition, patient as Record<string, string | number>),
        `${JSON.stringify(condition)} with ${JSON.stringify(patient)}`,
      );
});

test("the compiler refuses a condition it does not understand", () => {
  assert.throws(() => expression({ input: "n", between: [1, 2] }));
  assert.throws(() => expression({ input: "n", gt: "five" }));
});

function chtRule(when: unknown) {
  const files = chtSources({
    snapshotHash: "a".repeat(64),
    pathway: { id: "p", title: "P" },
    inputs: [
      { id: "n", type: "integer", label: "N" },
      { id: "s", type: "select_one", label: "S", choices: ["yes", "no", "maybe"] },
    ],
    rules: [{ id: "r1", when, then: { action: "refer_urgently" } }],
  });
  const build = JSON.parse(files["VERA-BUILD.json"]);
  assert.ok(build.rules.rule_1);
  return files;
}

test("CHT forms build for every condition", () => {
  for (const condition of conditions) assert.ok(chtRule(condition));
  assert.throws(() => chtRule({ input: "n", between: [1, 2] }));
});

test("reads the team's golden cases file", () => {
  const url = new URL("../../testing/golden-cases/golden-cases.json", import.meta.url);
  const cases = parseTestCases(readFileSync(url, "utf8"));
  assert.equal(cases.length, 16);
  assert.equal(cases[0].action, "home_care_advice");
  assert.equal(cases[0].followUp, null);
  assert.equal(cases[0].inputs.feeding_well, "yes");
  assert.deepEqual(Object.keys(cases[0]).sort(), ["action", "followUp", "inputs"]);
});

test("reads a plain list and rejects bad files with a clear message", () => {
  assert.equal(parseTestCases('[{"inputs":{"a":"yes"},"action":"refer_urgently"}]').length, 1);
  assert.throws(() => parseTestCases("not json"), /valid JSON/);
  assert.throws(() => parseTestCases("[]"), /format/);
  assert.throws(() => parseTestCases('[{"inputs":{"a":"yes"},"action":"guess"}]'), /Test case 1/);
  assert.throws(() => parseTestCases('[{"action":"refer_urgently"}]'), /Test case 1/);
});

test("a run's status never claims more than happened", () => {
  assert.equal(runState("RUNNING"), "drafting");
  assert.equal(runState("RUNNING", "content_review"), "content_review");
  assert.equal(runState("FAILED"), "stopped");
  assert.equal(runState("FAILED", "content_review"), "stopped");
  assert.equal(runState("TIMED_OUT", "deploy_review"), "stopped");
  assert.equal(runState("FAILED", "test_failed"), "test_failed");
  assert.equal(statusLabel("deployed"), "Ready to install");
});

const EXAMPLE_IDS: Record<string, string> = {
  age_hours: "baby_s_age_in_hours",
  feeding_well: "is_the_baby_feeding_well",
  history_of_convulsions: "has_the_baby_had_convulsions_fits",
  breaths_per_min: "breaths_per_minute_count_for_one_full_minute",
  severe_chest_indrawing: "severe_chest_in_drawing",
  moves_spontaneously: "does_the_baby_move_on_its_own",
  temperature_c: "temperature_c",
  jaundice: "any_yellow_skin_or_eyes_jaundice",
  yellow_palms_soles: "yellow_palms_and_soles",
};

test("the prefilled newborn rules are valid and give every test case's answer", () => {
  const draft = practiceDraft();
  assert.deepEqual(validateDraft(draft), []);
  const model = buildLogicModel(draft, 1);
  assert.ok(!runChecks(model).some((c) => c.status === "problem"));
  const url = new URL("../src/assets/newborn-test-cases.json", import.meta.url);
  const cases = parseTestCases(readFileSync(url, "utf8"));
  assert.equal(cases.length, 16);
  for (const example of cases) {
    const patient = Object.fromEntries(
      Object.entries(example.inputs).map(([id, value]) => {
        assert.ok(EXAMPLE_IDS[id], id);
        return [EXAMPLE_IDS[id], value];
      }),
    ) as Record<string, string | number>;
    const action = model.rules.find((r) => matches(r.when, patient))?.then.action;
    assert.equal(action, example.action, JSON.stringify(example.inputs));
  }
  assert.ok(draftRequest(model).length <= 2000);
  const pdf = readFileSync(new URL("../src/assets/who-postnatal-2022-rec25-excerpt.pdf", import.meta.url));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});
