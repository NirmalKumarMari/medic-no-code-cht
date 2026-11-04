import type { LogicModel } from '../types/logic-model';
import { ACTION_LABELS, conditionsOf, isOtherwise } from '../types/logic-model';
import { describeCondition, describeFollowUp } from '../data/describe';

// Accessible flowchart built from HTML (not a canvas), so screen readers can
// read it and it reflows on small screens. Each check has a "Yes" branch to
// its outcome and a "No" branch down to the next check, matching the
// first-match order of the rules.

export default function Flowchart({ model }: { model: LogicModel }) {
  const { rules } = model;
  return (
    <div className="flow">
      <div className="flow-start-col">
        <p className="flow-start">
          <span className="sr-only">Start: </span>Health worker assesses the patient
        </p>
        <p className="flow-down" aria-hidden="true">
          ↓
        </p>
      </div>
      <ol className="flow-steps" aria-label={`Flowchart for ${model.pathway}`}>
        {rules.map((rule, i) => {
          const otherwise = isOtherwise(rule);
          const next = i + 1 < rules.length - 1 ? `check ${i + 2}` : 'the "otherwise" outcome';
          return (
            <li key={rule.id} className="flow-step">
              <div className="flow-row">
                <div className={`flow-node flow-decision${otherwise ? ' flow-otherwise' : ''}`}>
                  <span className="flow-tag">{otherwise ? 'Otherwise' : `Check ${i + 1}`}</span>
                  {otherwise ? (
                    <p>None of the checks above matched</p>
                  ) : (
                    <ul className="flow-conditions">
                      {conditionsOf(rule).map((c, ci) => (
                        <li key={ci}>
                          {ci > 0 && <span className="flow-and">and </span>}
                          {describeCondition(c, model.inputs)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flow-arrow flow-arrow-yes" aria-hidden="true">
                  {!otherwise && <span className="flow-label">Yes</span>}
                  <span className="glyph-wide">→</span>
                  <span className="glyph-narrow">↓</span>
                </div>
                <div className={`flow-node flow-action flow-action-${rule.then.action}`}>
                  <span className="sr-only">{otherwise ? 'Outcome: ' : 'If yes: '}</span>
                  {rule.then.action === 'refer_urgently' && (
                    <span className="flow-urgent" aria-hidden="true">
                      Urgent
                    </span>
                  )}
                  <strong>{ACTION_LABELS[rule.then.action]}</strong>
                  {rule.followUp && <p>{describeFollowUp(rule.followUp)}</p>}
                  {rule.source && <p className="citation">Guideline: {rule.source.section}</p>}
                </div>
              </div>
              {!otherwise && (
                <div className="flow-no">
                  <span aria-hidden="true">
                    <span className="flow-label">No</span> ↓
                  </span>
                  <span className="sr-only">If no: go to {next}.</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
