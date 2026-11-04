import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { s3SnapshotVerifier, sha256, type ArtifactRef } from '../src/index.js';
import { bundle } from './harness.js';

const bytes = Buffer.from(JSON.stringify(bundle));
const ref: ArtifactRef = { bucket: 'synthetic-fixtures', key: 'snapshots/fixture.json', versionId: 'fixture-version', sha256: sha256(bytes), contentType: 'application/json' };
function client(body = bytes, version = ref.versionId): S3Client {
  return { send: async (command: any) => {
    assert.equal(command.input.VersionId, ref.versionId);
    return { ContentLength: body.length, VersionId: version, Body: { transformToByteArray: async () => body } };
  } } as unknown as S3Client;
}
test('S3 verifier fetches the exact version and validates both file digest and canonical bundle', async () => {
  await s3SnapshotVerifier(client(), ref.bucket)(ref, bundle);
});
test('S3 verifier rejects an unapproved bucket or a non-snapshot prefix', async () => {
  await assert.rejects(() => s3SnapshotVerifier(client(), 'different-bucket')(ref, bundle));
  await assert.rejects(() => s3SnapshotVerifier(client(), ref.bucket)({ ...ref, key: 'reports/other.json' }, bundle));
});
test('S3 verifier rejects checksum corruption, a mismatched version and changed specification', async () => {
  await assert.rejects(() => s3SnapshotVerifier(client(), ref.bucket)({ ...ref, sha256: 'f'.repeat(64) }, bundle));
  await assert.rejects(() => s3SnapshotVerifier(client(bytes, 'wrong-version'), ref.bucket)(ref, bundle));
  await assert.rejects(() => s3SnapshotVerifier(client(), ref.bucket)(ref, { ...bundle, compilerVersion: 'changed' }));
});
