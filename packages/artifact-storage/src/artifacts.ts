import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { artifactRefSchema, type ArtifactRef } from "./contracts.js";
export const sha256 = (body: Uint8Array | string) =>
  createHash("sha256").update(body).digest("hex");
export class ArtifactStore {
  constructor(
    private s3: S3Client,
    readonly bucket: string,
    private kmsKeyId: string,
    private prefixes = [
      "docs/",
      "snapshots/",
      "proposals/",
      "builds/",
      "reports/",
    ],
  ) {}
  private key(key: string) {
    if (
      !this.prefixes.some((p) => key.startsWith(p)) ||
      key.split("/").some((p) => !p || p === "." || p === "..") ||
      key.includes("\\")
    )
      throw Error("Invalid artifact key");
  }
  async putArtifact(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<ArtifactRef> {
    this.key(key);
    if (!body.length || !contentType) throw Error("Empty artifact");
    const digest = sha256(body);
    let result;
    try {
      result = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: this.kmsKeyId,
          IfNoneMatch: "*",
          ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
          Metadata: { sha256: digest },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name !== "PreconditionFailed")
        throw error;
      const existing = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const ref = artifactRefSchema.parse({
        bucket: this.bucket,
        key,
        versionId: existing.VersionId,
        sha256: digest,
        contentType,
      });
      if (
        !existing.Body ||
        existing.ContentType !== contentType ||
        existing.ServerSideEncryption !== "aws:kms" ||
        existing.SSEKMSKeyId !== this.kmsKeyId ||
        sha256(await existing.Body.transformToByteArray()) !== digest
      )
        throw Error("Immutable key conflict");
      return ref;
    }
    return artifactRefSchema.parse({
      bucket: this.bucket,
      key,
      versionId: result.VersionId,
      sha256: digest,
      contentType,
    });
  }
  async getArtifactVersion(input: ArtifactRef): Promise<Uint8Array> {
    const ref = artifactRefSchema.parse(input);
    this.key(ref.key);
    if (ref.bucket !== this.bucket) throw Error("Unauthorized bucket");
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: ref.bucket,
        Key: ref.key,
        VersionId: ref.versionId,
        ChecksumMode: "ENABLED",
      }),
    );
    if (
      !result.Body ||
      result.VersionId !== ref.versionId ||
      result.ContentType !== ref.contentType ||
      result.ServerSideEncryption !== "aws:kms" ||
      result.SSEKMSKeyId !== this.kmsKeyId
    )
      throw Error("Artifact identity/encryption mismatch");
    const bytes = await result.Body.transformToByteArray();
    if (sha256(bytes) !== ref.sha256) throw Error("Artifact checksum mismatch");
    return bytes;
  }
  async listVersions(key: string) {
    this.key(key);
    const versions = [];
    let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
    do {
      const r = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: key,
          KeyMarker,
          VersionIdMarker,
        }),
      );
      versions.push(...(r.Versions ?? []).filter((v) => v.Key === key));
      if (!r.IsTruncated) break;
      KeyMarker = r.NextKeyMarker;
      VersionIdMarker = r.NextVersionIdMarker;
    } while (KeyMarker);
    return versions;
  }
  async verifyManifest(ref: ArtifactRef): Promise<ArtifactRef[]> {
    const parsed: unknown = JSON.parse(
      Buffer.from(await this.getArtifactVersion(ref)).toString("utf8"),
    );
    if (!Array.isArray(parsed) || !parsed.length)
      throw Error("Manifest must be nonempty ArtifactRef array");
    const refs = parsed.map((r) => artifactRefSchema.parse(r));
    if (new Set(refs.map((r) => r.bucket + "/" + r.key)).size !== refs.length)
      throw Error("Duplicate manifest key");
    for (const child of refs) await this.getArtifactVersion(child);
    return refs;
  }
}
