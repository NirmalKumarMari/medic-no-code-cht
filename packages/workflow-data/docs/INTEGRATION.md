# Integration handoff

This is Yash's workflow persistence module. The teammate's storage contracts were read at `origin/database` commit `b189fc2` on November 3, 2026. Her implementation files remain unchanged; this package is added alongside them. `ArtifactRef` matches her `src/contracts.ts` structurally; source raw hashes and exported-document hashes remain separate. The app owners still need to connect actual authentication, state machine and CHT/build workers. Local transport fixtures are not a live end-to-end approval demonstration.

## Ownership and startup sequence

1. Teammate deploys her artifact bucket/KMS/storage service separately and supplies the bucket, KMS key ARN and permitted reader roles. This module does not duplicate her buckets, KB, vectors or Memory.
2. API/workflow owner reserves a real execution ARN, creates the draft through a verified program officer, then starts processing. A starting draft may have `retrievalEvidenceRefs: []` and catalog-pinned `evidenceVersions`; such a draft cannot enter content approval.
3. Inject the adapter below into her `RetrievalService` for an existing current draft. The trusted backend resolves tenant/execution context; agent JSON never supplies it. Request IDs are unique per distinct query/result attempt. Persisting the receipt is awaited and failures propagate.
4. Collect immutable evidence/source references from the retrieval receipt; upload the completed bundle to a new snapshot ID, then call `registerRevision` with the previous expected hash and its coordinated new execution. Stop/supersede the prior execution. That new hash binds the evidence before content approval; a retrieval receipt does not silently mutate an approved snapshot.
5. All further operations follow the README workflow contract. UI/backend owners supply verified identities; orchestrator owns ordering; worker identities are isolated from agents. Approved artifact bytes are staged before the no-network builder starts.

```ts
// worker is created by authenticated internal code for this actual execution.
const retrievalAudit = {
  async record({ context, queryHash, evidenceRef }) {
    await repo.recordRetrievalAudit(worker, {
      changeId: context.changeId, snapshotId: context.snapshotId,
      requestId: context.requestId, queryHash, evidenceRef,
    });
  },
};
```

The method requires the current `draft`/`draft_failed`, matching execution, current snapshot ID and exact receipt path. It transactionally appends an audit event and idempotent receipt index. It never stores raw queries in DynamoDB; those belong in the screened S3 receipt. The final bundle includes:

```ts
evidenceVersions: [{
  sourceId: evidence.sourceId,
  version: evidence.version,
  sha256: evidence.sourceHash,    // original source section, before export
  sourceS3Ref: evidence.sourceS3Ref, // exact exported section bytes + VersionId
}],
retrievalEvidenceRefs: [evidenceRef], // query/result receipts from the awaited audit callback
```

Freeze these references as well as the logic/spec, baseline, golden cases and compiler/toolchain. Re-fetch and verify them using her `ArtifactStore` before approving/building. Preserve them if the live KB is re-indexed. An empty retrieval result must remain an unresolved validation issue; do not manufacture citations to fill this bundle.

## Proposed IAM boundaries

The four-table stack does not create/attach IAM roles or credentials. These permissions are intended for the app's **separate existing service roles**, once their actual names/isolated runtime environments are known. Do not attach them to agent roles or share an EC2 instance profile with agents. Table ARNs come from the stack outputs. No runtime component needs `Scan`, `DeleteItem`, table deletion or backup administration.

| Component | Required table permissions | Additional permissions |
|---|---|---|
| UI read backend | `GetItem` Changes; `Query` Changes, Approvals, Audit, Changes/ReviewInboxIndex | Verified Cognito identity at API boundary; no Tokens |
| Trusted draft/workflow worker | `GetItem` Changes, Approvals, Tokens; transactional `PutItem` Changes, Tokens, Audit; transactional `UpdateItem` Changes, Tokens; transactional `ConditionCheckItem` Changes | `s3:GetObjectVersion` configured `snapshots/*`; KMS decrypt on teammate key with S3 encryption context; worker verifies external build/test/proof files via artifact helpers |
| Human decision handler | `GetItem` Changes, Approvals, Tokens; transactional `PutItem` Approvals, Audit; transactional `UpdateItem` Changes, Tokens | Verified identity/group/tenant checks and context construction. Never expose raw token reads as an HTTP method |
| Callback worker | `GetItem` Changes, Tokens; `Query` Tokens/CallbackDeliveryIndex; `UpdateItem` Tokens for claims/retries and final transaction; transactional `UpdateItem` Changes; transactional `PutItem` Audit | `states:SendTaskSuccess` (token-scoped API, resource `*`), `states:GetExecutionHistory` restricted to the actual project's execution ARN pattern |
| Build sandbox / agent containers | None | Offline builder receives verified read-only staged bytes. Agent Gateway policies cannot substitute for role isolation |

DynamoDB authorizes transactions using the underlying `PutItem`, `UpdateItem`, `GetItem`, and `ConditionCheckItem` actions, with `dynamodb:EnclosingOperation = TransactWriteItems` where transactional writes are required. There is no need to invent a `dynamodb:TransactWriteItems` IAM grant. See [AWS transaction IAM documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html). Keep Approvals/Audit put-only for writers; this repository additionally uses conditional inserts. Broader administrator privileges can bypass application append-only rules, so they must not be available to running agents/services.

The callback worker has no S3/model/CHT/Secrets Manager permissions. The distinct CHT deployer must still satisfy deploy approval and own the target lease; this package never reads CHT credentials. The infrastructure/bootstrap operator may use the existing workshop role for deployment; it is not an application runtime identity.

## Operational recovery

- Retry an identical human decision with the same idempotency key. Altered content under that key is rejected.
- Retry `CONFLICT` only after reading current state/hash. Never turn a stale snapshot error into approval for a new hash.
- While `callbackPending` is true, retry dependent workflow transitions. Success may have reached Step Functions before database finalization; outbox history reconciliation recovers that gap.
- `needs_attention` is a deliberate stop. Inspect the original execution and immutable decision. If execution history exceeds the dispatcher's bounded lookback, investigate the full history before repair. Do not assume token expiry means callback delivery succeeded.
- An unresolved deployment lease is not stolen after a timeout. First verify the actual CHT target. Record the exact deployed result with `completeDeployment`, or, only after confirmed rollback/unchanged target, use `reconcileFailedDeployment` with versioned verification proof. A different target revision requires a newly reviewed deployment intent.
- To recover table loss, an operator restores PITR to new tables, verifies all four tables' consistency and updates service configuration together before resuming workers. PITR is per-table, so test this coordinated recovery before production. Never resume callbacks from an unexamined partial restore.

Optional exact rule-fingerprint history and AgentCore Memory remain deferred. They are advisory and cannot override these transactions or clinical validation.
