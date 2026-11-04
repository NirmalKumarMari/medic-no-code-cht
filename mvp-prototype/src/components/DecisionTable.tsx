import type { LogicModel } from '../types/logic-model';
import { ACTION_LABELS, conditionsOf, isOtherwise } from '../types/logic-model';
import { describeCondition, describeFollowUp } from '../data/describe';

// Table view of the same logic. Some clinicians read decision tables faster
// than diagrams; both views read the one LogicModel.

export default function DecisionTable({ model }: { model: LogicModel }) {
  const captionId = `table-caption-${model.snapshotId}`;
  return (
    <div className="table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table className="decision-table">
        <caption id={captionId}>
          Rules are checked in order. The first one that matches decides the outcome.
        </caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">When (all must be true)</th>
            <th scope="col">Then</th>
            <th scope="col">Follow-up task</th>
            <th scope="col">Guideline reference</th>
          </tr>
        </thead>
        <tbody>
          {model.rules.map((rule, i) => {
            const otherwise = isOtherwise(rule);
            return (
              <tr key={rule.id}>
                <th scope="row">{otherwise ? 'Otherwise' : i + 1}</th>
                <td>
                  {otherwise ? (
                    'No rule above matched'
                  ) : (
                    <ul className="table-conditions">
                      {conditionsOf(rule).map((c, ci) => (
                        <li key={ci}>{describeCondition(c, model.inputs)}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{ACTION_LABELS[rule.then.action]}</td>
                <td>{rule.followUp ? describeFollowUp(rule.followUp) : 'None'}</td>
                <td>{rule.source?.section ?? 'Not given'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
