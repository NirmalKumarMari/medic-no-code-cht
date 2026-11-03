# Database and storage work plan

Source of truth: `final design doc.md`, read November 3, 2026, especially sections 8-11 and 14-17. This is a proposed implementation breakdown, not deployed infrastructure. It follows the final Open-path / Step Functions / plain EC2 design. Key formats and interfaces below are recommendations that fill in details the final document does not specify.

## 1. Exact scope

| Required resource | Quantity | Responsibility |
|---|---:|---|
| DynamoDB tables | 4 | `Changes`, `Approvals`, `Audit`, `Tokens` |
| Private S3 object buckets | 2 | Release/source artifacts; separate `kb-source` ingestion bucket |
| S3 vector bucket | 1 | Managed vector storage, distinct from an ordinary S3 object bucket |
| Vector index | 1 | Embeddings for the selected Knowledge Base |
| Bedrock Knowledge Base | 1 | Guideline + selected CHT docs + reference configurations, separated with metadata/source filters |
| KB ingestion/data-source configurations | Recommend 3 | One per `guideline/`, `cht-docs/`, `reference-config/` prefix to isolate ingestion/chunking settings |
| Encryption/access policies and IaC | Across these resources | Private access, KMS, per-component permissions, deployment outputs and teardown |
| AgentCore Memory | Optional | Advisory decision summaries; implement after the required path |
| CHT CouchDB | Existing component of test stack | Coordinate persistent volume and synthetic data with the CHT owner; do not build another patient database |

Do not add RDS, Aurora, PostgreSQL, MongoDB, Redis, a custom users/password table or a separate manually maintained embedding database. Cognito owns user identity. Secrets Manager owns the CHT test login. CloudWatch owns operational logs; it does not replace durable audit evidence. OpenSearch is only the final document's explicit contingency, not a second vector store to provision in parallel.

## 2. DynamoDB tables

All four tables should use the project's region/tag conventions, encryption and a suitable on-demand billing configuration. Define schemas in TypeScript and version them. Use partition/sort keys and targeted queries rather than scans on core request paths.

### Changes

Purpose: identify a change, its versions, current review state and build/deployment references.

- Required fields: `changeId`, `pathwayId`, `snapshotId`, `snapshotHash`, `authorId`, `baselineRevision`, `state`, `buildKind`, `schemaVersion`, `executionArn`, timestamps, artifact references and validation/build/report identifiers.
- `buildKind` is `preview` or `release`; previews cannot authorize deployment.
- Suggested key: PK `changeId`, SK `META` for the current mutable projection; SK `SNAPSHOT#<snapshotId>` for immutable version records. Store optional build/deploy records under separate sort keys, not by replacing snapshots.
- Add one sparse status/reviewer-inbox GSI on current projection records if the UI needs a list of pending changes. Query approvals/audit by change ID without full scans.
- Build retries need distinct `buildId` records even when they share a snapshot hash. Deployment references include the artifact digest and expected prior target revision.

### Approvals

Purpose: exact append-only approval and rejection records for both human gates.

- Required fields: `decisionId`, `changeId`, gate, snapshot hash, approve/reject decision, actor Cognito subject, authorized role, server timestamp, notes and idempotency key.
- Deploy decisions also record `buildId`, artifact digest, test/diff report references, target ID and acknowledgement of any optional history flags.
- Suggested key: PK `changeId`, SK `<CONTENT|DEPLOY>#<snapshotHash>#<decisionId>`.
- Use conditional creation. Rejection or a later approval creates another decision; it never edits an earlier one.
- Separate append-only decisions from mutable gate status. A transaction checks the current snapshot/state, writes the decision, updates the current projection and claims the matching callback attempt.
- The trusted approval API/workflow integration checks role, author identity and other-gate approver. An agent never writes decisions or sets an approved state.

### Audit

Purpose: durable, queryable chronology and pointers to complete evidence.

- Required fields: event ID, change ID, snapshot/build IDs, event type, timestamp, actor/component, request/idempotency ID, execution ARN and related S3 references.
- Record draft creation, retrieval evidence, validation results, approval/rejection, build/test attempts, deployment verification and rollback. Full prompts/reports live in S3; the table indexes them.
- Suggested key: PK `changeId`, SK `<timestamp>#<uniqueEventId>`; retain causality/attempt identifiers rather than relying on timestamps alone.
- Make records append-only. Record corrections as new events. Do not put TTL on required decisions or audit evidence.
- Optional history checking can add pathway-scoped rule fingerprints and a suitable exact-match index. Preserve source/version context; a matching fingerprint is advisory evidence, not a new approval.

### Tokens

Purpose: persist callback details for Step Functions' content and deploy waits.

