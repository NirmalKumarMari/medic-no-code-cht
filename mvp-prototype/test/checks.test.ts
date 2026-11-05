import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDisplayProblems } from '../src/data/audit';
import { runChecks } from '../src/data/checks';
import { describeLeaf } from '../src/data/describe';
import { buildPatientGrid, matches } from '../src/data/evaluate';
import { emptyDraft, exampleDraft } from '../src/data/drafts';
import { buildLogicModel } from '../src/data/stubGenerator';
import { reviewDisplaySchema } from '@vera/review-model/data/display-schema';
import { statusLabel, statusTone } from '../src/data/status';
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

test('a high reading that reaches only the catch-all is reported, with an example', () => {
  const model = modelOf([rule('r1', { input: 'breaths', gt: 60 }, 'refer_urgently'), rule('r2', { all: [{ input: 'age', lt: 2 }, { input: 'breaths', lte: 60 }] }), OTHERWISE]);
  const coverage = check(model, 'coverage');
  assert.equal(coverage.status, 'warning');
  assert.ok(coverage.details.some((d) => d.includes('Age: 3') && d.includes('Breaths: 60')));
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
  ['an unknown comparison', { input: 'age', approx: 5 }, 'treat_at_home', /cannot read/],
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

test('the example uses the shared comparison shape, including more-than', () => {
  const { rules, pathway } = buildLogicModel(exampleDraft(), 1);
  assert.deepEqual(pathway, { id: 'newborn_danger_signs_at_a_postnatal_visit', title: 'Newborn danger signs at a postnatal visit' });
  assert.deepEqual(rules[2].when, { all: [{ input: 'breaths_per_minute_count_for_one_full_minute', gt: 60 }] });
  assert.equal(rules[5].source?.section?.includes('Recommendation 25'), true);
});

test('the example has every rule cited and no rule blocked', () => {
  const model = buildLogicModel(exampleDraft(), 1);
  assert.equal(check(model, 'citations').status, 'pass');
  assert.equal(check(model, 'reachable').status, 'pass');
});

for (const [name, when, yes, no] of [
  ['more than 60 excludes 60', { input: 'breaths', gt: 60 }, 61, 60],
  ['at most 60 includes 60', { input: 'breaths', lte: 60 }, 60, 61],
  ['not 60', { input: 'breaths', neq: 60 }, 61, 60],
  ['one of 59 or 61', { input: 'breaths', in: [59, 61] }, 61, 60],
] as const) {
  test(`shared operator: ${name}`, () => {
    assert.equal(matches(when, { breaths: yes }), true);
    assert.equal(matches(when, { breaths: no }), false);
    assert.deepEqual(findDisplayProblems(modelOf([rule('r1', when), OTHERWISE])), []);
  });
}

test('the shared operators read in plain language', () => {
  assert.equal(describeLeaf('breaths', 'gt', 60, inputs), 'Breaths: more than 60');
  assert.equal(describeLeaf('breaths', 'lte', 60, inputs), 'Breaths: at most 60');
  assert.equal(describeLeaf('danger', 'neq', 'yes', inputs), 'Danger sign? Not Yes');
  assert.equal(describeLeaf('breaths', 'in', [40, 60], inputs), 'Breaths: one of: 40, 60');
});

test('more-than is tested at its boundary', () => {
  const tested = buildPatientGrid(modelOf([rule('r1', { input: 'breaths', gt: 60 }), OTHERWISE])).patients.map((p) => p.breaths);
  assert.deepEqual(tested, [59, 60, 61]);
});

test('the display schema accepts a shared-schema model like the team reference', () => {
  const model = {
    schemaVersion: 'logic-model/v1',
    snapshotId: 's',
    pathway: { id: 'p', title: 'P' },
    guideline: { name: 'G', version: '2022' },
    inputs: [{ id: 'breaths', type: 'integer', label: 'Breaths' }, { id: 'temp', type: 'decimal', label: 'Temp' }],
    rules: [
      { id: 'r1', when: { input: 'breaths', gt: 60 }, then: { action: 'refer_urgently' }, source: { section: 'S', page: 13 } },
      { id: 'r2', when: { input: 'temp', lt: 35.5 }, then: { action: 'follow_up' } },
      { id: 'default', when: { otherwise: true }, then: { action: 'home_care_advice' } },
    ],
    flags: [{ type: 'gap', text: 'T', source: { section: 'S', page: 13 } }],
  };
  assert.equal(reviewDisplaySchema.safeParse(model).success, true);
  assert.equal(reviewDisplaySchema.safeParse({ ...model, rules: [{ ...model.rules[0], when: { input: 'breaths', approx: 60 } }] }).success, false);
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

test('status labels are plain words with the right colour group', () => {
  assert.deepEqual([statusLabel('content_approved'), statusTone('content_approved')], ['Approved', 'success']);
  assert.deepEqual([statusLabel('deployed'), statusTone('deployed')], ['Ready to install', 'success']);
  assert.deepEqual([statusLabel('content_review'), statusTone('content_review')], ['Needs review', 'attention']);
  assert.deepEqual([statusLabel('rejected'), statusTone('rejected')], ['Sent back', 'danger']);
  assert.deepEqual([statusLabel('test_failed'), statusTone('test_failed')], ['Tests failed', 'danger']);
  assert.deepEqual([statusLabel('some_new_state'), statusTone('some_new_state')], ['Some new state', 'neutral']);
});
