import { z } from "zod";

export const ApprovalKindSchema = z.enum(["content", "deploy"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApproverRoleSchema = z.enum(["clinician", "program_reviewer", "it_deploy"]);
export type ApproverRole = z.infer<typeof ApproverRoleSchema>;

export const ApprovalDecisionRequestSchema = z
  .object({
    approverId: z.string().min(1),
    approverRole: ApproverRoleSchema,
    decision: z.enum(["approved", "rejected"]),
    notes: z.string().max(8000).optional(), // same cap as workflow-data recordDecision
  })
  // A rejection must say why: the notes are sent to the re-draft.
  .refine((r) => r.decision !== "rejected" || (r.notes ?? "").trim().length > 0, {
    message: "notes are required when rejecting",
    path: ["notes"],
  });
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;