- Required fields: change ID, gate, snapshot hash, callback attempt ID, Step Functions execution/state identifiers, task token, expiration/timeout, status and consumed/completed timestamps. Deploy gate also pins the artifact/build.
- Suggested key: PK `changeId`, SK `<gate>#<snapshotHash>#<attemptId>`.
- Treat raw task tokens as secrets: restrict access to trusted workflow/callback code, exclude from browser responses, model context, logs and ordinary audit records.
- Bind the token to the current wait attempt. A newly issued token supersedes the old attempt; a stale request must not complete a newer wait.
- Check expiration explicitly in code. DynamoDB TTL is delayed cleanup, not an authorization/timeout mechanism. Keep pending waits durable; apply cleanup only once safe.
- DynamoDB writes and `SendTaskSuccess` are not one distributed transaction. Persist decision/callback progress, then deliver the callback with recoverable retries and reconciliation. Do not lose an approved workflow between those operations.

AWS references: [transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html), [TTL behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html), [Step Functions callbacks](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html).

## 3. S3 object storage

### Artifact bucket

Use private, versioned, SSE-KMS encrypted storage. Prefixes follow the final design, with IDs added to prevent collisions:

```text
docs/<documentId>/<sourceVersion>/...
snapshots/<changeId>/<snapshotId>/logic.json
proposals/<changeId>/<proposalId>/...
builds/<changeId>/<buildId>/...
reports/<changeId>/<buildId>/...
```

Keep complete prompts and retrieval/model-call traces as screened audit artifacts under a documented reports subprefix. Store versioned golden-case fixtures and synthetic test inputs in the artifact area, never the Knowledge Base. Include generated XLSForms, properties, tasks, translations, manifests, diffs and actual test reports. Record prior release manifests for rollback; no new deployment bucket is required.

Every important file reference must include bucket, key, VersionId and SHA-256. Use unique/content-addressed keys and conditional creates for finalized records. S3 versioning is recovery support, not a guarantee against overwriting or deleting data. Coordinate bucket policy and trusted writer roles accordingly. A replacement source or snapshot creates a new version and reference.

Builders cannot access S3 during the no-network build phase. Trusted EC2 worker code stages approved inputs before starting that container, then uploads output afterward. The database team supplies artifact APIs; the build owner implements local staging/mounts/container isolation.

### Knowledge Base source bucket

```text
guideline/<documentId>/<edition>/...
cht-docs/<pinnedCommit>/...
reference-config/<pinnedCommit>/<workflow>/...
```

- Ingest only public, screened documents. Enforce metadata and provenance before embedding.
- Preserve source URL/path, source hash, source type, edition/commit, section/page/table references and workflow where applicable.
- Keep full tables and decision-chart context together where feasible; validate citation fidelity instead of assuming arbitrary chunk boundaries preserve it.
- Deterministically convert unsupported source formats such as raw task `.js` into supported, readable `.md`/`.txt` records for ingestion; retain file/commit references. Native XLSForm source can be staged in supported form or exported deterministically as documented text.
- Do not ingest prompts, patient records, credentials, approval decisions, golden cases or hosted MCP answers.
- Keep immutable versioned source paths and controlled ingestion/re-indexing. Deletion and source updates must not silently change evidence already used in an approved snapshot.

## 4. Knowledge Base, embeddings and vectors

Provision Bedrock Knowledge Base + S3 Vectors vector bucket/index and configure Titan Text Embeddings V2. Select compatible dimensions/distance settings once and match them throughout; verify the account's region, quotas and provider support.

Recommended data sources are the three source prefixes above. Define source-specific chunking or prepare explicit section files so sections/tables retain citation context. Use small, filterable metadata; long source text belongs in documents, not vector metadata.

The retrieval service must enforce the authorized source, guideline/version and technical-document compatibility. Agents have no direct `bedrock:Retrieve` permission; the service role has retrieval access. Give ingestion/KB service roles the required source/vector/model/KMS access, without agent write access to ingestion resources.

Agree a service contract with the agent/backend team:

```text
retrieveEvidence(authorizedContext, query, sourceType)
  -> [{ text, sourceId, version, section, page, tableId,
        sourceHash, sourceS3Ref, score }]
```

Not every source has a page/table; do not invent missing values. Log query/result references against the change. A result without adequate provenance is unresolved. Technical documentation does not establish clinical correctness.

The storage owner can implement the ingest and retrieval adapter; the agent/backend owner wires the container endpoint through Gateway and maintains the agent prompts. Do not implement agent drafting or clinical validation inside the database module.

AWS references: [S3 Vectors / Knowledge Base integration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html), [supported source formats](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-ds.html).

## 5. Optional decision memory

After the required pipeline works, configure AgentCore Memory namespaces per pathway and code-only writer access. Store plain-language summaries referencing exact decision IDs/snapshot hashes. Agents may read authorized memory; they cannot write or rewrite it. DynamoDB/S3 remain authoritative.

