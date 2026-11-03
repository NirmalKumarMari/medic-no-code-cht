# Integration handoff to Yash and backend/build owners

Status: proposed contract implemented locally, not yet acknowledged by Yash. No Yash communication channel was available in this repository/chat. No DynamoDB or approval code is included.

Identifiers `changeId`, `snapshotId`, `buildId`, `pathwayId`, `sourceId`, `sourceVersion` are opaque, case-sensitive strings. Use UUIDs for generated operation IDs. S3 path segments must not contain slashes, empty segments or traversal components. Execution ARN and canonical snapshot hash are supplied by the workflow owner. Source versions are explicit guideline editions or full 40-character CHT commits. The artifact digest is SHA-256 of exact uploaded bytes; **it is not snapshotHash**. Toolchain/compiler identity hashing remains governed by the canonical design; this module does not reuse approvals after changing hash inputs.

`ArtifactRef` is exactly `{ bucket, key, versionId, sha256, contentType }`. `sha256` is lowercase hexadecimal, versionId is nonempty and never `null`. Upload first, read/verify the returned version, then conditionally register it in DynamoDB. S3 and DynamoDB have no shared transaction. Retry the same key/bytes to recover its existing reference; different bytes require a new key. Orphans must never become current/approved automatically. Garbage collection must first prove a version has no snapshot/decision/audit/build references; no automatic destructive collector is provided.

Prefixes:

- `docs/<sourceId>/<version>/<digest>.json`: source provenance receipts.
- `snapshots/<changeId>/<snapshotId>/logic.json`: exact snapshot bytes.
- `proposals/<changeId>/<proposalId>/...`: proposal artifacts.
- `builds/<changeId>/<buildId>/...`: compiled artifacts and flat release manifest.
- `reports/<changeId>/<buildId>/...`: test/diff reports and synthetic golden-case artifacts.
- `reports/<changeId>/retrieval/<snapshotId>/<requestId>.json`: retrieval evidence; full prompts belong only in a screened artifact reports subprefix such as `reports/<changeId>/model-calls/<requestId>.json`, never the KB.
- `reports/ingestion/<requestId>/...`: ingestion batch/start receipts; `reports/ingestion/<jobId>/status/<digest>.json`: immutable job observations.

`retrieveEvidence(authorizedContext, query, sourceType)` returns `Evidence[]` as defined in `src/contracts.ts`. Backend derives the context from authenticated identity, permitted tools and exact snapshot evidence pins. Each grant binds source type, source ID, edition/commit, and raw source SHA-256, plus optional workflow; a new section hash needs an explicitly authorized grant even within the same edition. Agent request schema exposes only query/sourceType. The required audit callback receives `{context, queryHash, evidenceRef}`. Yash's adapter conditionally writes an append-only audit event with causal IDs, snapshot/request IDs and the ArtifactRef; it must propagate failures. Snapshot registration stores the exact evidence ArtifactRefs, not only a current KB ID. Re-fetch approved evidence from those immutable references even if a later re-index changes live KB results.

Build owner: fetch and verify approved manifest/artifacts before starting the no-network container; mount inputs read-only, then upload outputs after it exits. This module never grants the sandbox container credentials. Deploy owner: use only the prior approved/tested manifest for rollback and verify the expected target revision through the normal deploy gate.

Outstanding coordination: accept identifier/ref schemas, provide Yash's register/audit adapters, supply service/agent role names and isolated credential wiring, connect Gateway/Cedar and CloudWatch, finalize clinical guideline/pathway and compatible CHT commits. Optional Memory remains deferred until those checks pass.
