import { z } from "zod";
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactRefSchema = z
  .object({
    bucket: z.string().min(3),
    key: z.string().min(1),
    versionId: z
      .string()
      .min(1)
      .refine((v) => v !== "null"),
    sha256: sha256Schema,
    contentType: z.string().min(1),
  })
  .strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export const sourceTypeSchema = z.enum([
  "guideline",
  "cht-primer",
  "cht-docs",
  "reference-config",
]);
export type SourceType = z.infer<typeof sourceTypeSchema>;
export const sourceSchema = z
  .object({
    sourceType: sourceTypeSchema,
    sourceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    version: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
    section: z.string().min(1).max(100),
    page: z.number().int().positive().optional(),
    tableId: z.string().max(50).optional(),
    workflow: z.string().max(50).optional(),
    path: z.string().max(200),
    url: z.url().refine((v) => new URL(v).protocol === "https:"),
    sourceHash: sha256Schema,
    public: z.literal(true),
    reviewedBy: z.string().min(1),
    reviewedAt: z.iso.datetime(),
    purpose: z.literal("reference-document"),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
/** Trusted server-owned references, never source selection supplied by an agent. */
export interface PublishedSource {
  source: Source;
  document: ArtifactRef;
  provenance: ArtifactRef;
}
export interface PromptContextRequest {
  tenantId: string;
  changeId: string;
  snapshotId: string;
  requestId: string;
}
export type PromptMode = "drafting" | "change_planner";
export interface PromptContextAudit {
  record(event: {
    context: PromptContextRequest;
    contextHash: string;
    evidenceRef: ArtifactRef;
  }): Promise<void>;
}
