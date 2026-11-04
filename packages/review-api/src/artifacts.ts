import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256, type ArtifactRef } from "@vera/artifact-storage";
export interface ArtifactIO {
  putArtifact(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<ArtifactRef>;
  getArtifactVersion(ref: ArtifactRef): Promise<Uint8Array>;
}
/** Explicit local development storage; never presented as an S3 object/version. */
export class LocalArtifacts implements ArtifactIO {
  constructor(private directory: string) {}
  async putArtifact(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<ArtifactRef> {
    const digest = sha256(bytes);
    await mkdir(this.directory, { recursive: true });
    const file = resolve(this.directory, digest);
    try {
      await writeFile(file, bytes, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const ref = {
      bucket: "local-review-artifacts",
      key,
      versionId: `local-${digest}`,
      sha256: digest,
      contentType,
    };
    await this.getArtifactVersion(ref);
    return ref;
  }
  async getArtifactVersion(ref: ArtifactRef) {
    if (
      ref.bucket !== "local-review-artifacts" ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      ref.versionId !== `local-${ref.sha256}`
    )
      throw Error("Invalid local artifact reference");
    const bytes = await readFile(resolve(this.directory, ref.sha256));
    if (sha256(bytes) !== ref.sha256) throw Error("Artifact checksum mismatch");
    return bytes;
  }
}
