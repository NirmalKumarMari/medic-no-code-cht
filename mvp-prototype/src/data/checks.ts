// Deterministic logic checks (design doc section 6, state 3). Plain code, no AI.
// A "problem" blocks approval; a "warning" is advisory.
//
// These checks run every rule against every distinct case from buildPatientGrid,
// so "this rule can never be used" also catches a rule covered only by several
// earlier rules together.

import type { LogicModel, LogicRule } from '../types/logic-model';
import { actionLabel, hasCitation, isNumberType, isOtherwise } from '../types/logic-model';
import { findDisplayProblems } from './audit';
import { capitalise, describePatient } from './describe';
import type { Patient } from './evaluate';
import { buildPatientGrid, matches, usedInputIds } from './evaluate';

export type CheckStatus = 'pass' | 'problem' | 'warning';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  details: string[];
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function ruleName(rule: LogicRule, index: number): string {
  return isOtherwise(rule) ? 'the "otherwise" rule' : `rule ${index + 1}`;
}

function outcomeKey(rule: LogicRule): string {
  return JSON.stringify([rule.then.action, rule.followUp?.dueInDays, rule.followUp?.openForDays]);
}

/** The cases with the highest and lowest readings, the ones most worth a clinician's eye. */
function extremes(patients: Patient[], model: LogicModel): Patient[] {
  const numeric = model.inputs.filter((input) => isNumberType(input.type));
  const score = (p: Patient) => numeric.reduce((sum, input) => {
    const value = p[input.id];
    return typeof value === 'number' ? sum + value : sum;
  }, 0);
  const sorted = [...patients].sort((a, b) => score(b) - score(a));
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];
  return highest === lowest ? [highest] : [highest, lowest];
}

export function runChecks(model: LogicModel): CheckResult[] {
  const displayProblems = findDisplayProblems(model);
  const display: CheckResult = {
    id: 'display',
    title: 'Everything in this version can be shown to you',
    status: displayProblems.length ? 'problem' : 'pass',
    summary: displayProblems.length
      ? `${count(displayProblems.length, 'part', 'parts')} of this version cannot be shown correctly, so the other checks did not run. Do not approve it.`
      : 'Every question, condition and action below is shown exactly as stored.',
    details: displayProblems,
  };
  if (displayProblems.length) return [display];

  const { rules, inputs } = model;
  const last = rules[rules.length - 1];
  const hasCatchAll = last !== undefined && isOtherwise(last);
  const catchAll: CheckResult = {
    id: 'catch-all',
    title: 'Every patient gets an outcome',
    status: hasCatchAll ? 'pass' : 'problem',
    summary: hasCatchAll
      ? 'Patients that no rule matches get the "otherwise" outcome.'
      : 'There is no "otherwise" rule at the end, so some patients could get no outcome.',
    details: [],
  };

  const unused = inputs.filter((input) => !usedInputIds(model).has(input.id));
  const unusedCheck: CheckResult = {
    id: 'unused-questions',
    title: 'Every question affects an outcome',
    status: unused.length ? 'warning' : 'pass',
    summary: unused.length
      ? `${count(unused.length, 'question is', 'questions are')} not read by any rule.`
      : 'Every question is read by at least one rule.',
    details: unused.map((input) => `"${input.label}" is not read by any rule.`),
  };

  const uncited = rules.flatMap((rule, i) => (hasCitation(rule.source) ? [] : [ruleName(rule, i)]));
  const citations: CheckResult = {
    id: 'citations',
    title: 'Every rule says where it comes from in the guideline',
    status: uncited.length ? 'warning' : 'pass',
    summary: uncited.length
      ? `${count(uncited.length, 'rule has', 'rules have')} no guideline reference. Check ${uncited.length === 1 ? 'it' : 'them'} against the guideline.`
      : 'Every rule has a guideline reference.',
    details: uncited.map((name) => `${capitalise(name)} has no guideline reference.`),
  };

  const { patients, tooLarge } = buildPatientGrid(model);
  if (tooLarge) {
    return [
      display,
      catchAll,
      {
        id: 'grid',
        title: 'Every rule can be used',
        status: 'problem',
        summary: 'There are too many combinations of answers to test every case, so these checks did not run.',
        details: [],
      },
      unusedCheck,
      citations,
    ];
  }

  const decided = new Set<number>();
  const matchedAny = new Set<number>();
  const reachedOnlyCatchAll: Patient[] = [];
  const overlaps = new Map<string, { first: number; second: number; example: Patient }>();

  for (const patient of patients) {
    const matched = rules.flatMap((rule, i) => (matches(rule.when, patient) ? [i] : []));
    matched.forEach((i) => matchedAny.add(i));
    if (matched.length > 0) decided.add(matched[0]);
    if (matched.length > 0 && isOtherwise(rules[matched[0]])) reachedOnlyCatchAll.push(patient);

    const specific = matched.filter((i) => !isOtherwise(rules[i]));
    specific.forEach((first, x) => {
      specific.slice(x + 1).forEach((second) => {
        const key = `${first}:${second}`;
        if (outcomeKey(rules[first]) !== outcomeKey(rules[second]) && !overlaps.has(key)) {
          overlaps.set(key, { first, second, example: patient });
        }
      });
    });
  }

  const blocked = rules.flatMap((rule, i) => {
    if (decided.has(i) || isOtherwise(rule)) return [];
    const name = capitalise(ruleName(rule, i));
    return matchedAny.has(i)
      ? [`${name} will never be used: every patient it matches is already matched by a rule checked earlier. Move it higher or change its conditions.`]
      : [`${name} can never match: its conditions cannot all be true.`];
  });
  const reachable: CheckResult = {
    id: 'reachable',
    title: 'Every rule can be used',
    status: blocked.length ? 'problem' : 'pass',
    summary: blocked.length
      ? `${count(blocked.length, 'rule', 'rules')} can never be used.`
      : 'Each rule decides the outcome for at least one patient.',
    details: blocked,
  };

  const catchAllLabel = hasCatchAll ? actionLabel(last.then.action) : undefined;
  const coverage: CheckResult = {
    id: 'coverage',
    title: 'Patients covered only by the "otherwise" outcome',
    status: reachedOnlyCatchAll.length ? 'warning' : 'pass',
    summary: reachedOnlyCatchAll.length
      ? `${reachedOnlyCatchAll.length} of ${patients.length} tested combinations of answers match no specific rule and get "${catchAllLabel}". Check the guideline means this for them, including the examples below.`
      : 'No tested combination of answers relies on the "otherwise" outcome.',
    details: reachedOnlyCatchAll.length
      ? extremes(reachedOnlyCatchAll, model).map((patient) => describePatient(patient, inputs))
      : [],
  };

  const overlapDetails = [...overlaps.values()].map(({ first, second, example }) => {
    const firstName = ruleName(rules[first], first);
    return (
      `${capitalise(firstName)} and ${ruleName(rules[second], second)} can both match with different outcomes, ` +
      `for example: ${describePatient(example, inputs)}. ${capitalise(firstName)} is checked first, so it decides.`
    );
  });
  const overlap: CheckResult = {
    id: 'overlap',
    title: 'Rules that overlap with different outcomes',
    status: overlapDetails.length ? 'warning' : 'pass',
    summary: overlapDetails.length
      ? `${count(overlapDetails.length, 'pair of rules overlaps', 'pairs of rules overlap')}. Check the rule order matches the guideline.`
      : 'No two rules give different outcomes for the same patient.',
    details: overlapDetails,
  };

  return [display, catchAll, reachable, coverage, overlap, unusedCheck, citations];
}
