import { randomUuid } from "./identity.js";
import type {
  ConditionDraft,
  OutcomeDraft,
  QuestionDraft,
  RequirementsDraft,
  RuleDraft,
} from "../types/draft.js";
import type { ActionKind, Comparison } from "../types/logic-model.js";

/** Stable keys for list items, so React keeps focus and state on the right row. */
export function newKey(prefix: string): string {
  return `${prefix}-${randomUuid()}`;
}

export function parseChoices(raw: string): string[] {
  return raw
    .split(",")
    .map((choice) => choice.trim())
    .filter(Boolean);
}

export function emptyQuestion(): QuestionDraft {
  return { key: newKey("q"), label: "", type: "integer", choices: "" };
}

export function emptyCondition(): ConditionDraft {
  return { key: newKey("c"), questionKey: "", op: "gte", value: "" };
}

function emptyOutcome(): OutcomeDraft {
  return { action: "", followUp: false, dueInDays: "", openForDays: "" };
}

export function emptyRule(): RuleDraft {
  return {
    key: newKey("r"),
    conditions: [emptyCondition()],
    source: "",
    ...emptyOutcome(),
  };
}

export function emptyDraft(): RequirementsDraft {
  return {
    pathway: "",
    guidelineName: "",
    guidelineVersion: "",
    questions: [emptyQuestion()],
    rules: [emptyRule()],
    // Blank on purpose: the catch-all is a clinical decision, so nothing is preselected.
    otherwise: emptyOutcome(),
    otherwiseSource: "",
  };
}

/** True once the user has typed or chosen anything. */
export function hasContent(d: RequirementsDraft): boolean {
  return Boolean(
    d.pathway.trim() ||
    d.guidelineName.trim() ||
    d.guidelineVersion.trim() ||
    d.questions.some((q) => q.label.trim()) ||
    d.rules.some((r) =>
      r.conditions.some((c) => c.questionKey || c.value.trim()),
    ),
  );
}

function condition(
  questionKey: string,
  op: Comparison,
  value: string,
): ConditionDraft {
  return { key: newKey("c"), questionKey, op, value };
}

const REC_25 = "Executive summary, B. Newborn care, Recommendation 25, page 13";

function dangerSign(conditions: ConditionDraft[]): RuleDraft {
  return {
    key: newKey("r"),
    conditions,
    action: "refer_urgently" as ActionKind,
    followUp: false,
    dueInDays: "",
    openForDays: "",
    source: REC_25,
  };
}

/**
 * Illustrative example only, based on WHO postnatal care 2022, Recommendation
 * 25, matching the team's test data in testing/. It has not been reviewed by a
 * clinician and is not clinical guidance.
 */
export function exampleDraft(): RequirementsDraft {
  const age = newKey("q");
  const feeding = newKey("q");
  const convulsions = newKey("q");
  const breaths = newKey("q");
  const indrawing = newKey("q");
  const moves = newKey("q");
  const temperature = newKey("q");
  const jaundice = newKey("q");
  const palms = newKey("q");
  const question = (key: string, label: string, type: QuestionDraft["type"]): QuestionDraft => ({
    key,
    label,
    type,
    choices: "",
  });
  return {
    pathway: "Newborn danger signs at a postnatal visit",
    guidelineName: "WHO recommendations on maternal and newborn care for a positive postnatal experience",
    guidelineVersion: "2022",
    questions: [
      question(age, "Baby's age in hours", "integer"),
      question(feeding, "Is the baby feeding well?", "yes_no"),
      question(convulsions, "Has the baby had convulsions (fits)?", "yes_no"),
      question(breaths, "Breaths per minute (count for one full minute)", "integer"),
      question(indrawing, "Severe chest in-drawing?", "yes_no"),
      question(moves, "Does the baby move on its own?", "yes_no"),
      question(temperature, "Temperature (°C)", "decimal"),
      question(jaundice, "Any yellow skin or eyes (jaundice)?", "yes_no"),
      question(palms, "Yellow palms and soles?", "yes_no"),
    ],
    rules: [
      dangerSign([condition(feeding, "eq", "no")]),
      dangerSign([condition(convulsions, "eq", "yes")]),
      dangerSign([condition(breaths, "gt", "60")]),
      dangerSign([condition(indrawing, "eq", "yes")]),
      dangerSign([condition(moves, "eq", "no")]),
      dangerSign([condition(temperature, "gt", "37.5")]),
      dangerSign([condition(temperature, "lt", "35.5")]),
      dangerSign([condition(jaundice, "eq", "yes"), condition(age, "lt", "24")]),
      dangerSign([condition(palms, "eq", "yes")]),
    ],
    otherwise: { action: "home_care_advice", followUp: false, dueInDays: "", openForDays: "" },
    otherwiseSource: REC_25,
  };
}
