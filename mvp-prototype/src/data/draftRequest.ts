import type { LogicModel } from "../types/logic-model";

const MAX_REQUEST = 2000;

// Typed rules enter the pipeline as a request, so they pass through the same
// drafting, checks and approvals as an uploaded guideline.
export function draftRequest(model: LogicModel): string {
  const inputs = model.inputs.map((i) => `${i.type} input "${i.label}" with ID ${i.id}`).join("; ");
  const conditional = model.rules.filter((r) => !("otherwise" in r.when));
  const rules = conditional
    .map((r, n) => `${n + 1}. When ${JSON.stringify(r.when)}, ${r.then.action}.`)
    .join(" ");
  const fallback = model.rules.find((r) => "otherwise" in r.when)?.then.action;
  const followUps = model.rules.some((r) => r.followUp);
  const request =
    `Create the ${model.pathway.title} pathway exactly as specified. Inputs: ${inputs}. ` +
    `Conditional rules, in order: ${rules} Required final otherwise rule: ${fallback}. ` +
    `Do not add other rules. Include citations${followUps ? "" : " and no follow-up"}.`;
  if (request.length > MAX_REQUEST)
    throw new Error("These rules are too long to send. Shorten them and try again.");
  return request;
}
