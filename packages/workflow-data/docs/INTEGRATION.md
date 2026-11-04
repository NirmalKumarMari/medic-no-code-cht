# Workflow database integration — November 4 revision

Canonical source: revised FINAL Solution Design. Root storage now publishes screened full sources and prepares exact guideline/primer text for prompts. There is no KB, semantic retrieval service, embeddings, vector store or AgentCore Memory. Changes/Approvals/Audit/Tokens remain the four tables; their physical key schemas are unchanged. Actual UI/authentication/Step Functions/model/build/CHT integration remains with those component owners.

## Source/context and snapshot flow

1. A trusted operator publishes the actual guideline and reviewed CHT primer through root `SourcePublisher`. Source text and raw/provenance versions stay under `docs/` in the one private versioned artifact bucket. Publication is not a search/ingestion job. The source and artifact SHA-256 values can differ after deterministic text export.
2. Reserve the actual workflow execution ARN and create the draft via a verified program officer. Its `evidenceVersions` pins the chosen source versions. An initial draft can have an empty legacy `retrievalEvidenceRefs` array but cannot enter content review until full prompt context is captured.
3. Root `PromptContextBuilder.prepare(trustedContext, mode, publishedSource)` reads/verifies/screen-checks the entire versioned guideline (`drafting`) or curated primer (`change_planner`). No model chooses source IDs or calls an evidence tool. The model caller includes this exact full text in its prompt and applies supported caching/token limits without silent truncation.
4. The builder writes the full receipt under `reports/<changeId>/context/<snapshotId>/<requestId>.json` and awaits the adapter below. The adapter requires the current draft/snapshot and real trusted execution identity. Context hashes/ref paths/request IDs are validated. No full source/prompt text is stored in DynamoDB.
5. Freeze the returned source pins and context receipt refs into a new snapshot version using `registerRevision`; coordinate the new execution and stop/supersede the old one. Validation, history check and both human gates apply to that exact version. Capture does not silently alter an approved snapshot.

```ts
const contextAudit = {
  async record({ context, contextHash, evidenceRef }) {
    if (context.tenantId !== worker.tenantId) throw new Error('Tenant mismatch');
    await repo.recordPromptContext(worker, {
      changeId: context.changeId, snapshotId: context.snapshotId,
      requestId: context.requestId, contextHash, evidenceRef,
    });
  },
};
// Freeze builderResult.source.sourceId/version/sourceHash/sourceS3Ref in evidenceVersions.
// Keep the legacy field name, now containing exact prompt-input receipt references:
// retrievalEvidenceRefs: [builderResult.evidenceRef]
```

`recordPromptContext` writes `CONTEXT#<snapshotId>#<requestId>` plus an append-only `prompt_context.recorded` event, transactionally. Identical retries are idempotent; altered reuse fails. Schema/hash field `retrievalEvidenceRefs` is retained to avoid an unnecessary hash-format migration; it no longer represents KB query results. Do not fabricate old query records or rewrite already-approved snapshot bytes. Full prompt instructions/model-call traces are separately screened S3 report artifacts. Citation correctness still requires the deterministic/model-output checks owned by the logic/agent components.

## Deterministic rejection history

`fingerprintRules(spec)` uses explicit rule `id`, `when`, `then`, optional `followUp`; fingerprints exclude IDs/citation labels but include follow-up timing. Object-key order and all/any term order are normalized with stable lexical comparison. Other array ordering is preserved. No model or general theorem prover infers equivalence. At most 80 explicit rules fit the current atomic rejection transaction. A clinical snapshot without explicit rules cannot successfully validate; an intake/wording draft can exist before rules are available.

Content rejection appends one index row per unique fingerprint **in the same transaction** as the decision, idempotency receipt, audit and callback state. Approvals PK is `HISTORY#<tenant>#<pathway>#<fingerprint>`, SK `<timestamp>#<decisionId>`; actual originating change ID is `sourceChangeId`. This is a materialized key index in the existing table, requiring no fifth table, GSI or table replacement. Approvals still has its normal per-change CONTENT/DEPLOY/IDEMP records. Index rows are append-only, never edited to reflect a later approval. IT deployment rejections are not clinical rejection history.

