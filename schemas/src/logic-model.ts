import { z } from "zod";

/**
 * LogicModel schema — the single structured snapshot that is the source of truth
 * for the approver view, the logic checks, the compiler, and the expected test
 * outcomes (solution design §10).
 *
 * This file is the LOCK: every model output is validated against it before use
 * (design rule: "every model output is schema-checked before use"). The closed
 * vocabularies below are deliberate — the compiler can only deterministically
 * split operators/actions it knows, so agents must never emit anything outside
 * these enums.
 *
 * Schema version is folded into the snapshotHash composition, so any change here
 * forces new hashes and new human approvals downstream.
 */
export const LOGIC_MODEL_SCHEMA_VERSION = "logic-model/v1" as const;

/* ------------------------------------------------------------------ */
/* Closed vocabularies (locked)                                        */
/* ------------------------------------------------------------------ */

/** Operators allowed in a rule's `when` condition. */
export const ConditionOperator = z.enum([
  "eq",
  "neq",
  "gte",
  "lte",
  "gt",
  "lt",
  "in",
  "all",
  "any",
  "not",
  "otherwise",
]);
export type ConditionOperator = z.infer<typeof ConditionOperator>;

/** Actions a rule may take in its `then`. */
export const RuleAction = z.enum([
  "refer_urgently",
  "home_care_advice",
  "treat_at_home",
  "follow_up",
]);
export type RuleAction = z.infer<typeof RuleAction>;

/** Flag categories the drafting agent can raise for a human. */
export const FlagType = z.enum([
  "ambiguity",
  "gap",
  "uncited_rule",
  "conflict",
]);
export type FlagType = z.infer<typeof FlagType>;

/** Input (question) data types available to a pathway. */
export const InputType = z.enum([
  "integer",
  "decimal",
  "yes_no",
  "select_one",
  "select_multiple",
  "text",
  "date",
]);
export type InputType = z.infer<typeof InputType>;

/* ------------------------------------------------------------------ */
/* Leaf shapes                                                         */
/* ------------------------------------------------------------------ */

/**
 * A citation back to the guideline passage a rule was drawn from.
 * Every rule must carry one; a rule drafted with no citation is flagged
 * (uncited_rule), never silently accepted.
 */
export const Citation = z.object({
  /** Guideline section identifier or heading. */
  section: z.string().min(1),
  /** Page number in the source guideline (0 when not applicable). */
  page: z.number().int().nonnegative(),
  /** Optional decision-table / chart identifier when the rule came from a table. */
  tableId: z.string().min(1).optional(),
  /**
   * Opaque id of the exact retrieved KB chunk this citation was grounded in.
   * Set by the drafting agent from the retrieval service's response so the
   * citation is auditable back to a specific chunk.
   */
  chunkId: z.string().min(1).optional(),
});
export type Citation = z.infer<typeof Citation>;

/** A single data point the pathway collects. */
export const Input = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "input id must be snake_case starting with a letter"),
  type: InputType,
  label: z.string().min(1),
  /** Required for select_one / select_multiple; option values. */
  options: z.array(z.string().min(1)).optional(),
});
export type Input = z.infer<typeof Input>;

/* ------------------------------------------------------------------ */
/* Conditions (recursive)                                              */
/* ------------------------------------------------------------------ */

/**
 * A rule's `when` condition. Either:
 *  - a leaf comparison against an input (eq/neq/gte/lte/gt/lt/in),
 *  - a boolean combinator over sub-conditions (all/any/not),
 *  - or the catch-all `otherwise` (used by the default rule only).
 *
 * Comparisons and combinators are modelled as a discriminated-ish union via a
 * superRefine so the compiler gets a predictable shape for every operator.
 */
export type Condition =
  | { input: string; eq: string | number | boolean }
  | { input: string; neq: string | number | boolean }
  | { input: string; gte: number }
  | { input: string; lte: number }
  | { input: string; gt: number }
  | { input: string; lt: number }
  | { input: string; in: Array<string | number> }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { otherwise: true };

