import { z } from "zod";
import type { Expr } from "../types/logic-model.js";
const primitive = z.union([z.string(), z.number().finite(), z.boolean()]);
const expression: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ input: z.string(), eq: primitive }).strict(),
    z.object({ input: z.string(), neq: primitive }).strict(),
    z.object({ input: z.string(), gte: z.number().finite() }).strict(),
    z.object({ input: z.string(), gt: z.number().finite() }).strict(),
    z.object({ input: z.string(), lte: z.number().finite() }).strict(),
    z.object({ input: z.string(), in: z.array(z.union([z.string(), z.number().finite()])).min(1) }).strict(),
    z.object({ input: z.string(), lt: z.number().finite() }).strict(),
    z.object({ all: z.array(expression).min(1) }).strict(),
    z.object({ any: z.array(expression).min(1) }).strict(),
    z.object({ not: expression }).strict(),
    z.object({ otherwise: z.literal(true) }).strict(),
  ]),
);
const source = z
  .object({
    section: z.string().optional(),
    page: z.number().int().nonnegative().optional(),
    quote: z.string().optional(),
    tableId: z.string().optional(),
    chunkId: z.string().optional(),
  })
  .strict();
/** Accept only clinical fields this renderer can show. Never strip unknown action/condition fields. */
export const reviewDisplaySchema = z
  .object({
    schemaVersion: z.string().optional(),
    snapshotId: z.string(),
    snapshotHash: z.string().optional(),
    version: z.number().int().optional(),
    pathway: z.object({ id: z.string(), title: z.string() }).strict(),
    guideline: z
      .object({ name: z.string(), version: z.string().optional() })
      .strict()
      .optional(),
    inputs: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            type: z.enum(["integer", "decimal", "yes_no", "select_one", "text"]),
            choices: z.array(z.string()).optional(),
            options: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .min(1),
    rules: z
      .array(
        z
          .object({
            id: z.string(),
            when: expression,
            then: z
              .object({
                action: z.enum([
                  "refer_urgently",
                  "treat_at_home",
                  "home_care_advice",
                  "follow_up",
                ]),
              })
              .strict(),
            followUp: z
              .object({
                dueInDays: z.number().int().nonnegative(),
                openForDays: z.number().int().nonnegative(),
              })
              .strict()
              .optional(),
            source: source.optional(),
          })
          .strict(),
      )
      .min(1),
    flags: z
      .array(
        z
          .object({
            type: z.enum([
              "ambiguity",
              "missing_input",
              "gap",
              "uncited_rule",
              "conflict",
            ]),
            text: z.string(),
            ruleId: z.string().optional(),
            source: source.optional(),
            resolved: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((model, ctx) => {
    for (const input of model.inputs)
      if (
        input.type === "select_one" &&
        (!input.choices || input.choices.length < 2)
      )
        ctx.addIssue({
          code: "custom",
          message: "Choice questions need their stored choices",
        });
    for (const input of model.inputs)
      if (
        input.options &&
        input.choices &&
        JSON.stringify(input.options) !== JSON.stringify(input.choices)
      )
        ctx.addIssue({
          code: "custom",
          message: "Conflicting question choices",
        });
  });
