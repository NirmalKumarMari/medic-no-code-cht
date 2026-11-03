# Artifact storage and cited retrieval

Implements the teammate scope from `Medic Mobile - FINAL Solution Design (Open Path).md` (canonical), followed by `DATABASE_WORK_PLAN.md`. The initial local checkout had no implementation, remote or IaC conventions. This starts a TypeScript CDK module, an option explicitly allowed by the design. DynamoDB, decisions, approvals, callback tokens and canonical snapshot hashing remain Yash's scope. AgentCore Memory is deferred.

## Local verification

Requires Node 22+ and npm. No credentials needed for these checks:

```sh
npm ci
npm run check
npm test
npm run synth
```

Tests cover corruption and version binding, immutable upload retries/conflicts, rollback manifest verification, forbidden ingestion categories, screening failure, unauthorized retrieval, stale evidence, incomplete citations, audit failure and infrastructure boundaries. These use simulated SDK responses and CDK assertions; they do not prove live AWS permissions, ingestion, or retrieval quality.

## Deploy

Use your organization's configured AWS credential chain (SSO, role, or profile); never put credentials in source or `.env` files. In a fresh environment, configure access externally first. No AWS access was configured in the implementation environment.

```sh
export AWS_PROFILE=your-configured-profile
export AWS_REGION=us-west-2
npm run preflight
npx cdk bootstrap
npm run deploy -- --parameters AgentRoleNames=intake-role,drafting-role,crosscheck-role,planner-role,history-role
```

Supply **every** existing agent role name in this account. Deployment attaches an explicit deny policy to those roles. Do not supply service roles here. IAM identities must not be able to detach their own deny policy, change bucket policies, assume/pass service roles, or obtain the retrieval instance's credentials. The backend owns AgentCore Identity, Gateway and Cedar integration. The service roles are EC2 trust roles to bind to separately isolated worker containers/hosts, not identities to share with agent containers. Do not expose a host instance profile to agents. Offline build containers receive staged bytes and no AWS identity.

`preflight` checks STS identity and regional CloudFormation types. An authenticated deployment and ingestion test must still verify S3 Vectors/Bedrock integration support, quotas, Titan model access, KMS permissions and IAM propagation. No OpenSearch fallback is provisioned alongside S3 Vectors.

Outputs in `outputs.json`: both object bucket names, KMS key ARN, vector bucket/index ARNs, KB ID/ARN, the three data source IDs, worker role ARNs and published Guardrail ID/version. Both embedding and index dimensions are 1024, float32, cosine. Bedrock-managed text/metadata fields are nonfilterable. Documents are prepared whole sections with `NONE` chunking to preserve tables and exact citations. Every section must fit the 6000-byte preparation limit; larger sections/tables require a reviewed export strategy rather than arbitrary truncation.

AWS references: [S3 Vectors integration and metadata limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html), [vector-store prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-setup.html), [standalone Guardrail screening](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-use-independent-api.html).

## Publish and sync sources

`examples/sources/catalog.json` contains a downloaded public CDC hand-hygiene guideline section, a pinned CHT documentation introduction and one complete task object from pinned `cht-core/config/default/tasks.js`. They are smoke-test candidates, **not the team's finalized clinical pathway**. CDC section 5a includes its full table row and comments. The reference task retains references to helpers in the original repository; it is documentation, not compiled configuration. Source hashes identify the selected raw sections before the deterministic text export; exact raw bytes and provenance receipts are also retained in the artifact bucket. URLs, source paths and extraction descriptions are recorded in the catalog. The CHT commits are pinned, not `main`/`master` aliases.

A trusted operator reviews the entire content and provenance before publishing. Ingestion then applies the published Bedrock Guardrail to content and metadata before any S3 write. No bypass/fallback exists on screening errors. Guardrails can produce false positives, especially clinical wording: investigate a rejection rather than quietly removing screening. Only public guideline/CHT/reference documents are permitted. Never feed prompts, decisions, patient records, credentials, golden cases, test fixtures or hosted MCP answers into this path. Extension/path checks and a reviewer attestation supplement screening; they are not a general PHI classifier.

Set the output-derived configuration in the trusted ingestion worker environment:

```sh
export ARTIFACT_BUCKET=...
export KB_SOURCE_BUCKET=...
export KMS_KEY_ARN=... # full ARN, used consistently for writes and reads
export KNOWLEDGE_BASE_ID=...
export GUIDELINE_DATA_SOURCE_ID=...
export CHT_DOCS_DATA_SOURCE_ID=...
export REFERENCE_CONFIG_DATA_SOURCE_ID=...
export GUARDRAIL_ID=...
export GUARDRAIL_VERSION=... # published numeric version, never DRAFT
export SOURCE_REVIEWER=your-review-identity
export SOURCE_REVIEWED_AT=2026-11-03T23:00:00Z # actual review time; keep stable on retries
npm run publish-samples
npm run sync-sources
```

