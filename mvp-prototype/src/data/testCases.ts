// Reads a test cases file into what the pipeline accepts. Takes either a plain
// list, or the team's golden-cases.json format with its "cases" and "expected".

const ACTIONS = ["refer_urgently", "home_care_advice", "treat_at_home", "follow_up"];
const MAX_CASES = 100;

export interface TestCase {
  inputs: Record<string, string | number | boolean>;
  action: string;
  followUp?: { dueInDays: number; openForDays: number } | null;
}

const UNREADABLE = "This file isn't in the test cases format.";

export function parseTestCases(text: string): TestCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid JSON.");
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { cases?: unknown })?.cases;
  if (!Array.isArray(list) || !list.length) throw new Error(UNREADABLE);
  if (list.length > MAX_CASES) throw new Error(`Use ${MAX_CASES} test cases or fewer.`);
  return list.map((item, index) => {
    const source = item?.expected ?? item;
    const inputs = item?.inputs;
    const validInputs =
      inputs &&
      typeof inputs === "object" &&
      !Array.isArray(inputs) &&
      Object.values(inputs).every((v) => ["string", "number", "boolean"].includes(typeof v));
    if (!validInputs || !ACTIONS.includes(source?.action))
      throw new Error(`Test case ${index + 1} needs its inputs and a known action.`);
    return {
      inputs,
      action: source.action,
      ...(source.followUp !== undefined ? { followUp: source.followUp } : {}),
    };
  });
}
