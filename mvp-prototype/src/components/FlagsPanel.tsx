import type { LogicFlag, LogicRule } from "../types/logic-model";
import Citation from "./Citation";

// Everything the drafting step was unsure about, with its source passage (design
// rule 7). An open ambiguity blocks approval; see ReviewPanel.

const TYPE_TEXT = {
  ambiguity: "Unclear in the guideline",
  missing_input: "Missing information",
  gap: "Not covered by the guideline",
  uncited_rule: "No guideline reference",
  conflict: "Conflicting information",
} as const;

export function isOpenAmbiguity(flag: LogicFlag): boolean {
  return flag.type === "ambiguity" && !flag.resolved;
}

export default function FlagsPanel({
  flags,
  rules,
}: {
  flags: LogicFlag[];
  rules: LogicRule[];
}) {
  if (flags.length === 0) return null;
  function ruleName(ruleId: string) {
    const index = rules.findIndex((r) => r.id === ruleId);
    return index === -1 ? ruleId : `Rule ${index + 1}`;
  }
  return (
    <section className="card" aria-labelledby="flags-heading">
      <h3 id="flags-heading">Questions</h3>
      <ul className="checks">
        {flags.map((flag, i) => (
          <li
            key={i}
            className={`check ${flag.resolved ? "check-pass" : "check-warning"}`}
          >
            <span className="check-status">
              {flag.resolved ? "Answered" : "Open"}
            </span>
            <div>
              <strong>
                {TYPE_TEXT[flag.type] ?? flag.type}
                {flag.ruleId && ` · ${ruleName(flag.ruleId)}`}
              </strong>
              <p>{flag.text}</p>
              <p className="citation">
                <Citation source={flag.source} />
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
