import type { LogicInput } from '../types/logic-model';
import { parseExpr } from '../types/logic-model';
import { describeLeaf } from '../data/describe';

// Shows a rule's condition, however deeply it is nested. Anything it cannot read
// is shown as a visible warning, never left out: an approver must not see fewer
// conditions than the compiler would read. The check in data/audit.ts blocks
// approval in the same cases.

function Unreadable() {
  return <strong className="expr-invalid">This condition cannot be shown. Do not approve this version.</strong>;
}

function Node({ expr, inputs }: { expr: unknown; inputs: LogicInput[] }) {
  const parsed = parseExpr(expr);
  switch (parsed.kind) {
    case 'leaf':
      return <>{describeLeaf(parsed.input, parsed.op, parsed.value, inputs)}</>;
    case 'otherwise':
      return <>No rule above matched</>;
    case 'not':
      return (
        <>
          This is not true:
          <ul className="expr-group">
            <li>
              <Node expr={parsed.item} inputs={inputs} />
            </li>
          </ul>
        </>
      );
    case 'all':
    case 'any':
      if (parsed.items.length === 0) return <Unreadable />;
      return (
        <>
          {parsed.kind === 'all' ? 'All of these:' : 'Any one of these:'}
          <ul className="expr-group">
            {parsed.items.map((item, i) => (
              <li key={i}>
                <Node expr={item} inputs={inputs} />
              </li>
            ))}
          </ul>
        </>
      );
    case 'invalid':
      return <Unreadable />;
  }
}

interface Props {
  expr: unknown;
  inputs: LogicInput[];
  /** The list style of the view it sits in. */
  className: string;
  /** Show "and" before each condition after the first, in a top-level "all". */
  showAnd?: boolean;
}

export default function ExprView({ expr, inputs, className, showAnd }: Props) {
  const parsed = parseExpr(expr);
  const items = parsed.kind === 'all' && parsed.items.length > 0 ? parsed.items : [expr];
  return (
    <ul className={className}>
      {items.map((item, i) => (
        <li key={i}>
          {showAnd && i > 0 && <span className="flow-and">and </span>}
          <Node expr={item} inputs={inputs} />
        </li>
      ))}
    </ul>
  );
}