const Primitive = z.union([z.string(), z.number(), z.boolean()]);

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ input: z.string().min(1), eq: Primitive }).strict(),
    z.object({ input: z.string().min(1), neq: Primitive }).strict(),
    z.object({ input: z.string().min(1), gte: z.number() }).strict(),
    z.object({ input: z.string().min(1), lte: z.number() }).strict(),
    z.object({ input: z.string().min(1), gt: z.number() }).strict(),
    z.object({ input: z.string().min(1), lt: z.number() }).strict(),
    z.object({ input: z.string().min(1), in: z.array(z.union([z.string(), z.number()])).min(1) }).strict(),
    z.object({ all: z.array(Condition).min(1) }).strict(),
    z.object({ any: z.array(Condition).min(1) }).strict(),
    z.object({ not: Condition }).strict(),
    z.object({ otherwise: z.literal(true) }).strict(),
  ]),
);

/* ------------------------------------------------------------------ */
/* Rules, flags, model                                                 */
/* ------------------------------------------------------------------ */

/** Follow-up scheduling for a rule, split deterministically by the compiler. */
export const FollowUp = z.object({
  dueInDays: z.number().int().nonnegative(),
  openForDays: z.number().int().nonnegative(),
});
export type FollowUp = z.infer<typeof FollowUp>;

export const RuleThen = z.object({
  action: RuleAction,
});
export type RuleThen = z.infer<typeof RuleThen>;

export const Rule = z.object({
  id: z.string().min(1),
  when: Condition,
  then: RuleThen,
  followUp: FollowUp.optional(),
  /** Required on every rule; absence must be surfaced as an `uncited_rule` flag. */
  source: Citation.optional(),
});
export type Rule = z.infer<typeof Rule>;

export const Flag = z.object({
  type: FlagType,
  text: z.string().min(1),
  /** The rule this flag concerns, when applicable. */
  ruleId: z.string().min(1).optional(),
  source: Citation.optional(),
});
export type Flag = z.infer<typeof Flag>;

export const Guideline = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type Guideline = z.infer<typeof Guideline>;

export const LogicModel = z
  .object({
    schemaVersion: z.literal(LOGIC_MODEL_SCHEMA_VERSION),
    snapshotId: z.string().min(1),
    /**
     * sha256 of baseline + spec + evidence versions + golden-case version +
     * compiler/toolchain identity. Computed by code, not the agent — the agent
     * may leave this empty and code fills it in when the snapshot is persisted.
     */
    snapshotHash: z.string().optional(),
    pathway: z.string().min(1),
    guideline: Guideline,
    inputs: z.array(Input).min(1),
    rules: z.array(Rule).min(1),
    flags: z.array(Flag).default([]),
  })
  .strict()
  .superRefine((model, ctx) => {
    // Exactly one catch-all (otherwise) rule must exist — enforced here so the
    // logic-checks service and compiler can rely on a closed decision table.
    const otherwiseRules = model.rules.filter(
      (r) => typeof r.when === "object" && r.when !== null && "otherwise" in r.when,
    );
    if (otherwiseRules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LogicModel must contain exactly one catch-all rule ({ otherwise: true }).",
        path: ["rules"],
      });
    }
    if (otherwiseRules.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "LogicModel must not contain more than one catch-all rule.",
        path: ["rules"],
      });
    }

    // Every non-catch-all condition must reference a declared input id.
    const inputIds = new Set(model.inputs.map((i) => i.id));
    const checkRefs = (cond: Condition, path: (string | number)[]) => {
      if ("input" in cond) {
        if (!inputIds.has(cond.input)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Condition references unknown input "${cond.input}".`,
            path,
          });
        }
      } else if ("all" in cond) {
        cond.all.forEach((c, idx) => checkRefs(c, [...path, "all", idx]));
      } else if ("any" in cond) {
        cond.any.forEach((c, idx) => checkRefs(c, [...path, "any", idx]));
      } else if ("not" in cond) {
        checkRefs(cond.not, [...path, "not"]);
      }
    };
    model.rules.forEach((r, idx) => checkRefs(r.when, ["rules", idx, "when"]));

    // Rule ids must be unique.
    const seen = new Set<string>();
    model.rules.forEach((r, idx) => {
      if (seen.has(r.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate rule id "${r.id}".`,
          path: ["rules", idx, "id"],
        });
      }
      seen.add(r.id);
    });
  });

export type LogicModel = z.infer<typeof LogicModel>;

/** Validate an unknown value as a LogicModel, returning Zod's result. */
export function parseLogicModel(value: unknown) {
  return LogicModel.safeParse(value);
}
