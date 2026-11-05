// Deterministically builds the flowchart model from validated human-entered requirements.
// Shared by the server and the review UI; no model calls or fabricated workflow evidence.

import type { OutcomeDraft, RequirementsDraft } from '../types/draft.js';
import type {
  FollowUp,
  LeafCondition,
  LogicInput,
  LogicModel,
  LogicRule,
} from '../types/logic-model.js';
import { isNumberType } from '../types/logic-model.js';
import { parseChoices } from './drafts.js';

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'item'
  );
}

function followUpOf(o: OutcomeDraft): { followUp?: FollowUp } {
  if (!o.followUp) return {};
  return { followUp: { dueInDays: Number(o.dueInDays), openForDays: Number(o.openForDays) } };
}

/** Assumes the draft has passed validateDraft. */
export function buildLogicModel(draft: RequirementsDraft, version: number): LogicModel {
  const usedIds = new Set<string>();
  const inputsByKey = new Map<string, LogicInput>();

  const inputs = draft.questions.map((q): LogicInput => {
    const base = slugify(q.label);
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}_${n}`;
    usedIds.add(id);
    const input: LogicInput = { id, type: q.type, label: q.label.trim() };
    if (q.type === 'select_one') input.choices = parseChoices(q.choices);
    inputsByKey.set(q.key, input);
    return input;
  });

  const rules = draft.rules.map((r, i): LogicRule => {
    const all = r.conditions.map((c): LeafCondition => {
      const input = inputsByKey.get(c.questionKey);
      const id = input?.id ?? 'unknown';
      if (input && isNumberType(input.type)) {
        return { input: id, [c.op]: Number(c.value) } as LeafCondition;
      }
      return { input: id, eq: c.value.trim() };
    });
    return {
      id: `r${i + 1}`,
      when: { all },
      then: { action: r.action },
      ...followUpOf(r),
      ...(r.source.trim() ? { source: { section: r.source.trim() } } : {}),
    };
  });

  rules.push({
    id: 'otherwise',
    when: { otherwise: true },
    then: { action: draft.otherwise.action },
    ...followUpOf(draft.otherwise),
    ...(draft.otherwiseSource.trim() ? { source: { section: draft.otherwiseSource.trim() } } : {}),
  });

  const guidelineVersion = draft.guidelineVersion.trim();
  return {
    snapshotId: `${slugify(draft.pathway)}-v${version}`,
    version,
    pathway: { id: slugify(draft.pathway), title: draft.pathway.trim() },
    guideline: {
      name: draft.guidelineName.trim(),
      ...(guidelineVersion ? { version: guidelineVersion } : {}),
    },
    inputs,
    rules,
    flags: [],
  };
}
