# Integration contract: Change Planner branch update

Source versions: main `a475d1c`, older Change Planner branch `c55d3e0`. This update is local files only. No GitHub branch was edited. It supersedes the earlier ADR ZIP's private LogicModel and old Intake request format.

## Branch / workspace setup

Keep the existing folder `agents/change-planner-agent`; do not add a second `agents/change-planner` implementation. First merge current main **into your Change Planner branch** (or use an equivalent team-approved branch synchronization), then overlay this package. Nothing requires merging into or changing main.

The root package.json, package-lock.json, tsconfig.json and .dockerignore are included because the agent is now a workspace consuming shared packages. Root build order is storage → workflow-data → TypeScript projects. Dependency installation is root `npm ci`. Remove the obsolete `agents/change-planner-agent/package-lock.json`; the root lockfile governs all workspaces.

Existing consumers must use the current shared `StructuredSpec`: `changeId`, `requestKind: plain_language_edit`, `pathway` (string), `guideline`, `submittedBy`, `baselineSnapshotHash`, `editText`. A snapshot ID is not required from Intake: the trusted baseline service resolves the exact version by hash. Other request kinds fail before tools or models run.

## Deterministic Gateway contracts

The model receives no tool definitions. Code makes at most two calls through actual configured target-prefixed Gateway names. No S3/DynamoDB/KB client is constructed by the agent. The Gateway's tool server and workload/context authorization are shared infrastructure, not implemented by this agent.

### Baseline read

Input: `{changeId,snapshotHash}`. Authorize caller, tenant, pathway and baseline ownership from trusted workflow/workload context; claimed IDs are not grants.

Return `BaselineSnapshotSchema` (exported JSON Schema under this agent's schemas/):

- `logicModel`: the current shared LogicModel. Must equal `hashInputs.spec`. Unknown fields cannot silently disappear. Keep self-referential `snapshotHash` outside bundle.spec; model-supplied hashes are discarded in proposed content.
- `snapshotHash`: the authoritative baseline hash. The agent recomputes it with `@vera/workflow-data` and compares it to the Intake pin.
- `hashInputs`: exact `SnapshotBundle` from workflow-data, with actual source refs, goldenCaseVersion, compilerVersion and pinned toolchainImageDigest. Do not invent missing metadata or use placeholder hashes.
- `plannerContext`: the **actual return value from PromptContextBuilder.prepare(trustedContext, 'change_planner', publishedPrimer)**: `{text, contextHash, source, evidenceRef}`. The source pin includes sourceId/version/sourceHash/sourceS3Ref/provenanceRef. Its text must match the reviewed primer version in src/primer.ts; publish the included exact bytes through the artifact-storage owner. The agent checks text/document hashes and the builder's contextHash composition. The backend must also verify actual immutable receipt/provenance bytes, audit success and caller ownership; a digest string alone does not establish that.
- Optional `guideline`: `{sourceId,version,sha256,text}` with the full public guideline text. Here sha256 is the **exported document byte hash** and matches the evidence pin's `sourceS3Ref.sha256`; the original raw hash can differ after export normalization. A source/version pin and exact text hash are required. Missing context yields clinical citation flags rather than fabricated sources.

The new bundle retains baseline evidence and compiler/golden/toolchain pins, adds/replaces the exact reviewed primer evidence pin, and freezes the actual plannerContext.evidenceRef in the legacy `retrievalEvidenceRefs` array. That field now holds prompt-context receipts, not evidence-search results. Context preparation/audit must happen under the workflow owner's authenticated draft/revision sequence; this agent does not call recordPromptContext or approve a revision itself.

### Draft proposal write

Input: `{plan: ChangePlan}`. Validate schema, baseline authorization and current revision; re-compute the full bundle hash using workflow-data; verify hashInputs.spec equals proposedLogicModel; verify complete operations, evidence/context refs and unapproved status. Write a conditional immutable **proposal draft** only. Exact retries are idempotent; same ID/different bytes is a conflict. Never update a current/approved pointer, approval, decision log or release state.

Return `{status:'draft_stored',snapshotId,snapshotHash}` matching the stored draft. Failure, timeout or a mismatched acknowledgement is not success. The actual Snapshot_Store/repository registration is a separate trusted step; do not revive the branch's old direct `PutCommand`/`v#` storage format.

## Planner output and downstream apply

Output has `requestKind: plain_language_edit`, changeId, baselineSnapshotId/hash, new snapshotId/hash, full proposedLogicModel/hashInputs, code-computed operations/riskLevel, flags, status, approvalStatus:'unapproved', grounding and token/cache metadata. The proposed logic passes the same shared validator as Drafting output.

Operations include add/modify/remove input/rule, final rule/input order, and final flags. Apply add/remove/modify first, then final order arrays and flags, assign the new envelope snapshotId, and prove that the result equals proposedLogicModel. A code-computed riskLevel of wording is a **structural label-only hint**, not medical validation or permission to route a clinically meaningful wording change to a non-clinical reviewer.

The orchestrator owner must:

1. Route Intake using `requestKind === 'plain_language_edit'`. The old separate orchestrator branch's `changeType === 'edit'` choice is stale.
2. Call the private `/change-plan` endpoint with authenticated worker access. Do not embed worker/Identity/CHT secrets in execution JSON or prompts.
3. Send `needs_clarification` or unresolved flags to a human, never automatically apply/approve them.
4. Verify/apply/register the new snapshot through the shared storage/repository lifecycle. The baseline read/draft store do not implement this transition.
5. Run logic checks, deterministic rejected-rule lookup, content approval, compile/offline build and synthetic tests, deploy approval and separate deployment. Preserve actor separation and hash binding. No automatic re-drafting after clinician rejection.

Per run: one happy-path Bedrock call, primary repair, escalated final repair (3 maximum). No retry/escalation after screening/provider/network errors. Shared runtime deadline 105s; screening/tool requests ≤10s, model requests ≤25s. Provider availability and actual deployment timing still need a cloud smoke test.

## What remains external

The private Gateway targets, Cedar ENFORCE policy, short-lived workload identity broker, current source publication/audit adapters, context receipt verification, lifecycle orchestration, UI approvals, compiler/test harness and deployer are not created by this ZIP. No full app deployment is claimed. No KB, vectors, Memory or Cross-Check is added. No agent can apply/compile/approve/deploy through the exposed tool interface.