`publications.json` is a local receipt, ignored by Git. The sync command starts three idempotent jobs and records the batch, job IDs and observed status in the artifact bucket. Rerun to observe/resume the same jobs; a nonzero exit means not yet COMPLETE or document failures. Do not enable sources until all jobs are COMPLETE with zero failed documents and live citation tests pass. Serialize publication and sync per data source: Bedrock sync scans the **entire prefix**, not just a passed batch. A crash between document and sidecar leaves a screened orphan; rerun publication with identical review metadata before syncing. Incomplete metadata always fails retrieval closed. Re-index/replacement uses a new source version or content digest and never edits prior evidence references.

Raw `.js` is deterministically wrapped as readable fenced text with its file/commit reference. Export XLSForm/PDF/other unsupported inputs to reviewed text sections before this API; do not pass binaries as text. Tables must remain whole. The source API only accepts reviewed UTF-8 md/txt/js sections.

## Integrate

See [the handoff contract](HANDOFF.md), [integration examples](../examples/integration.ts), and `src/contracts.ts`. `putArtifact` uses a conditional create and explicit SSE-KMS + SHA-256; equal retries recover the original version, conflicting bytes fail. `getArtifactVersion` pins the VersionId, checks bucket/key/content type/KMS key and recomputes the digest. Manifest verification recursively checks each listed file's exact reference (the manifest is a nonempty flat array of ArtifactRefs). Fetch a prior approved manifest for rollback; this module does not authorize rollback or deployment.

Only `RetrievalService` calls Bedrock Retrieve. Supply a trusted context loaded by the authenticated backend from the pinned snapshot; never deserialize grants from agent input. Source ID/version/type/hash and optional workflow are filtered in the request and checked again on every result. Missing provenance, wrong location, a modified checksum or text that does not match the exact stored section causes failure. No page/table is invented. No clinical correctness decision is made here.

Retrieval stores screened query/results in `reports/<changeId>/retrieval/<snapshotId>/<requestId>.json`, then awaits the injected durable audit callback. It logs only hashes/IDs/references to stdout; the backend must ship container stdout to CloudWatch. Audit failure prevents evidence delivery. Use unique request IDs for distinct attempts; retries using a key with changed evidence fail rather than replace evidence. The backend owns the HTTP/container endpoint, authentication, Gateway routing, per-agent Cedar tool permissions, snapshot evidence registration and Yash's DynamoDB audit adapter. This library does not expose an unauthenticated HTTP server.

Dependency audit currently reports two moderate findings from CDK's bundled `minimatch` dependency (GHSA-g3hv-75wg-m249). This is an infrastructure tooling dependency; do not accept untrusted glob patterns in deployment tooling. npm reports no upstream automatic fix for the bundled copy.

## Live acceptance checks still required

After authenticated deployment: publish the samples, wait for COMPLETE/zero failures, retrieve each source using the exact grants, verify returned text/hash/version/citations, and try a different version/source/workflow to confirm rejection. Use IAM policy simulation and an actual agent-role request to prove direct Retrieve, source-bucket reads/writes and vector operations are denied. Verify the ingestion role cannot approve changes or read secrets, and that agent containers cannot use EC2 service credentials. Stage and verify a prior manifest outside the offline build container. Measure and record regional ingestion/retrieval costs; no fabricated cost figures are supplied.

## Teardown

Normal `npm run destroy` retains both versioned object buckets and the KMS key to protect evidence; it deletes the KB/data sources/vector index/vector bucket and IAM resources. Export evidence first. For an explicitly disposable deployment, stop publishers, retrieval workers and ingestion jobs, then run:

```sh
CONFIRM_DELETE_STACK=BreakingBarriersStorage npm run teardown
```

This command resolves exact resource names from CloudFormation outputs, permanently deletes **all object versions and delete markers**, destroys the stack (including vectors), deletes retained object buckets and schedules the retained KMS key for deletion in seven days (AWS minimum). It requires an administrator teardown role; runtime worker roles have no delete privileges. Do not run it against shared/production resources. If interrupted, use saved `outputs.json` and CloudFormation events to finish retained-resource cleanup; a second call after stack deletion cannot rediscover outputs. Verify the account's resource inventory/billing afterward. There are no EC2 instances or volumes in this module to clean up.
