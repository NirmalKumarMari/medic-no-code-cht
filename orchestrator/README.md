# Orchestrator

Design doc reference: sections 6 (pipeline), 9–11 (decision memory, logic model, change lifecycle), 14 (infrastructure).

One package:

- **`cdk/`** — infrastructure. The Step Functions state machine and two small Lambda glue functions. It creates **no tables**: it uses the existing `vera-workflow-Changes`, `-Approvals`, `-Audit` and `-Tokens` tables owned by the root `infra/workflow-data-stack.ts`, so deploy that stack first. Set `WORKFLOW_TABLE_PREFIX` if those tables were deployed with a non-default prefix (the same variable `infra/app.ts` reads).
  - `invoke-worker` — the only way the state machine calls out to a worker container's HTTP endpoint (Intake, Draft, Change Planner, Logic Checks, Compile, Build/Test, Deploy). Throws on a non-2xx response so Step Functions can route the failure.
  - `request-approval` — fires the instant a `.waitForTaskToken` state starts and opens the wait with `@vera/workflow-data` `openApprovalWait`. It never completes the task itself.

There is **one approval path**, all in `@vera/workflow-data`: `openApprovalWait` (this stack's Lambda) → `recordDecision` (the UI, with a verified Cognito identity; it enforces roles, separation of duties and snapshot binding) → the callback dispatcher (`npm run callbacks --workspace @vera/workflow-data`, a long-running process on the services instance) sends `SendTaskSuccess`. The former `approvals-api` package was removed: it used its own token rows, trusted identity from the request body, and never ran the author check.

## Run the checks

```bash
npm ci && npm run build          # repo root first: cdk links and bundles @vera/workflow-data
cd orchestrator/cdk && npm ci && npm run typecheck && npm test && npx cdk synth
```

These pass and `cdk synth` produces a valid template as of this commit — see each package's own tests for what's actually asserted.

## State machine shape (v1)

```
Intake → [IntakeOk?] → [RouteByRequestKind]
  → plain_language_edit: [IsReplan?] → ChangePlan or Replan → [ChangePlanOk?] → RegisterPlan → [SnapshotRegistered?] → LogicChecks
  → otherwise:           DraftContext → [DraftContextOk?] → [IsRedraft?] → Draft or Redraft → [DraftOk?] → RegisterDraft → [SnapshotRegistered?] → LogicChecks
  → [ChecksPassed?] requires passed: true for the registered snapshotHash
  → [ChecksPassed?] → ContentApproval (⏸ waits for a person in the UI) → [ContentApproved?]
       reject  → RecordContentRejection ($.revision) → back to RouteByRequestKind (drafting phase)
       approve → Compile → BuildTest → [BuildPassed?]
              no  → [LogicMustChange?] → yes: back to RouteByRequestKind | no: retry BuildTest, same hash
              yes → DeployApproval (⏸ waits for a person in the UI) → [DeployApproved?]
                     approve → Deploy → Succeed
                     reject  → RecordDeployRejection ($.revision) → back to RouteByRequestKind (drafting phase)
       (either gate) any other decision value → Fail("InvalidApprovalDecision")
```

Each step's result is kept in `$` at its own path: `$.intake`, `$.draftContext`, `$.draft` or `$.changePlan`, `$.logicChecks`, `$.contentApproval`, `$.compile`, `$.buildTest`, `$.deployApproval`, `$.deploy`. A re-run after a rejection overwrites the earlier result at the same path.

**Approval gates.** Each gate calls `request-approval` with `{ taskToken, changeId, tenant, executionArn: $$.Execution.Id, gate, snapshotHash: $.snapshot.output.snapshotHash }`, the snapshot the registrar just registered. `openApprovalWait` binds the wait to that exact snapshotHash (design rule 4, pipeline-orchestrator Req 5.1) and refuses if the hash is no longer current, the change is not owned by this execution, the gate's prerequisites have not passed (`checked` for content; a tested `release` build for deploy), an ambiguity is open, or the snapshot has no prompt-context evidence. A refusal ends the run at `ApprovalGateRefused` with the workflow-data error code as the cause. At deploy the wait carries the change's history-flag ids, so IT must acknowledge each one. Retrying the Lambda for the same task token reuses the same Tokens row.

Each wait lasts `approvalWaitDays` (stack prop, default 30, max 180): the workflow-data expiry and the Step Functions task timeout are the same, and an expired wait ends at `ApprovalWaitExpired`. The execution timeout is 365 days, the Step Functions maximum.

The callback output (workflow-data `CallbackPayload` `{ changeId, snapshotHash, gate, decisionId, decision, notes? }`) is stored at `$.contentApproval` / `$.deployApproval`. The gate acts only if `decision` is `"approve"`, or `"reject"` with string `notes`, **and** its `snapshotHash` equals `$.snapshot.output.snapshotHash`; anything else stops at `InvalidApprovalDecision`. The run records `{ gate, notes }` at `$.revision` and sends it to the re-draft (Draft path) or the re-plan (Change Planner path). A reject without notes stops at `InvalidApprovalDecision`. `recordDecision` refuses a rejection with empty notes.

**Two things flagged on purpose, not silently done** (also called out in code comments in `cdk/lib/orchestrator-stack.ts`):

1. A rejection at either gate goes back to the drafting phase (Draft for new pathways, Change Planner for edits) by team decision. The design doc's reject loop (section 6) instead re-enters at Logic Checks with a new snapshot.
2. Cross-Check and History-Check (both Should-Have, both first on the design doc's own cut list) aren't wired in yet. Both slot in as additional `invoke-worker` tasks when their agents exist.

## Worker contract every agent/service needs to match

### Execution input

`{ "changeId": "...", "tenant": "...", "request": <IntakeRequest> }`. The execution name becomes the `runId`, so it must match `[A-Za-z0-9][A-Za-z0-9_.-]*` (the default UUID names do).

### Agent envelope (Intake, DraftContext, Draft, ChangePlan)

Defined in `schemas/src/agent-envelope.ts` (`@vera/schemas`). The orchestrator sends:

```json
{ "changeId": "...", "runId": "<execution name>", "tenant": "...", "payload": { ... } }
```

and the agent always answers **200** with an `AgentResult`:

```json
{ "agent": "intake", "changeId": "...", "runId": "...", "tenant": "...", "ok": true, "output": { ... }, "model": { "modelId": "...", "escalated": false } }
{ "agent": "intake", "changeId": "...", "runId": "...", "tenant": "...", "ok": false, "failure": { "reason": "invalid_request", "message": "...", "details": [ ... ] } }
```

Each result is stored with `ResultPath` (`$.intake`, `$.draftContext`, `$.draft`), so the execution input and earlier results stay in `$`. `ok: false` ends the run at `<Step>Failed` with `failure.message` as the cause. A non-2xx or unreachable worker goes to `WorkerUnavailable`.

The envelope is the same for every agent; what differs is `output`. `requestKind` is a field of Intake's output (the `StructuredSpec`), so routing reads `$.intake.output.requestKind`: `plain_language_edit` goes to Change Planner, anything else goes to DraftContext then Draft.

- **Intake** (`agents/intake-agent`, `POST /intake`): `payload` = `IntakeRequest` (its `changeId` must equal the envelope's). `output` = `StructuredSpec`.
- **DraftContext** (trusted worker, **not built yet**): `payload` = `{ mode: "drafting", spec }`. Expected `output` = `{ text, contextHash, source, evidenceRef }`, exactly what `PromptContextBuilder.prepare()` returns (`source` is the guideline pin `{ sourceId, version, sourceHash, sourceS3Ref, provenanceRef }`; the registrar freezes `source` and `evidenceRef` into the snapshot) in `@vera/artifact-storage`. Agents may not read S3, so this is how the guideline text reaches Drafting.
- **Draft** (`agents/drafting`, `POST /draft`): `payload` = `{ spec: $.intake.output, guidelineText: $.draftContext.output.text }`. `output` = `LogicModel`. Refuses `plain_language_edit`.
- **Redraft** (same endpoint, after a rejection): the same payload plus `revision: { gate, notes, previousLogicModel: $.draft.output }`. The notes are screened with the rest of the prompt, and the model must address them while still citing only the guideline.

- **ChangePlan** (`agents/change-planner-agent`, `POST /change-plan`), stored at `$.changePlan`: `payload` = `{ spec: $.intake.output }`. `output` = `ChangePlan` (`snapshotId`, `snapshotHash`, `proposedLogicModel`, `hashInputs`, `operations`, `riskLevel`, `flags`, `status`, `approvalStatus: "unapproved"`). Refuses anything but `plain_language_edit`. The planner fetches its own baseline by `baselineSnapshotHash` through the Gateway.
- **Replan** (same endpoint, after a rejection): the same payload plus `revision: { gate, notes }`. The notes go in the uncached part of the prompt and are screened with the rest of it. No previous plan is sent; the planner re-plans from the authoritative baseline.
- **Worker auth.** The planner refuses non-loopback calls without its Bearer token (`WORKER_AUTH_TOKEN`). Store that token as the SecretString of a Secrets Manager secret and pass its ARN as the `changePlannerTokenSecretArn` deploy parameter. `invoke-worker` reads it (only that secret), caches it for 5 minutes, re-reads after a 401, and never returns or logs it. A 401, 429 (busy) or 413 is a service fault and ends at `WorkerUnavailable`.
- **`needs_clarification`.** A plan with open flags still returns `ok: true` and goes to Logic Checks, where open flags block content review (workflow-data `recordValidation`). Nothing in the state machine applies or approves a plan.

### Snapshot registration (RegisterDraft, RegisterPlan)

`workers/snapshot-registrar` (`POST /register`, see its README) runs after Draft or Change Planner and before Logic Checks (pipeline-orchestrator Req 2.6). It stores the immutable Snapshot_Bundle in the artifact bucket and makes it the change's current snapshot in workflow-data: `createDraft` for the first snapshot, `registerRevision` after a rejection. The **Author is the requesting program officer** (`$.intake.output.submittedBy.userId`), so workflow-data's separation-of-duties check stops them approving their own change.

- Request: `{ changeId, runId, tenant, executionArn: $$.Execution.Id, submittedBy, pathway, kind: "draft", logicModel: $.draft.output, context: { source, evidenceRef } }`, or `kind: "change_plan", plan: $.changePlan.output`.
- Result at `$.snapshot`: `{ ok: true, output: { snapshotId, snapshotHash, pathwayId, artifact, registration } }` or `{ ok: false, failure: { code, message } }`, which ends at `SnapshotRegistrationRefused`.
- For a draft, code assigns the snapshotId from the content (`d-<24 hex>`) and drops any model-supplied `snapshotId`/`snapshotHash`. A plan keeps the planner's id and bundle, and its hash is recomputed and must match.
- A retry of the same registration is idempotent. A re-draft identical to the rejected snapshot is refused (`UNCHANGED_SNAPSHOT`). A 503 while the rejection callback is still being finalized is retried as `WorkerBusy`.
- Protected by its own Bearer token: deploy parameter `snapshotRegistrarTokenSecretArn`.

### Steps not yet on the envelope

These receive the whole `$` as the body. Their reply is stored at their own path, so they don't need to echo earlier fields:

- **LogicChecks**, stored at `$.logicChecks`: runs on `$.snapshot.output.snapshotHash` and must return `passed: boolean` and the `snapshotHash` it checked. Content approval opens only when that hash equals the registered one. It is also expected to have recorded the result with workflow-data `recordValidation`, which moves the change to `checked`.
- **Compile** (`$.compile`) / **BuildTest** (`$.buildTest`): BuildTest's reply must include `passed: boolean` and `logicMustChange: boolean`, which drive the build-failure split (design doc section 6, decision #7).
- **Deploy** (`$.deploy`): no particular shape required; it's the terminal state.

The two approval gates (`ContentApprovalTask`, `DeployApprovalTask`) don't call a worker. They open a workflow-data wait and park until a person decides in the UI (see "Approval gates" above).

### Deployment prerequisites for the gates

- The registrar creates the change (`createDraft`) and every later snapshot (`registerRevision`) under this execution's ARN, so the gates find the change they expect. The logic-checks worker must then record its result with `recordValidation` (moving the change to `checked`), otherwise the content gate refuses with `INVALID_STATE`.
- Run the workflow-data callback dispatcher with `WORKFLOW_TENANT_IDS` set and a role allowed `states:SendTaskSuccess` and `states:GetExecutionHistory` on this state machine's executions. Without it, decisions are recorded but the run never resumes.
- Deploy parameters: `chtTargetId` (the CHT target deploy approvals are bound to), `snapshotRegistrarUrl` and `snapshotRegistrarTokenSecretArn`.
