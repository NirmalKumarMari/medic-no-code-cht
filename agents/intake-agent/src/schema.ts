import { z } from "zod";

/**
 * The Intake Agent's OUTPUT is the shared StructuredSpec. It imports that
 * schema from @vera/schemas rather than redefining it, so the Intake Agent and
 * the Drafting Agent cannot drift. The master definition is
 * .kiro/specs/logic-model-snapshots Requirement 4.
 */
export {
  StructuredSpecSchema,
  parseStructuredSpec,
  RequestKind,
  type StructuredSpec,
  type RequestKind as RequestKindType,
} from "@vera/schemas";

/**
 * What a caller (the orchestrator, or a human-facing API) sends to trigger an
 * intake run. This is raw, untrusted INPUT and is deliberately NOT the
 * StructuredSpec: the agent's job is to turn this into one. Mirrors the
 * Change_Request of authoring-agents Requirement 2.
 */
export const IntakeRequestSchema = z
  .object({
    changeId: z.string().min(1).max(128),
    requestKind: z.enum(["guideline_upload", "pathway_pick", "plain_language_edit"]),
    /** Officer's own words. The model normalizes/flags; it never drafts logic. */
    requestText: z.string().min(1),
    /** Required for guideline_upload / pathway_pick (Req 2.3/2.4). */
    pathway: z.string().min(1).max(200).optional(),
    guideline: z
      .object({
        name: z.string().min(1).max(300),
        version: z.string().min(1).max(50),
      })
      .optional(),
    /** Required for plain_language_edit (Req 2.7). */
    baselineSnapshotHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    editText: z.string().min(1).max(2000).optional(),
    submittedBy: z
      .object({
        role: z.literal("program_officer"),
        userId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;
