# Orchestrator

Design doc reference: sections 6 (pipeline), 9–11 (decision memory, logic model, change lifecycle), 14 (infrastructure).

Two packages:

- **`cdk/`** — infrastructure. The four DynamoDB tables (`Changes`, `Approvals`, `Audit`, `Tokens`), the Step Functions state machine, and two small Lambda glue functions:
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
Intake → [RouteByChangeType] → Draft (new_pathway) or ChangePlan (edit) → LogicChecks
  → [ChecksPassed?] → ContentApproval (⏸ task token) → [ContentApproved?]
       no  → back to RouteByChangeType  (see "known simplification" below)
       yes → Compile → BuildTest → [BuildPassed?]
              no  → [LogicMustChange?] → yes: back to RouteByChangeType | no: retry BuildTest, same hash
              yes → DeployApproval (⏸ task token) → [DeployApproved?]
                     yes → Deploy → Succeed
                     no  → Fail("DeployRejected")
```

**Two things flagged on purpose, not silently done** (also called out in code comments in `cdk/lib/orchestrator-stack.ts`):

1. The design doc's reject loop says a rejection should re-enter at Logic Checks via a revision step, not re-run the original drafting agent from scratch. The Change Planner Agent that would do that revision doesn't exist yet, so v1 loops back to Draft/ChangePlan instead. Swap the target once that agent exists.
2. Cross-Check and History-Check (both Should-Have, both first on the design doc's own cut list) aren't wired in yet. Both slot in as additional `invoke-worker` tasks when their agents exist.

## Worker contract every agent/service needs to match

Every state calls a worker via `POST <workerUrl>` with the current state's full payload as the body, and expects back either a 2xx with the next state's input as JSON, or a non-2xx (which the state machine currently lets fail the execution — add a `.addCatch()` per state once there's somewhere useful to route failures). Concretely:

- **Intake** (built, see `agents/intake-agent/`): input = raw officer request, output = `StructuredSpec` (includes `changeId`).
- **Draft / ChangePlan** (not yet built — this is what your teammate is working on): input = whatever Intake/the prior loop produced (has `changeId`); expected output includes at least `{ changeId, snapshotId, snapshotHash, flags: [...] }` for Logic Checks to consume.
- **LogicChecks**: expected output includes `{ ...prior, passed: boolean }`.
- **Compile / BuildTest**: BuildTest's output must include `{ ...prior, passed: boolean, logicMustChange: boolean }` — this is what drives the build-failure split (design doc section 6, decision #7).
- **Deploy**: no particular output shape required; it's the terminal state.

The two approval endpoints (`ContentApprovalTask`, `DeployApprovalTask`) don't call a worker at all — they wait on a human via the Approvals API. Whatever payload is in flight when the wait starts (the `summary` field written to `Tokens`) is exactly what gets carried forward, plus `approved`/`notes`/`approvedBy`, once a human decides.
