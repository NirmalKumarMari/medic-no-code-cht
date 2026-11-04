import { z } from "zod";

/**
 * StructuredSpec: the Intake Agent's output and the Drafting Agent's input.
 *
 * This mirrors the real schema in the Intake Agent (branch agents/intake-agent,
 * agents/intake-agent/src/schema.ts). Keep the two in sync; once the Intake
 * Agent consumes `@vera/schemas`, delete its local copy.
 *
 * Two shapes share this type, distinguished by `changeType`:
 *  - "new_pathway": a guideline is being turned into a pathway for the first time.
 *  - "edit": a plain-language change request against an already-approved snapshot.
 *
 * Names `SpecFlag*` avoid clashing with the LogicModel's own `Flag` exports.
 */

export const SpecFlagSchema = z.object({
  type: z.enum(["ambiguity", "missing_input"]),
  text: z.string().min(1),
});
export type SpecFlag = z.infer<typeof SpecFlagSchema>;

const BaseFields = {
  pathway: z.object({
    id: z.string().min(1), // slug, e.g. "child-cough-fast-breathing"
    title: z.string().min(1),
  }),
  /** The officer's own words, after Guardrails screening. */
  requestText: z.string().min(1),
  /** Explicit constraints extracted verbatim, not inferred. */
  constraints: z.array(z.string()).default([]),
  submittedBy: z.object({
    role: z.literal("program_officer"),
    userId: z.string().min(1),
  }),
  submittedAt: z.string().datetime(),
  flags: z.array(SpecFlagSchema).default([]),
};

export const NewPathwaySpecSchema = z.object({
  changeType: z.literal("new_pathway"),
  ...BaseFields,
  guideline: z.object({
    docId: z.string().min(1), // S3 key / source id for the uploaded guideline
    title: z.string().min(1),
    version: z.string().min(1),
  }),
});

export const EditSpecSchema = z.object({
  changeType: z.literal("edit"),
  ...BaseFields,
  baseline: z.object({
    snapshotId: z.string().min(1),
    snapshotHash: z.string().min(1),
  }),
});

export const StructuredSpecBodySchema = z.discriminatedUnion("changeType", [
  NewPathwaySpecSchema,
  EditSpecSchema,
]);

/** The persisted record adds identifiers the agent itself does not choose. */
export const StructuredSpecSchema = StructuredSpecBodySchema.and(
  z.object({
    changeId: z.string().min(1), // ULID, DynamoDB partition key
    specVersion: z.literal(1),
  }),
);

export type NewPathwaySpec = z.infer<typeof NewPathwaySpecSchema>;
export type EditSpec = z.infer<typeof EditSpecSchema>;
export type StructuredSpecBody = z.infer<typeof StructuredSpecBodySchema>;
export type StructuredSpec = z.infer<typeof StructuredSpecSchema>;
