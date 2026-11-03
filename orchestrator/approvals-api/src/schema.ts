import { z } from "zod";

export const ApprovalKindSchema = z.enum(["content", "deploy"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApproverRoleSchema = z.enum(["clinician", "program_reviewer", "it_deploy"]);
export type ApproverRole = z.infer<typeof ApproverRoleSchema>;

export const ApprovalDecisionRequestSchema = z.object({
  approverId: z.string().min(1),
  approverRole: ApproverRoleSchema,
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;
