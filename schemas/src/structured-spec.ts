import { z } from "zod";

/**
 * StructuredSpec: the Intake Agent's output and the Drafting / Change Planner
 * input. The master definition is .kiro/specs/logic-model-snapshots
 * Requirement 4 (request kinds, field bounds, and the strict content list);
 * this schema is that requirement expressed in Zod. The Intake Agent imports
 * these types rather than redefining them, so the two cannot drift.
 *
 * Request kinds (Req 4.1):
 *  - "guideline_upload" / "pathway_pick": first-time drafting of a pathway.
 *  - "plain_language_edit": a change against an already-approved snapshot;
 *    requires both the edit text and the base snapshotHash (Req 4.3).
 */

export const RequestKind = z.enum([
  "guideline_upload",
  "pathway_pick",
  "plain_language_edit",
]);
export type RequestKind = z.infer<typeof RequestKind>;

/** 64 lowercase hex chars (Req 4.4). */
const SnapshotHash = z.string().regex(/^[0-9a-f]{64}$/, "snapshotHash must be 64 lowercase hex chars");

/** The authenticated program officer who submitted the request (Author, §glossary). */
export const SubmittedBy = z
  .object({
    role: z.literal("program_officer"),
    userId: z.string().min(1),
  })
  .strict();
export type SubmittedBy = z.infer<typeof SubmittedBy>;

/**
 * StructuredSpec content is limited to exactly these properties (Req 4.4,
 * plus submittedBy per the reconciled requirement). `.strict()` rejects any
 * other property at any depth, which Req 15.2 / open-question resolution want.
 */
export const StructuredSpecSchema = z
  .object({
    changeId: z.string().min(1).max(128),
    requestKind: RequestKind,
    pathway: z.string().min(1).max(200),
    guideline: z
      .object({
        name: z.string().min(1).max(300),
        version: z.string().min(1).max(50),
      })
      .strict(),
    submittedBy: SubmittedBy,
    /** Required (with editText) only for plain_language_edit; see refine below. */
    baselineSnapshotHash: SnapshotHash.optional(),
    /** 1–2,000 chars, non-blank; required for plain_language_edit. */
    editText: z
      .string()
      .min(1)
      .max(2000)
      .refine((s) => s.trim().length > 0, "editText must not be blank")
      .optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.requestKind !== "plain_language_edit" ||
      (s.baselineSnapshotHash !== undefined && s.editText !== undefined),
    {
      message: "plain_language_edit requires both baselineSnapshotHash and editText",
      path: ["editText"],
    },
  );
export type StructuredSpec = z.infer<typeof StructuredSpecSchema>;

export function parseStructuredSpec(value: unknown) {
  return StructuredSpecSchema.safeParse(value);
}
