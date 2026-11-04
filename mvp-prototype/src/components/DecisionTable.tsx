import type { LogicModel } from '../types/logic-model';
import { actionLabel, isOtherwise } from '../types/logic-model';
import { describeFollowUp } from '../data/describe';
import Citation from './Citation';
import ExprView from './ExprView';

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
            <th scope="col">When</th>
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
                    <ExprView expr={rule.when} inputs={model.inputs} className="table-conditions" />
                  )}
                </td>
                <td>{actionLabel(rule.then.action) ?? <strong className="expr-invalid">Unknown action: {String(rule.then.action)}</strong>}</td>
                <td>{rule.followUp ? describeFollowUp(rule.followUp) : 'None'}</td>
                <td>
                  <Citation source={rule.source} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
