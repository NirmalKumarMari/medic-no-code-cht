import { z } from "zod";
import { validateDraft } from "./validate.js";

const text = z.string().max(2000);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const outcome = {
  action: z.enum(["", "refer_urgently", "treat_at_home", "home_care_advice"]),
  followUp: z.boolean(),
  dueInDays: z.string().max(8),
  openForDays: z.string().max(8),
};
export const requirementsSchema = z
  .object({
    pathway: z.string().max(200),
    guidelineName: z.string().max(300),
    guidelineVersion: z.string().max(50),
    questions: z
      .array(
        z
          .object({
            key,
            label: text,
            type: z.enum(["integer", "decimal", "yes_no", "select_one"]),
            choices: text,
          })
          .strict(),
      )
      .min(1)
      .max(30),
    rules: z
      .array(
        z
          .object({
            key,
            conditions: z
              .array(
                z
                  .object({
                    key,
                    questionKey: key,
                    op: z.enum(["eq", "gte", "gt", "lte", "lt"]),
                    value: z.string().max(200),
                  })
                  .strict(),
              )
              .min(1)
              .max(10),
            source: text,
            ...outcome,
          })
          .strict(),
      )
      .min(1)
      .max(79),
    otherwise: z.object(outcome).strict(),
    otherwiseSource: text,
  })
  .strict()
  .superRefine((draft, ctx) => {
    for (const error of validateDraft(draft))
      ctx.addIssue({
        code: "custom",
        path: [error.fieldId],
        message: error.message,
      });
    const keys = draft.questions.map((q) => q.key);
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Question keys must be unique" });
    for (const rule of draft.rules)
      for (const c of rule.conditions) {
        const q = draft.questions.find((q) => q.key === c.questionKey);
        if (q && !["integer", "decimal"].includes(q.type) && c.op !== "eq")
          ctx.addIssue({
            code: "custom",
            message: "Choice and yes/no questions require equality comparisons",
          });
        if (
          q &&
          ["integer", "decimal"].includes(q.type) &&
          !Number.isFinite(Number(c.value))
        )
          ctx.addIssue({
            code: "custom",
            message: "Condition values must be finite",
          });
      }
    for (const o of [...draft.rules, draft.otherwise])
      if (
        o.followUp &&
        (!Number.isSafeInteger(Number(o.dueInDays)) ||
          !Number.isSafeInteger(Number(o.openForDays)))
      )
        ctx.addIssue({
          code: "custom",
          message: "Follow-up days must be safe integers",
        });
  });
