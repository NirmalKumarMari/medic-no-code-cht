import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { artifactRefSchema, requireData, sha256, snapshotBundleSchema, snapshotHash, type ArtifactRef, type SnapshotBundle } from './model.js';

export type SnapshotVerifier = (ref: ArtifactRef, bundle: SnapshotBundle) => Promise<void>;
/** Read-only integration with the teammate's versioned artifact store. No S3 writes. */
export function s3SnapshotVerifier(client: S3Client, allowedBucket: string): SnapshotVerifier {
  return async (input, bundle) => {
    const ref = artifactRefSchema.parse(input);
    requireData(ref.bucket === allowedBucket && ref.key.startsWith('snapshots/'), 'INVALID_ARTIFACT', 'Snapshot must be in the configured artifact bucket/prefix');
    const response = await client.send(new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key, VersionId: ref.versionId }));
    requireData(response.VersionId === ref.versionId, 'INVALID_ARTIFACT', 'Object version does not match');
    requireData(response.ContentLength !== undefined && response.ContentLength <= 4 * 1024 * 1024, 'INVALID_ARTIFACT', 'Snapshot is missing or exceeds the 4 MiB intake limit');
    const bytes = await response.Body?.transformToByteArray();
    requireData(bytes && bytes.length <= 4 * 1024 * 1024, 'INVALID_ARTIFACT', 'Snapshot content unavailable');
    requireData(sha256(bytes) === ref.sha256, 'HASH_MISMATCH', 'Artifact checksum does not match');
    const stored = snapshotBundleSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    requireData(snapshotHash(stored) === snapshotHash(bundle), 'HASH_MISMATCH', 'Stored specification differs from the submitted bundle');
  };
}
