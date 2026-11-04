# Vera workflow data

Yash's database component for **Medic Mobile — FINAL Solution Design (Open Path)**. See [current deployment and verification status](docs/STATUS.md). This package supplies DynamoDB infrastructure, typed repository APIs, snapshot verification, human decision transactions, durable Step Functions callback delivery, and verified release history. It is a library and internal worker; the web/API service, Cognito verifier, Step Functions definition, build/test harness and CHT deploy adapter belong to the other application components.

The November 4 revision removes the Knowledge Base/vector/Memory architecture and adds deterministic rejected-rule history. Full guideline/curated-primer context is recorded before inference; see the integration guide.

## Local verification

Use Node 22 or newer and Docker. Install dependencies once at the **repository root**, using its shared lockfile:

```sh
npm ci
npm run build
npm run db:local:up
npm test --workspace @vera/workflow-data
npm run db:local:down
```

The root build compiles artifact-storage before workflow-data, which imports its shared contracts. Root `npm test` runs all package and infrastructure suites; root `npm run check` type-checks everything. Package runtime tests live in `tests/`.

Tests are restricted to DynamoDB Local on a loopback endpoint (`http://127.0.0.1:18000` by default). They use synthetic data and a fake Step Functions transport. They do not access AWS, CHT or real clinical data. `docker compose down` stops this package's disposable local container. Local tests cover repository transactions; they do not establish correctness of clinical rules, compiler output, Cognito integration or real Step Functions callbacks.

## Infrastructure and deployment

All CDK infrastructure now lives in the repository-root [infra/](../../infra/README.md). Its `workflow-data-stack.ts` module synthesizes exactly four tables and no IAM resources. This package contains runtime code only; install root dependencies before running infrastructure commands. The package-level `npm run synth` forwards to the root app for compatibility.

| Table | Purpose | Keys and indexes |
|---|---|---|
| `vera-workflow-Changes` | Current state; immutable snapshot, build/test and release history; serialized target pointer | PK `changeId`, SK `sk`; `ReviewInboxIndex` on `inbox`, `inboxSort` |
| `vera-workflow-Approvals` | Immutable human decisions, idempotency receipts and exact rejected-rule index partitions | PK `changeId`, SK `sk` |
| `vera-workflow-Audit` | Append-only event history | PK `changeId`, SK timestamp + UUID |
| `vera-workflow-Tokens` | Internal approval wait and callback outbox | PK `changeId`, SK `WAIT#gate#hash#attempt`; `CallbackDeliveryIndex` on `callbackQueue`, `callbackDueAt`, **KEYS_ONLY** |

All tables use on-demand capacity, AWS-managed encryption, point-in-time recovery, deletion protection and CloudFormation retention. Required approval/audit history has no TTL. Only a successfully delivered token record gets `cleanupAt`; its raw token is removed immediately in the delivery transaction. TTL is cleanup, never authorization or expiry enforcement.

Use an existing authorized AWS session or EC2 role, not committed access keys. Run infrastructure commands from the **repository root**:

```sh
npm ci
npm run synth
aws cloudformation validate-template --template-body file://cdk.out/vera-workflow-data.template.json --region us-west-2
aws cloudformation deploy --template-file cdk.out/vera-workflow-data.template.json --stack-name vera-workflow-data --region us-west-2 --no-fail-on-empty-changeset
ALLOW_AWS_SMOKE=1 AWS_REGION=us-west-2 npm --prefix packages/workflow-data run smoke:aws
```

The explicit AWS smoke probe creates four clearly labeled synthetic `PROBE` rows, checks cross-table atomic writes, rejects an overwrite and verifies transaction rollback. It retains these small rows for traceability. They are not clinical approvals, live workflow state, callback tokens or release evidence. Prefix/stack names can be overridden with `WORKFLOW_TABLE_PREFIX`/`WORKFLOW_STACK_NAME` before synthesis. Keep deployed table names consistent with runtime configuration.

Deletion protection and `Retain` are deliberate: deleting the stack leaves the tables and associated storage/PITR charges. After the challenge, the account owner should review data retention, export anything needed, disable deletion protection only for confirmed disposable tables, then delete those specific tables. Do not assume stack deletion removes data or stops all charges.

## Application integration

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { WorkflowRepository, s3SnapshotVerifier, tablesFromEnvironment } from '@vera/workflow-data';

