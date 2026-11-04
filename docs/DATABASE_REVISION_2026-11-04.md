# Database/storage revision — November 4, 2026

Authority: the user-provided `Medic Mobile - FINAL Solution Design (Open Path) (1).md`, copied verbatim to the repository's canonical FINAL Solution Design. Its §8 requires full guideline text and a curated conventions primer directly in prompts; §9 requires deterministic exact rejected-rule history. Referenced ADR documents were not supplied; this implementation follows the explicit requirements in the revised design rather than inventing missing ADR contents.

## Implemented

- Removed Bedrock Knowledge Base/data-source resources, S3 vector bucket/index, embedding model permissions, the second source bucket, synchronization jobs and the two Bedrock Agent SDK dependencies. Removed semantic RetrievalService/IngestionJobs. Direct Bedrock inference/input screening remain in scope.
- One private versioned SSE-KMS artifact bucket stores raw sources, full readable source exports/provenance, snapshots, prompts/context reports, builds/diffs/tests and proposals. No new sample files or clinical content were generated.
- `SourcePublisher` and `PromptContextBuilder` explicitly load the complete versioned guideline or human-curated primer before inference, verify all bytes/provenance, screen input and await durable context audit. No agent invokes a source-search tool. Actual model/cache integration remains with the agent owner and is not fabricated by this library.
- `recordPromptContext` replaces the old retrieval-audit adapter; the snapshot's legacy hash field `retrievalEvidenceRefs` now holds full prompt-context receipt refs. This avoids an unnecessary hash-format migration and keeps source/citation binding. Existing approved bytes/hashes must remain immutable.
- Exact history hashes normalized rule condition/action and follow-up timing. Content rejections atomically create materialized lookup rows inside Approvals. Reads are strongly consistent and tenant/pathway scoped. Clinical validation requires explicit rules; refreshed high-severity content-review flags are advisory, never automatic rejection. There is no fifth table, new GSI, LLM history agent or AgentCore Memory.
- Updated contracts/examples, worker IAM boundaries, preflight, teardown, work plan and README. Retained explicit agent deny boundaries for unused indexed-service APIs; deny statements do not provision or use those services. Teardown does not delete a historical/shared KMS key and refuses legacy indexed-stack outputs.

## Live AWS inventory

Read-only inspection was completed against workshop account `049197632966`, `us-west-2`, using the existing workshop role. Original receipt: [inventory](../packages/workflow-data/docs/verification/vera-storage-inventory-2026-11-04.json), initially checked `2026-11-04T18:41:49Z` (10:41 AM Pacific), completed `2026-11-04T18:50:32.874318+00:00`.

- Bedrock Knowledge Bases: **zero**.
- S3 vector buckets: **zero**.
- AgentCore Memory resources: **zero**.
- Existing content decisions: **zero**, from a strongly consistent count-only scan of the two existing Approvals probe records. No application-history backfill is needed for this verified dataset.
- `BreakingBarriersStorage`: **not deployed**; regional stacks were `vera-workflow-data`, `kiro-ide-browser`, `base`.
- Four existing workflow tables remain. Their CloudFormation template is unchanged by the materialized-index implementation.

Consequently no KB/vector data, cloud resources, tables, permissions or keys were deleted/modified by this revision. There was nothing live to decommission in this region. No source stack/new IAM roles were deployed just to remove an undeployed KB. No API keys were generated. No demo/application data, clinical decisions, callbacks or deployment results were seeded. Fingerprint behavior was tested using synthetic local DynamoDB, not fabricated AWS approvals.

## Verification

Root TypeScript check, 18 source/context/IaC tests and synthesis passed; workflow TypeScript build, 52 local DynamoDB/consistency/history tests and four-table synthesis passed: **70 tests** total. The synthesized source stack has one object bucket and no KB/data-source/vector/Memory resources. Public example source hashes still match their original bytes. The old root sample publisher is opt-in and was not run.

The workflow package runtime audit is clean. CDK is development tooling; npm still reports its bundled minimatch advisory (including a misleading root omit-dev report because the bundled child lacks a dev marker). `npm ls --omit=dev aws-cdk-lib minimatch` confirms they are not production dependencies. Track the upstream tooling fix; no claim of a clean full development audit is made.

## Remaining integration and migration notes

- Select the real guideline/pathway, curate and review the actual primer, preserve extracted citation/page context, and confirm full text fits the chosen model and screening limits. No truncation or fallback to invented citations.
- Provision the one-bucket source/screening/isolated-worker stack with actual approved identities when the team is ready. Table storage existing in AWS does not imply the application pipeline is running.
- Update callers from RetrievalService/recordRetrievalAudit to PromptContextBuilder/recordPromptContext. No Gateway evidence-search tool remains. Capture the context, freeze its refs into a new snapshot and run checks/content review.
- Trusted logic workers need Query on Approvals; human decision handlers need their existing transactional writes, now including exact rejection index rows. No roles or Gateway/Cedar policies were attached by this database revision.
- Repeated rules in old app decisions require a reviewed history backfill from original immutable snapshots before claiming complete historical coverage. Do not rewrite decisions. The November 3 storage receipts were synthetic probes, not a legacy clinical history dataset.
- Live Cognito/UI, Step Functions callbacks, prompt caching, actual clinical test harness and CHT deployment still need integrated acceptance checks. Other agent/orchestration branches were not overwritten or merged into main.
