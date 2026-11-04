import { z } from "zod";
import {
  id,
  digest,
  LogicModelSchema,
  LogicModelFlagSchema,
  OperationSchema,
  SnapshotBundleSchema,
  ArtifactRefSchema,
} from "./logicModel.js";
export { StructuredSpecSchema as EditChangeRequestSchema } from "@vera/schemas";
import {
  StructuredSpecSchema as EditChangeRequestSchema,
  type StructuredSpec,
} from "@vera/schemas";
export type EditChangeRequest = StructuredSpec;
export const ModelProposalSchema = z
  .object({
    proposedLogicModel: LogicModelSchema,
    citationQuotes: z
      .array(
        z.object({ ruleId: id, quote: z.string().min(1).max(4000) }).strict(),
      )
      .max(200)
      .default([]),
    rationale: z.string().min(1).max(4000),
    flags: z.array(LogicModelFlagSchema).max(100).default([]),
  })
  .strict();
export type ModelProposal = z.infer<typeof ModelProposalSchema>;
export const BaselineSnapshotSchema = z
  .object({
    logicModel: LogicModelSchema,
    snapshotHash: digest,
    hashInputs: SnapshotBundleSchema,
    plannerContext: z
      .object({
        text: z.string().min(1).max(160000),
        contextHash: digest,
        source: z
          .object({
            sourceId: id,
            version: z.string().min(1),
            sourceHash: digest,
            sourceS3Ref: ArtifactRefSchema,
            provenanceRef: ArtifactRefSchema,
          })
          .strict(),
        evidenceRef: ArtifactRefSchema,
      })
      .strict(),
    guideline: z
      .object({
        sourceId: id,
        version: z.string().min(1),
        sha256: digest,
        text: z.string().min(1).max(160000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BaselineSnapshot = z.infer<typeof BaselineSnapshotSchema>;
export const ChangePlanSchema = z
  .object({
    changeId: id,
    requestKind: z.literal("plain_language_edit"),
    snapshotId: id,
    snapshotHash: digest,
    baselineSnapshotId: id,
    baselineSnapshotHash: digest,
    proposedLogicModel: LogicModelSchema,
    hashInputs: SnapshotBundleSchema,
    operations: z.array(OperationSchema),
    riskLevel: z.enum(["wording", "logic_clinical"]),
    rationale: z.string().min(1),
    flags: z.array(LogicModelFlagSchema),
    status: z.enum(["proposed", "needs_clarification"]),
    approvalStatus: z.literal("unapproved"),
    grounding: z
      .object({
        primerVersion: z.string(),
        primerHash: digest,
        guidelineHash: digest.optional(),
      })
      .strict(),
    execution: z
      .object({
        modelId: z.string(),
        modelCalls: z.number().int().min(1).max(3),
        escalated: z.boolean(),
        usage: z
          .array(
            z
              .object({
                modelId: z.string(),
                inputTokens: z.number(),
                outputTokens: z.number(),
                cacheReadInputTokens: z.number(),
                cacheWriteInputTokens: z.number(),
              })
              .strict(),
          )
          .max(3),
      })
      .strict(),
  })
  .strict();
export type ChangePlan = z.infer<typeof ChangePlanSchema>;
