# Storage/database handoff — revised November 4, 2026

Canonical source: the revised FINAL Solution Design. One guideline is passed in full to Drafting; one reviewed CHT primer is passed to Change Planner. There is no KB, vector index, embedding, indexed corpus, agent retrieval tool, Cross-Check agent or AgentCore Memory.

## Workspace packages

Install once with root `npm ci`; root `npm run build` builds `@vera/artifact-storage` before `@vera/workflow-data`. Source/artifact helpers live in `packages/artifact-storage/src/`; DynamoDB repositories live in `packages/workflow-data/src/`. Import public package exports. Both use `ArtifactRef`/`artifactRefSchema` from `@vera/artifact-storage/contracts`; workflow-data preserves its existing re-exports. Infrastructure stays in the root `infra/` folder.

## Source/context contract

`SourcePublisher.publish(source, rawBytes, format)` returns `{ source, document, provenance }`. Source metadata includes type (`guideline`, `cht-primer`, or underlying pinned technical reference), ID/version, original source hash, URL/path, real reviewer/time and section/page/table provenance where available. Do not invent page numbers. ArtifactRef is `{ bucket, key, versionId, sha256, contentType }`; artifact hashes are exact-byte SHA-256 and are distinct from the canonical snapshot hash.

`PromptContextBuilder.prepare(trustedContext, mode, publishedSource)` returns `{ text, contextHash, source, evidenceRef }`. `trustedContext = { tenantId, changeId, snapshotId, requestId }` is built server-side. Mode is `drafting` or `change_planner`. The builder validates source type/version/provenance/raw/exported bytes, screens the full text and awaits `audit.record({ context, contextHash, evidenceRef })`. An audit error prevents use. Model code must pass this complete returned text into the prompt and validate citation identifiers against it. No model-generated request chooses arbitrary documents, tenants or file paths.

Wire the callback to `repo.recordPromptContext(workerContext, { changeId, snapshotId, requestId, contextHash, evidenceRef })`. It requires a current draft and actual workflow execution identity; it transactionally writes a context index plus audit event. Context receipt path: `reports/<changeId>/context/<snapshotId>/<requestId>.json`. Full prompts/model-call traces remain screened S3 audit artifacts, never DynamoDB blobs.

The snapshot bundle keeps `evidenceVersions` with exact source refs. Its legacy field `retrievalEvidenceRefs` now holds **prompt-context receipt refs**; the name is retained to avoid silently changing the existing hash format. It does not imply a retrieval service. Initial drafts can have an empty array but cannot enter content review until the actual context references are frozen into a new hash-bound snapshot. Use `registerRevision`, stop/supersede the old execution and run logic checks before content approval. Never rewrite old approved snapshots/hashes to relabel evidence.

## Rule history

`fingerprintRules` normalizes each rule's `when`, `then` and optional `followUp`; IDs and source labels do not change structural identity. It sorts conjunction/disjunction terms but does not infer general logical equivalence or clinical meaning. Follow-up timing is part of action semantics. At most 80 explicit rules fit the current atomic rejection/write transaction; larger pathways require a reviewed change, not silent truncation.

Content rejection atomically writes append-only history index records in Approvals, under PK `HISTORY#<tenant>#<pathway>#<fingerprint>`, SK `<timestamp>#<decisionId>`. The original change ID is in `sourceChangeId`. This is a materialized index in the existing table, not a fifth table or GSI. Strongly consistent key queries return the latest rejected-snapshot reference per matching rule. IT rejection does not imply a clinical rule was rejected and is not indexed. If a whole snapshot is rejected, the index means its rules **appeared in that rejected snapshot**, not that every rule was individually adjudged unsafe.

`recordValidation` and opening content review refresh exact-match flags. Clinical snapshots require explicit rules before successful validation. `historyFlags` appear on current state and are preserved in the human decision record. Flags are high severity, tenant/pathway scoped and **advisory**; open ambiguity still blocks review but an exact history match alone never blocks a clinician's approval. The UI should link to the prior decision/snapshot for full context. No LLM or semantic Memory is involved. Existing optional explicit IT acknowledgements remain supported for callers that supply flags.

## Runtime boundaries

The four DynamoDB schemas, approval hash binding, role separation, token durability and release verification remain. IAM must grant the history-check worker `Query` on Approvals; the decision handler already needs transactional `PutItem` there. Restrict both to trusted code. No agent can approve, write history, query private tables or fetch storage directly. The UI/API owner supplies verified Cognito identities; Step Functions owns transition ordering. The deployer alone reads CHT credentials after approval. Build sandbox remains offline and credential-free.

Full sources/artifacts live in one versioned SSE-KMS S3 bucket under `docs/`, `snapshots/`, `proposals/`, `builds/`, `reports/`. No test data has been seeded by this revision. Synthetic household/patient/report data belongs to the separately managed CHT/CouchDB test stack and Medic's generator, not these workflow tables.
