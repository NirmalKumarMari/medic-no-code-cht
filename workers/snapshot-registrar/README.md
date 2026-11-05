# Snapshot registrar worker

Trusted, deterministic worker on the services EC2 instance. The Step Functions `RegisterDraft` and `RegisterPlan` states call it after the Drafting Agent or the Change Planner and before Logic Checks (pipeline-orchestrator Req 2.6). No model or agent runs here, and it approves nothing.

For each drafted or planned snapshot it:

1. Builds the Snapshot_Bundle (`@vera/workflow-data` `snapshotBundleSchema`).
   - **Draft:** the LogicModel, the guideline pin and prompt-context receipt from DraftContext, and the configured golden-case, compiler and toolchain versions. `baselineRevision` is `new-pathway`. The snapshotId is `d-` plus 24 hex characters of the content hash; any `snapshotId`/`snapshotHash` the model wrote is dropped. The draft's `pathway` must equal the request's.
   - **Change plan:** the planner's own `hashInputs`. The hash is recomputed and must equal the plan's `snapshotHash`.
2. Writes the bundle's canonical bytes to `snapshots/<changeId>/<snapshotId>.json` with `@vera/artifact-storage` `ArtifactStore` (conditional, immutable, SSE-KMS).
3. Registers it in workflow-data: `createDraft` for the change's first snapshot, `registerRevision` after a rejection. workflow-data reads the stored object back, recomputes the hash and only then writes records.

The **Author** is the requesting program officer (`submittedBy.userId` from Intake's StructuredSpec), on every snapshot of the change. That is the `authorId` workflow-data's `recordDecision` uses to stop the author approving their own change.

The pathway id is a slug of the pathway name (`Child cough and fast breathing` becomes `child-cough-and-fast-breathing`). Every snapshot and later edit of a pathway therefore shares one id, which scopes rejected-rule history.

## Trust boundary

The registrar acts for the program officer named in the request, without a Cognito token of its own. That is safe only because:
- it accepts calls only with its Bearer token (`WORKER_AUTH_TOKEN`, sent by `invoke-worker` from Secrets Manager);
- `submittedBy` comes from the execution input, which only the Review UI service identity may start (pipeline-orchestrator Req 1.10), from the officer's verified identity.

Keep both true when deploying.

## HTTP

`POST /register` answers 200 with `{ ok: true, output: { snapshotId, snapshotHash, pathwayId, artifact, registration } }`, where `registration` is `created`, `revised` or `already_registered`. Otherwise it answers `{ ok: false, failure: { code, message } }`, for example `INVALID_REQUEST`, `INVALID_LOGIC_MODEL`, `PATHWAY_MISMATCH`, `HASH_MISMATCH`, `UNCHANGED_SNAPSHOT`, or a workflow-data code.

Non-2xx responses:
- 401: bad token.
- 503: the previous decision's callback is still being finalized; the state machine retries.
- 500: unexpected error.

## Run

Build from the repository root (`npm ci && npm run build`), then:

```bash
ARTIFACT_BUCKET=... KMS_KEY_ARN=... \
GOLDEN_CASE_VERSION=... COMPILER_VERSION=... TOOLCHAIN_IMAGE_DIGEST=sha256:<64 hex> \
WORKFLOW_TABLE_PREFIX=vera-workflow HOST=0.0.0.0 PORT=8084 WORKER_AUTH_TOKEN=<32+ chars> \
npm start --workspace @vera/worker-snapshot-registrar
```

`SNAPSHOT_SCHEMA_VERSION` defaults to `1`.

## Permissions

- **Artifacts:** the storage stack's `ArtifactWorkerRole` (`s3:PutObject`/`GetObject`/`GetObjectVersion` on `snapshots/*`, KMS encrypt/decrypt).
- **DynamoDB:**
  - Changes: `GetItem`, `PutItem`, `UpdateItem`.
  - Tokens: `UpdateItem`, for superseding an open wait on revision.
  - Audit: `PutItem`.
- Agents must never get this role.