`checkRuleHistory` strongly consistently reads the most recent rejection per rule, scoped to tenant/pathway. `recordValidation` folds it into Logic Checks; opening content review refreshes it. At most one latest-history flag per current rule is returned; the prior decision/snapshot references allow the UI to show full context. Short note excerpts bound projection size. If a whole snapshot was rejected, the index says a rule appeared in that rejected snapshot; it does not claim each rule was individually adjudged unsafe.

`historyFlags` are high-severity **advisory** flags on content review and are preserved in the decision record. They never turn a passed validation into failure or automatically block the clinician. Ambiguity/failed tests still block progression normally. Existing explicit IT flag acknowledgements remain available to callers that supply them, but there is no separate History Check agent/state or semantic similarity layer.

For any historical application snapshots created before this revision, do not claim complete fingerprint coverage without a reviewed backfill from their exact immutable bundles and original content decisions. Never modify old decisions or derive history from Memory. The verified November 3 AWS dataset contained only synthetic storage probes, not application decisions.

## Permissions and trust boundary

`HumanContext` must come from verified Cognito JWT issuer/audience/signature/expiry, server-derived tenant membership and allowlisted roles. Never accept subject/groups/tenant identity from request JSON. `WorkflowContext` is an authenticated actual worker execution identity. TypeScript interfaces are not authentication. Expose allowlisted HTTP operations/response fields rather than the whole repository. Never send raw SDK errors, tokens or table-query internals to UI/model callers.

The four-table stack creates no IAM roles/grants. Wire these into actual isolated service roles; agents and offline build containers get no table permissions:

| Component | Table access |
|---|---|
| UI read backend | GetItem Changes; Query Changes/Approvals/Audit and Changes/ReviewInboxIndex; no Tokens |
| Trusted workflow/logic worker | GetItem Changes/Approvals/Tokens; Query Approvals for history; transactional PutItem Changes/Tokens/Audit; transactional UpdateItem Changes/Tokens; ConditionCheckItem Changes |
| Verified human decision handler | GetItem Changes/Approvals/Tokens; transactional PutItem Approvals/Audit (including rejection index rows); transactional UpdateItem Changes/Tokens |
| Callback worker | GetItem Changes/Tokens; Query Tokens/CallbackDeliveryIndex; UpdateItem Tokens for leases/retries; transactional UpdateItem Changes and PutItem Audit |

Transactions use underlying PutItem/UpdateItem/GetItem/ConditionCheckItem permissions, with `dynamodb:EnclosingOperation` restricting transactional writes as appropriate. No runtime role requires Scan/DeleteItem or table administration. Callback worker additionally uses SendTaskSuccess and project-scoped GetExecutionHistory; it needs no S3/model/CHT/Secrets Manager permissions. Root prompt/source workers need explicit scoped S3/KMS/Guardrail permissions plus the internal authenticated audit callback, never approval authority. Shared EC2 instance credentials must not be available to agents.

## Recovery and acceptance

- Retry identical decisions with the same idempotency key; refresh current state/hash on conflicts.
- Retry dependent transitions while callback finalization is pending. Exact execution-history reconciliation recovers a lost success response. Token disappearance alone never proves delivery.
- `needs_attention` requires reconciliation with the original execution/decision. There is no automatic expiry bypass; history lookback is bounded.
- Never steal an unresolved deployment lease after a timeout. Verify actual CHT state, then record exact completion or confirmed rollback/unchanged-target evidence through the recovery APIs.
- Coordinated PITR restore must inspect all four tables and paused callback/deployment state before resuming.
- Local tests validate storage consistency and synthetic history/callback behavior. Actual Cognito/Step Functions/model caching/clinical citations/CHT correctness need integrated acceptance checks.

No clinical/sample AWS or CHT records are seeded by this change. The two human approvals, snapshot hashes, immutable artifact refs and real build/test evidence remain mandatory. A compiler/toolchain identity change changes the documented hash inputs and requires new approval; only truly unchanged-input infrastructure retries reuse an approval. The source document's tooling-retry wording does not authorize silently changing hash inputs.
