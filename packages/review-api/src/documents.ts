import { z } from "zod";
import { sha256 } from "@vera/artifact-storage";
import type { HumanContext, DocumentRepository } from "@vera/workflow-data";
import type { ArtifactIO } from "./artifacts.js";
import { HttpError } from "./auth.js";
export const uploadMetadata = z
  .object({
    documentId: z.string().uuid(),
    requestId: z.string().uuid(),
    expectedVersion: z.coerce.number().int().nonnegative(),
    filename: z.string().min(1).max(300),
  })
  .strict();
export class DocumentsService {
  constructor(
    readonly repository: DocumentRepository,
    private artifacts: ArtifactIO,
    private screen: (text: string) => Promise<void>,
  ) {}
  async upload(ctx: HumanContext, metadata: unknown, bytes: Buffer) {
    if (!ctx.groups.includes("program_officer"))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Only program officers can upload guidelines.",
      );
    const input = uploadMetadata.parse(metadata);
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > 50 * 1024 * 1024 ||
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    )
      throw new HttpError(
        400,
        "INVALID_PDF",
        "Only nonempty PDF files of at most 50 MB with a PDF signature are accepted.",
      );
    await this.screen(input.filename);
    const artifact = await this.artifacts.putArtifact(
      `docs/${ctx.tenantId}/${input.documentId}/${input.requestId}/original.pdf`,
      bytes,
      "application/pdf",
    );
    const row = await this.repository.save(ctx, { ...input, artifact });
    if (row.artifact.sha256 !== sha256(bytes))
      throw new HttpError(409, "INTEGRITY_ERROR", "Stored PDF hash mismatch.");
    return row;
  }
  async download(ctx: HumanContext, documentId: string, revisionId?: string) {
    const row = await this.repository.get(ctx, documentId, revisionId);
    return {
      filename: String(row.filename),
      bytes: await this.artifacts.getArtifactVersion(row.artifact),
    };
  }
}
