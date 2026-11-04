import { z } from "zod";
import {
  LogicModel as LogicModelSchema,
  Rule as RuleSchema,
  Input as InputFieldSchema,
  Flag as LogicModelFlagSchema,
  type LogicModel,
  type Rule,
  type Input as InputField,
} from "@vera/schemas";
import {
  snapshotBundleSchema as SnapshotBundleSchema,
  snapshotHash as computeSnapshotHash,
  canonicalJson as canonicalStringify,
  sha256,
  idSchema as id,
  digestSchema as digest,
  type SnapshotBundle,
} from "@vera/workflow-data";
import { artifactRefSchema as ArtifactRefSchema } from "@vera/artifact-storage/contracts";
export {
  LogicModelSchema,
  RuleSchema,
  InputFieldSchema,
  LogicModelFlagSchema,
  SnapshotBundleSchema,
  computeSnapshotHash,
  canonicalStringify,
  sha256,
  id,
  digest,
  ArtifactRefSchema,
};
export type { LogicModel, Rule, InputField, SnapshotBundle };
export const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const op = <Name extends string, Shape extends z.ZodRawShape>(
  name: Name,
  shape: Shape,
) => z.object({ op: z.literal(name), ...shape }).strict();
export const OperationSchema = z.union([
  op("add_rule", { targetId: id, before: z.null(), after: RuleSchema }),
  op("remove_rule", { targetId: id, before: RuleSchema, after: z.null() }),
  op("modify_rule", { targetId: id, before: RuleSchema, after: RuleSchema }),
  op("add_input", { targetId: id, before: z.null(), after: InputFieldSchema }),
  op("remove_input", {
    targetId: id,
    before: InputFieldSchema,
    after: z.null(),
  }),
  op("modify_input", {
    targetId: id,
    before: InputFieldSchema,
    after: InputFieldSchema,
  }),
  op("reorder_rules", { before: z.array(id), after: z.array(id) }),
  op("reorder_inputs", { before: z.array(id), after: z.array(id) }),
  op("set_flags", {
    before: z.array(LogicModelFlagSchema),
    after: z.array(LogicModelFlagSchema),
  }),
]);
export type Operation = z.infer<typeof OperationSchema>;
export function diffLogic(
  baseline: LogicModel,
  proposed: LogicModel,
): { operations: Operation[]; riskLevel: "wording" | "logic_clinical" } {
  if (
    !equal(baseline.pathway, proposed.pathway) ||
    !equal(baseline.guideline ?? null, proposed.guideline ?? null)
  )
    throw Error("Pathway/guideline changes require a new-pathway request.");
  const operations: Operation[] = [];
  for (const [kind, before, after] of [
    ["rule", baseline.rules, proposed.rules],
    ["input", baseline.inputs, proposed.inputs],
  ] as const) {
    const old = new Map(before.map((v) => [v.id, v])),
      next = new Map(after.map((v) => [v.id, v]));
    if (old.size !== before.length || next.size !== after.length)
      throw Error("Duplicate element IDs");
    for (const row of after) {
      const prior = old.get(row.id);
      if (!prior)
        operations.push(
          OperationSchema.parse({
            op: `add_${kind}`,
            targetId: row.id,
            before: null,
            after: row,
          }),
        );
      else if (!equal(prior, row))
        operations.push(
          OperationSchema.parse({
            op: `modify_${kind}`,
            targetId: row.id,
            before: prior,
            after: row,
          }),
        );
    }
    for (const row of before)
      if (!next.has(row.id))
        operations.push(
          OperationSchema.parse({
            op: `remove_${kind}`,
            targetId: row.id,
            before: row,
            after: null,
          }),
        );
    // Include complete ordering even when inserts/removals accompany a reorder.
    if (
      !equal(
        before.map((v) => v.id),
        after.map((v) => v.id),
      )
    )
      operations.push(
        OperationSchema.parse({
          op: `reorder_${kind}s`,
          before: before.map((v) => v.id),
          after: after.map((v) => v.id),
        }),
      );
  }
  if (!equal(baseline.flags, proposed.flags))
    operations.push(
      OperationSchema.parse({
        op: "set_flags",
        before: baseline.flags,
        after: proposed.flags,
      }),
    );
  const wording = operations.every(
    (o) =>
      o.op === "modify_input" &&
      equal(
        { ...(o.before as object), label: "" },
        { ...(o.after as object), label: "" },
      ),
  );
  return { operations, riskLevel: wording ? "wording" : "logic_clinical" };
}
export function validateReferences(logic: LogicModel): string[] {
  const issues: string[] = [];
  const result = LogicModelSchema.safeParse(logic);
  if (!result.success)
    issues.push(
      ...result.error.issues.map((i) => i.path.join(".") + ": " + i.message),
    );
  if (new Set(logic.inputs.map((i) => i.id)).size !== logic.inputs.length)
    issues.push("Duplicate input IDs.");
  for (const field of logic.inputs) {
    if (
      ["select_one", "select_multiple"].includes(field.type) &&
      !field.options?.length
    )
      issues.push(`Input ${field.id}: choices require explicit options.`);
    if (field.options && new Set(field.options).size !== field.options.length)
      issues.push(`Input ${field.id}: duplicate options.`);
  }

  const fields = new Map(logic.inputs.map((i) => [i.id, i]));
  const visit = (condition: LogicModel["rules"][number]["when"]) => {
    if ("all" in condition) {
      condition.all.forEach(visit);
      return;
    }
    if ("any" in condition) {
      condition.any.forEach(visit);
      return;
    }
    if ("not" in condition) {
      visit(condition.not);
      return;
    }
    if (!("input" in condition)) return;
    const field = fields.get(condition.input);
    if (!field) return;
    const operator = Object.keys(condition).find((k) => k !== "input")!;
    const raw = (condition as unknown as Record<string, unknown>)[operator];
    const values = Array.isArray(raw) ? raw : [raw];
    if (
      ["gt", "gte", "lt", "lte"].includes(operator) &&
      !["integer", "decimal"].includes(field.type)
    )
      issues.push(
        `Input ${field.id}: ordering comparisons require numeric input.`,
      );
    if (
      ["integer", "decimal"].includes(field.type) &&
      values.some(
        (v) =>
          typeof v !== "number" ||
          (field.type === "integer" && !Number.isInteger(v)),
      )
    )
      issues.push(
        `Input ${field.id}: numeric comparison has incompatible value.`,
      );
    if (
      ["select_one", "select_multiple"].includes(field.type) &&
      values.some((v) => typeof v !== "string" || !field.options?.includes(v))
    )
      issues.push(`Input ${field.id}: unknown option.`);
  };
  logic.rules.forEach((rule) => visit(rule.when));
  return issues;
}
