import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDisplayProblems } from '../src/data/audit';
import { runChecks } from '../src/data/checks';
import { describeLeaf } from '../src/data/describe';
import { buildPatientGrid, matches } from '../src/data/evaluate';
import { emptyDraft, exampleDraft } from '../src/data/drafts';
import { buildLogicModel } from '../src/data/stubGenerator';
import type { Expr, LogicModel, LogicRule } from '../src/types/logic-model';

const inputs: LogicModel['inputs'] = [
  { id: 'age', type: 'integer', label: 'Age' },
  { id: 'breaths', type: 'integer', label: 'Breaths' },
  { id: 'danger', type: 'yes_no', label: 'Danger sign?' },
];

function rule(id: string, when: unknown, action = 'treat_at_home'): LogicRule {
  return { id, when: when as Expr, then: { action }, source: { section: 'S' } };
}

const OTHERWISE = rule('otherwise', { otherwise: true }, 'home_care_advice');

function modelOf(rules: LogicRule[]): LogicModel {
  return { snapshotId: 's', pathway: { id: 'p', title: 'P' }, inputs, rules };
}

function check(model: LogicModel, id: string) {
  const result = runChecks(model).find((c) => c.id === id);
  assert.ok(result, `no ${id} check`);
  return result;
}

test('the example child at 61 months and 51 breaths is reported as reaching only the catch-all', () => {
  const coverage = check(buildLogicModel(exampleDraft(), 1), 'coverage');
  assert.equal(coverage.status, 'warning');
  assert.ok(coverage.details.some((d) => d.includes('age in months: 61') && d.includes('Breaths per minute: 51')));
});

test('a rule covered only by several earlier rules together is unreachable', () => {
  const model = modelOf([
    rule('r1', { all: [{ input: 'age', lt: 2 }] }),
    rule('r2', { all: [{ input: 'age', gte: 2 }] }),
    rule('r3', { all: [{ input: 'age', gte: 5 }] }, 'refer_urgently'),
    OTHERWISE,
  ]);
  const reachable = check(model, 'reachable');
  assert.equal(reachable.status, 'problem');
  assert.match(reachable.details.join(), /Rule 3 will never be used/);
});

test('a rule whose conditions cannot all be true is reported', () => {
  const model = modelOf([rule('r1', { all: [{ input: 'age', gte: 12 }, { input: 'age', lt: 2 }] }), OTHERWISE]);
  assert.match(check(model, 'reachable').details.join(), /Rule 1 can never match/);
});

test('overlapping rules with different outcomes are flagged, with an example', () => {
  const model = modelOf([
    rule('r1', { all: [{ input: 'danger', eq: 'yes' }] }, 'refer_urgently'),
    rule('r2', { all: [{ input: 'age', lt: 2 }] }),
    OTHERWISE,
  ]);
  const overlap = check(model, 'overlap');
  assert.equal(overlap.status, 'warning');
  assert.match(overlap.details[0], /Rule 1 and rule 2 can both match/);
});

test('a question no rule reads is flagged', () => {
  const model = modelOf([rule('r1', { all: [{ input: 'age', lt: 2 }] }), OTHERWISE]);
  assert.match(check(model, 'unused-questions').details.join(), /"Breaths"/);
});

test('a missing catch-all is a problem', () => {
  assert.equal(check(modelOf([rule('r1', { all: [{ input: 'age', lt: 2 }] })]), 'catch-all').status, 'problem');
});

test('a catch-all with no citation is reported', () => {
  const model = modelOf([
    rule('r1', { all: [{ input: 'age', lt: 2 }] }),
    { ...OTHERWISE, source: undefined },
  ]);
  assert.match(check(model, 'citations').details.join(), /"otherwise" rule/);
});

test('nested any and not are evaluated, so their rules count as reachable', () => {
  const model = modelOf([
    rule('r1', { any: [{ input: 'age', lt: 2 }, { not: { input: 'danger', eq: 'no' } }] }),
    OTHERWISE,
  ]);
  assert.deepEqual(findDisplayProblems(model), []);
  assert.equal(check(model, 'reachable').status, 'pass');
});

for (const [name, when, action, expected] of [
  ['an unknown comparison', { input: 'age', lte: 5 }, 'treat_at_home', /cannot read/],
  ['two comparisons in one condition', { input: 'age', gte: 1, lt: 5 }, 'treat_at_home', /cannot read/],
  ['an unknown question', { input: 'nope', eq: 1 }, 'treat_at_home', /does not exist/],
  ['an empty group', { all: [] }, 'treat_at_home', /empty group/],
  ['a number comparison on a yes or no question', { input: 'danger', gte: 1 }, 'treat_at_home', /number comparison/],
  ['an unknown action', { input: 'age', eq: 1 }, 'give_amoxicillin', /does not recognise/],
] as const) {
  test(`${name} blocks approval and stops the other checks`, () => {
    const results = runChecks(modelOf([rule('r1', when, action), OTHERWISE]));
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'problem');
    assert.match(results[0].details.join(), expected);
  });
}

test('a malformed model does not crash the checks', () => {
  const results = runChecks({ snapshotId: 's' } as unknown as LogicModel);
  assert.equal(results[0].status, 'problem');
});

test('an eq condition on a number question, as the agents send it, can be described', () => {
  assert.equal(describeLeaf('age', 'eq', 5, inputs), 'Age: exactly 5');
});

test('a yes or no answer sent as a boolean is understood', () => {
  const model = modelOf([rule('r1', { input: 'danger', eq: true }), OTHERWISE]);
  assert.deepEqual(findDisplayProblems(model), []);
  assert.equal(check(model, 'reachable').status, 'pass');
});

test('the form model uses the shared comparison shape', () => {
  const { rules, pathway } = buildLogicModel(exampleDraft(), 1);
  assert.deepEqual(pathway, { id: 'child_cough_and_fast_breathing', title: 'Child cough and fast breathing' });
  assert.deepEqual(rules[0].when, { all: [{ input: 'any_danger_sign_present', eq: 'yes' }] });
  assert.deepEqual(rules[1].when, { all: [{ input: 'child_s_age_in_months', lt: 2 }] });
});

test('a new draft does not preselect a clinical outcome', () => {
  assert.equal(emptyDraft().otherwise.action, '');
});

test('thresholds are exact: at least 50 includes 50, and less than 50 does not', () => {
  assert.equal(matches({ input: 'breaths', gte: 50 }, { breaths: 50 }), true);
  assert.equal(matches({ input: 'breaths', gte: 50 }, { breaths: 49 }), false);
  assert.equal(matches({ input: 'breaths', lt: 50 }, { breaths: 49 }), true);
  assert.equal(matches({ input: 'breaths', lt: 50 }, { breaths: 50 }), false);
});

test('the test cases include each threshold and the values either side of it', () => {
  const model = modelOf([rule('r1', { input: 'breaths', gte: 50 }), OTHERWISE]);
  const tested = buildPatientGrid(model).patients.map((p) => p.breaths);
  assert.deepEqual(tested, [49, 50, 51]);
});