const region = process.env.AWS_REGION ?? 'us-west-2';
const repo = new WorkflowRepository({
  client: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  tables: tablesFromEnvironment(),
  verifySnapshot: s3SnapshotVerifier(new S3Client({ region }), process.env.WORKFLOW_ARTIFACT_BUCKET!),
});
```

This package is linked by the root npm workspace. Run root `npm run build` before consumption; public repository APIs are exported from `src/index.ts` with declarations in `dist/src`. The read-only S3 integration is `src/snapshot-verifier.ts`; its public `s3SnapshotVerifier` export is unchanged. `ArtifactRef` and `artifactRefSchema` come from `@vera/artifact-storage/contracts` and remain re-exported by this package. Use supported package imports rather than cross-package source paths.

**Trust boundary:** `HumanContext` must be created by the API backend from verified Cognito JWT issuer/audience/signature/expiry, verified subject, server-side tenant membership and allowlisted groups. Never accept subject, groups, tenant membership or workflow identity from an untrusted body. `WorkflowContext` comes from an authenticated internal worker bound to the actual execution ARN. TypeScript types are not authentication. Never expose the entire repository as RPC/agent tools or let callers choose arbitrary methods, table names or contexts. Apply response allowlists at the HTTP boundary and do not serialize SDK errors/request objects.

Agents must have no DynamoDB approval/state/token write permissions and no deploy permissions. Frontend browsers use authenticated backend endpoints, not AWS table credentials. Review handlers and the callback worker are privileged internal services. No IAM grants were attached by this package; proposed role boundaries are in `docs/INTEGRATION.md` and must be wired into the application's existing roles before running the services.

### Workflow contract

1. The trusted storage worker uploads a versioned snapshot JSON bundle and returns `ArtifactRef`. The API invokes `createDraft` with a verified program officer identity and the **real reserved execution ARN**. Coordinate workflow start so validation cannot race draft creation; do not use a fabricated ARN. A draft begins in `draft`.
2. The trusted workflow records structural/risk validation and exact rejected-rule matches. Clinical snapshots require explicit rules. History flags are high-severity advisory signals on content review and never auto-block a clinician; any open ambiguity blocks progression. Clinical changes require `clinician`; wording-only changes allow `program_reviewer` or `clinician`.
3. Each Standard Step Functions `.waitForTaskToken` task passes its actual token, execution ARN, unique attempt ID and real deadline to `openApprovalWait`. The API calls `recordDecision` with the exact current hash and a stable idempotency key. Author/reviewer separation is enforced. One transaction writes the immutable decision, receipt, audit event, current projection and durable callback payload.
4. The callback worker sends `SendTaskSuccess` for **both** approve and reject. The state machine must use a Choice on `decision`; rejection must never fall through to Build/Deploy. While `callbackPending` is true, dependent steps retry `BUSY`/prerequisite failures until outbox finalization completes.
5. Release workers call `assertContentApproved`, `recordBuild`, and `recordTestResult`. Only complete branch coverage, all golden cases and zero errors pass. `preview` evidence never advances release state. The trusted build/test workers must generate and verify actual versioned report/artifact bytes through the teammate's helpers; repository shape checks alone cannot prove an external build/test occurred.
6. Deploy wait fixes the exact build/digest, target and expected previous deployment, with optional advisory history flags. IT must be distinct from author and content reviewer. `getReleaseCandidate` and `acquireDeployment` bind the complete approved release and serialize writes to each tenant/target. An old target pointer blocks deployment.
7. The deploy worker applies only that artifact through its separate CHT deploy role. After reading the actual served CHT settings and verifying the result, upload proof and call `completeDeployment`. If a failed attempt was actually rolled back or the target is confirmed unchanged, upload that proof and call `reconcileFailedDeployment`; this permits retry of the identical approved release. A timeout alone must never release the target lease. Unresolved expired leases deliberately block competing deployments.

For a changed snapshot use `registerRevision`. It preserves immutable history and clears prior approval/build pointers, supersedes an undecided token and binds the new execution. The orchestrator must cancel/stop the previous execution. Changes are blocked while a callback/deployment is actively being finalized. Same-input build retries retain approval; a changed compiler/toolchain identity changes the snapshot hash and requires a new content review.

### Snapshot / artifact contract with teammate

`ArtifactRef` is `{ bucket, key, versionId, sha256, contentType }`, with a real S3 VersionId (never `null`) and lowercase SHA-256 of the **stored bytes**. Snapshot keys must start with `snapshots/` in the configured application artifact bucket. `s3SnapshotVerifier` fetches exactly that VersionId, limits snapshots to 4 MiB, verifies byte hash, parses strict JSON and compares the canonical bundle. It has no write operations.

`SnapshotBundle` includes `schemaVersion`, `baselineRevision`, `spec` JSON object, nonempty `evidenceVersions: [{sourceId, version, sha256, sourceS3Ref}]`, `retrievalEvidenceRefs: ArtifactRef[]`, `goldenCaseVersion`, `compilerVersion`, and `toolchainImageDigest: sha256:<64 hex>`. Preserve evidence array order consistently. `snapshotHash()` hashes the bundle's canonical JSON (sorted object keys, JSON number serialization); timestamps, object location and the hash itself are excluded. This hash and the artifact's byte hash can differ. The design mentions reusing approval for a compiler bugfix while also including toolchain identity in the hash; this implementation follows the hash-bound approval rule and requires review if toolchain identity changes.

Large specs/builds/reports stay in S3; DynamoDB holds their versioned references and compact summaries. Evidence source versions include the exact source S3 reference; `retrievalEvidenceRefs` is the legacy hash field name and now pins full guideline/primer prompt-context receipts. Initial drafts may have no prompt-context receipts, but content review requires a completed bundle with receipt references. See `docs/INTEGRATION.md` for the awaited prompt-context audit adapter and draft/revision sequence. These references must come from the teammate's immutable artifacts, not a mutable document alias. No KB, vector store or AgentCore Memory is used. Prior verified releases come from `listVerifiedReleases`/`getTarget`; advisory history flags cannot override approval or test evidence. Rollback execution itself remains the deploy adapter's responsibility and must preserve the previous verified artifact.

### Callback recovery

After build, configure table names and the real tenant allowlist from `.env.example`, then run `npm run callbacks` under a supervisor/EC2 service role. `npm run callbacks:once` performs one due batch for a scheduler. No service ports are opened. The queue is persisted in Tokens, not process memory; competing workers use a conditional lease. A crash or transient error is retried without another human decision. Lost success responses are reconciled against the exact decision in Standard execution history (up to 2,000 most recent events); token-not-found alone is never treated as success.

Expired/terminal delivery with no exact history evidence becomes `needs_attention` and remains blocked. Alert on that log event and on repeated `callback.*_failed`. The workflow owner must reconcile the original execution and persisted decision before any replacement execution/token is bound; there is intentionally no unsafe automatic success/reapproval bypass. Do not edit decision/audit rows to repair a workflow. Pending/superseded/attention rows have no automatic deletion deadline; apply the project's retention policy through a reviewed maintenance procedure.

UI reads are tenant-scoped: `getChange`, `getSnapshot`, `listInbox`, `listDecisions`, `listAudit`, `getTarget`, `listVerifiedReleases`. Audit/inbox expose cursors; decision/release helpers consume every page. Inbox GSI reads are eventually consistent; validate the exact current base-table version/hash for decisions. Never expose `Tokens`, `read`, `query`, `commit`, or dispatcher internals through UI APIs. DynamoDB conditional writes enforce append-only history through these APIs; this is not WORM storage against a broadly privileged administrator.

## Exact rejection history

`fingerprintRules(spec)` computes versioned hashes of structural `when` + `then` + optional `followUp`, independent of rule IDs/citation labels. `all`/`any` condition order is normalized; other array order is retained. Sources and the complete spec still remain bound by snapshotHash. Rules are capped at 80 for the atomic rejection transaction.

`recordDecision` content rejections write materialized index rows to Approvals under `HISTORY#tenant#pathway#fingerprint`, keyed by decision timestamp/ID. It records that the rule appeared in the rejected snapshot, not a new clinical judgment about each individual rule. IT rejections do not enter this index. `checkRuleHistory` performs strongly consistent key queries for the latest rejection per current rule. `recordValidation` and content-review opening refresh advisory `historyFlags`, which the human decision preserves. No GSI/fifth table or additional model call is needed. UI links use the prior change/snapshot/decision IDs; note excerpts are bounded. See integration docs for historical backfill limitations and worker Query permissions.

## Dependency check

Run dependency audits from the repository root, which owns the shared workspace lockfile. CDK dependencies now belong only to the repository root. The root CDK development dependency bundles a `minimatch` version with moderate advisory [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). It is used only for local template synthesis; no untrusted glob input is accepted, and CDK is omitted from production installs. Track the upstream fix. Do not report a clean full development dependency audit.
