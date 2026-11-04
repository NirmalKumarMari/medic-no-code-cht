// Deterministic logic checks (design doc section 6, state 4). Plain code, no AI.
// A "problem" blocks approval; a "warning" is advisory.
//
// The reachability check is deliberately simple: it finds a rule that a single
// earlier rule fully covers, or whose own conditions contradict each other. It
// does not find a rule that is only covered by several earlier rules together.

import type { LogicCondition, LogicModel } from '../types/logic-model';
import { conditionsOf, isOtherwise } from '../types/logic-model';

export type CheckStatus = 'pass' | 'problem' | 'warning';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  details: string[];
}

/** True if every value that satisfies `d` also satisfies `c`. */
function implies(d: LogicCondition, c: LogicCondition): boolean {
  if (d.input !== c.input) return false;
  if (typeof d.value === 'number' && typeof c.value === 'number') {
    const a = d.value;
    const b = c.value;
    if (d.op === 'eq') return c.op === 'eq' ? a === b : c.op === 'gte' ? a >= b : a < b;
    if (d.op === 'gte') return c.op === 'gte' && a >= b;
    return c.op === 'lt' && a <= b;
  }
  return d.op === 'eq' && c.op === 'eq' && d.value === c.value;
}

/** True if no value can satisfy both conditions. */
function contradicts(p: LogicCondition, q: LogicCondition): boolean {
  if (p.input !== q.input) return false;
  if (typeof p.value !== 'number' || typeof q.value !== 'number') {
    return p.op === 'eq' && q.op === 'eq' && p.value !== q.value;
  }
  const check = (x: LogicCondition, y: LogicCondition): boolean | undefined => {
    const a = x.value as number;
    const b = y.value as number;
    if (x.op === 'eq' && y.op === 'eq') return a !== b;
    if (x.op === 'eq' && y.op === 'gte') return a < b;
    if (x.op === 'eq' && y.op === 'lt') return a >= b;
    if (x.op === 'gte' && y.op === 'lt') return a >= b;
    return undefined;
  };
  return check(p, q) ?? check(q, p) ?? false;
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function runChecks(model: LogicModel): CheckResult[] {
  const numbered = model.rules.filter((r) => !isOtherwise(r));
  const last = model.rules[model.rules.length - 1];
  const hasCatchAll = last !== undefined && isOtherwise(last);

  const blocked: string[] = [];
  numbered.forEach((rule, j) => {
    const conds = conditionsOf(rule);
    if (conds.some((p, x) => conds.some((q, y) => y > x && contradicts(p, q)))) {
      blocked.push(`Rule ${j + 1} can never match: two of its conditions cannot both be true.`);
      return;
    }
    const blocker = numbered.findIndex((earlier, i) => {
      const earlierConds = conditionsOf(earlier);
      return i < j && earlierConds.length > 0 && earlierConds.every((c) => conds.some((d) => implies(d, c)));
    });
    if (blocker !== -1) {
      blocked.push(
        `Rule ${j + 1} will never be used: every patient it matches is already matched by rule ${blocker + 1}, ` +
          `which is checked first. Move rule ${j + 1} higher or change its conditions.`,
      );
    }
  });

  const uncited = numbered.flatMap((r, i) => (r.source ? [] : [i + 1]));

  return [
    {
      id: 'catch-all',
      title: 'Every patient gets an outcome',
      status: hasCatchAll ? 'pass' : 'problem',
      summary: hasCatchAll
        ? 'Patients that no rule matches get the "otherwise" outcome.'
        : 'There is no "otherwise" rule, so some patients would get no outcome.',
      details: [],
    },
    {
      id: 'reachable',
      title: 'Every rule can be used',
      status: blocked.length ? 'problem' : 'pass',
      summary: blocked.length
        ? `${count(blocked.length, 'rule', 'rules')} can never be used.`
        : 'No rule is blocked by an earlier rule, and no rule has conflicting conditions.',
      details: blocked,
    },
    {
      id: 'citations',
      title: 'Every rule says where it comes from in the guideline',
      status: uncited.length ? 'warning' : 'pass',
      summary: uncited.length
        ? `${count(uncited.length, 'rule has', 'rules have')} no guideline reference. You can still approve, but check ${uncited.length === 1 ? 'it' : 'them'} against the guideline.`
        : 'Every rule has a guideline reference.',
      details: uncited.map((n) => `Rule ${n} has no guideline reference.`),
    },
  ];
}