History flags and human acknowledgements must bind to the release reviewed. Memory/history is advisory and can be cut; the Knowledge Base, append-only decisions, exact approval binding and actual test evidence cannot be cut. Coordinate the final choice of whether summaries are generated deterministically or through a separate approved Bedrock process; do not treat a summary as an exact decision record.

## 6. Team split

### Yash: workflow state, approvals and audit

- [ ] Define the four DynamoDB table schemas, key formats and access patterns.
- [ ] Provision tables/indexes and policies through the team's IaC standard; export table names/ARNs.
- [ ] Define canonical snapshot hashing with the compiler/backend owners and implement consistency checks.
- [ ] Build typed repositories for version registration, current-state queries, decisions, audit and callback attempts.
- [ ] Implement conditional writes, transactions and durable idempotency records; preserve immutable history.
- [ ] Integrate with the Step Functions owner for both callback waits and recovery after duplicate/failing callbacks.
- [ ] Give the UI/backend owner safe data contracts without raw tokens or untrusted approval-state writes.
- [ ] Verify stale/duplicate/cross-version approval rejection, identity separation integration, restart recovery and prior-release lookup.
- [ ] Add exact-match decision fingerprints only if optional history work proceeds.

Deliverable: four real tables, typed repository APIs, synthetic fixtures, meaningful consistency/recovery tests and documented integration examples.

### Teammate: artifact storage and knowledge retrieval

- [ ] Define and provision the two S3 object buckets, KMS/storage policies, prefixes and versioning.
- [ ] Implement `putArtifact`, `getArtifactVersion` and manifest verification; return exact version/hash references.
- [ ] Provision S3 Vectors bucket/index, Bedrock Knowledge Base and source configurations; export IDs/ARNs.
- [ ] Implement screened ingestion, metadata sidecars, supported-format exports and controlled ingestion-job tracking.
- [ ] Load one public guideline plus selected pinned CHT docs/reference config records; verify citations and version filters.
- [ ] Implement the retrieval adapter contract, including source filters and result provenance; coordinate Gateway wiring with the backend owner.
- [ ] Verify private access, immutable references, unauthorized source rejection and exclusion of golden cases/patient data from the KB.
- [ ] Integrate artifact staging with the build/deploy owner; verify a prior manifest can be fetched for rollback.
- [ ] Implement optional AgentCore Memory ingestion/read adapters only after the core stores/retrieval work.

Deliverable: working object/vector storage and KB, typed artifact/retrieval APIs, sample indexed sources, meaningful retrieval/access tests and teardown documentation.

### Shared first, then parallel work

Agree these before either person builds:

```text
Identifiers: changeId, snapshotId, snapshotHash, buildId,
             executionArn, pathwayId, sourceId, sourceVersion

ArtifactRef: { bucket, key, versionId, sha256, contentType }

Snapshot record: author identity + baseline + specification +
                 evidence versions + golden-case version + toolchain identity

Decision: gate + actor/role + snapshotHash + decision + notes +
          idempotencyKey; deploy adds artifact/report/target identity
```

Teammate uploads artifact first and returns `ArtifactRef`; Yash conditionally registers the immutable snapshot only after verifying the reference/hash. S3 and DynamoDB do not have a shared transaction: design retries and orphan cleanup so incomplete uploads cannot become approved state. A full JSON/report stays in S3; its queryable index and references stay in DynamoDB.

Agree one source of truth for current workflow state: Step Functions drives transitions; DynamoDB stores the queryable projection and immutable decisions. Avoid a second independently advancing state machine in repository code.

## 7. Minimal order and proof of completion

1. Agree IDs, ArtifactRef and hashing/decision schemas using one synthetic fixture.
2. In parallel: Yash builds the four-table layer; teammate builds buckets, artifact API and KB/vector infrastructure.
3. Connect a stored source/snapshot to its DynamoDB version and retrieve correct source-filtered evidence.
4. Demonstrate persisted approval waits, an exact-version decision and recoverable callback delivery with the Step Functions owner.
5. Register a build/test report and deploy decision; retrieve a prior manifest for rollback.
6. Verify access restrictions, tagging, backup/recovery choices and complete teardown. Add optional history/memory last.

## 8. Design inconsistency to resolve before coding approval hashes

The final design includes compiler/toolchain identity in `snapshotHash`, while also saying a compiler-bug fix can reuse the same hash and content approval. These are compatible only when the approved hash inputs do not change. Retry identical inputs with the same hash; changing compiler/toolchain identity changes the documented hash bundle and requires a new review unless the team explicitly revises that rule. Do not implement a storage workaround that silently reuses an old approval for different hash inputs.

The schema-retry wording also differs across sections, but that belongs to the agent/orchestration owners rather than the database split. This work plan does not amend the canonical design or provision resources.
