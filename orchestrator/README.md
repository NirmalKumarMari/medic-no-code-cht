# Orchestrator

Design doc reference: sections 6 (pipeline), 9–11 (decision memory, logic model, change lifecycle), 14 (infrastructure).

Two packages:

- **`cdk/`** — infrastructure. The Step Functions state machine and two small Lambda glue functions. It creates **no tables**: it uses the existing `vera-workflow-Changes`, `-Approvals`, `-Audit` and `-Tokens` tables owned by the root `infra/workflow-data-stack.ts`, so deploy that stack first. Set `WORKFLOW_TABLE_PREFIX` if those tables were deployed with a non-default prefix (the same variable `infra/app.ts` reads). The approvals API defaults to the same names and can be overridden with `CHANGES_TABLE_NAME`, `APPROVALS_TABLE_NAME`, `AUDIT_TABLE_NAME` and `TOKENS_TABLE_NAME`.
  - `invoke-worker` — the only way the state machine calls out to a worker container's HTTP endpoint (Intake, Draft, Change Planner, Logic Checks, Compile, Build/Test, Deploy). Throws on a non-2xx response so Step Functions can route the failure.
  - `request-approval` — fires the instant a `.waitForTaskToken` state starts; its only job is to persist the task token to `Tokens` so a human-facing API can find it later. It never completes the task itself.
- **`approvals-api/`** — the only thing in this codebase that calls `SendTaskSuccess`. A human approves or rejects through `POST /approvals/:changeId/:kind`; this checks separation of duties (approver ≠ author, approver ≠ the other gate's approver), writes the append-only `Approvals` + `Audit` records, then resumes the state machine.

## Run the checks

```bash
cd cdk && npm install && npm run typecheck && npm test && npx cdk synth
cd ../approvals-api && npm install && npm run typecheck && npm test
```

Both are passing and `cdk synth` produces a valid template as of this commit — see each package's own tests for what's actually asserted.

## State machine shape (v1)

```
Intake → [IntakeOk?] → [RouteByRequestKind]
  → plain_language_edit: [IsReplan?] → ChangePlan or Replan → [ChangePlanOk?] → LogicChecks
  → otherwise:           DraftContext → [DraftContextOk?] → [IsRedraft?] → Draft or Redraft → [DraftOk?] → LogicChecks
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

**Approval gates.** The gate's `summary` (stored with the task token) is small: `changeId`, `tenant`, `requestKind`, `pathway`, `runId`, `logicChecks`, plus `buildTest` at deploy. It never holds the guideline text. The decision callback's output is stored at `$.contentApproval` / `$.deployApproval` and must carry `decision: "approve" | "reject"`, the same field as the workflow-data `CallbackPayload`. A `reject` must also carry string `notes`; workflow-data's `recordDecision` includes them in the callback payload. The run records `{ gate, notes }` at `$.revision` and sends it to the re-draft (Draft path) or the re-plan (Change Planner path). A reject without notes stops at `InvalidApprovalDecision`. `approvals-api` sends `decision` and `notes`, and refuses a rejection with empty notes.

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
- **DraftContext** (trusted worker, **not built yet**): `payload` = `{ mode: "drafting", spec }`. Expected `output` = `{ text, contextHash, evidenceRef }` from `PromptContextBuilder.prepare()` in `@vera/artifact-storage`. Agents may not read S3, so this is how the guideline text reaches Drafting.
- **Draft** (`agents/drafting`, `POST /draft`): `payload` = `{ spec: $.intake.output, guidelineText: $.draftContext.output.text }`. `output` = `LogicModel`. Refuses `plain_language_edit`.
- **Redraft** (same endpoint, after a rejection): the same payload plus `revision: { gate, notes, previousLogicModel: $.draft.output }`. The notes are screened with the rest of the prompt, and the model must address them while still citing only the guideline.

- **ChangePlan** (`agents/change-planner-agent`, `POST /change-plan`), stored at `$.changePlan`: `payload` = `{ spec: $.intake.output }`. `output` = `ChangePlan` (`snapshotId`, `snapshotHash`, `proposedLogicModel`, `hashInputs`, `operations`, `riskLevel`, `flags`, `status`, `approvalStatus: "unapproved"`). Refuses anything but `plain_language_edit`. The planner fetches its own baseline by `baselineSnapshotHash` through the Gateway.
- **Replan** (same endpoint, after a rejection): the same payload plus `revision: { gate, notes }`. The notes go in the uncached part of the prompt and are screened with the rest of it. No previous plan is sent; the planner re-plans from the authoritative baseline.
- **Worker auth.** The planner refuses non-loopback calls without its Bearer token (`WORKER_AUTH_TOKEN`). Store that token as the SecretString of a Secrets Manager secret and pass its ARN as the `changePlannerTokenSecretArn` deploy parameter. `invoke-worker` reads it (only that secret), caches it for 5 minutes, re-reads after a 401, and never returns or logs it. A 401, 429 (busy) or 413 is a service fault and ends at `WorkerUnavailable`.
- **`needs_clarification`.** A plan with open flags still returns `ok: true` and goes to Logic Checks, where open flags block content review (workflow-data `recordValidation`). Nothing in the state machine applies or approves a plan.

### Steps not yet on the envelope

These receive the whole `$` as the body. Their reply is stored at their own path, so they don't need to echo earlier fields:

- **LogicChecks**, stored at `$.logicChecks`: must include `passed: boolean`.
- **Compile** (`$.compile`) / **BuildTest** (`$.buildTest`): BuildTest's reply must include `passed: boolean` and `logicMustChange: boolean`, which drive the build-failure split (design doc section 6, decision #7).
- **Deploy** (`$.deploy`): no particular shape required; it's the terminal state.

The two approval gates (`ContentApprovalTask`, `DeployApprovalTask`) don't call a worker. They record the task token and wait for a person's decision from the UI (see "Approval gates" above).
