# Requirements Document

## Introduction

This spec covers the Pipeline_Orchestrator of the Vera Solution Design: the AWS Step Functions standard workflow and its workers that move one change through a fixed sequence of states (§6), the change lifecycle (§11), and the two human approval gates (§3 rules 2 and 4). The orchestrator is the arbiter of the pipeline (§18). It runs states in a fixed order that no agent can skip, parks a task token at each approval gate so a pending approval survives a restart, binds every approval to one exact snapshotHash, and writes every human decision to the append-only Decision_Log through a Step Functions step, never through an agent.

The spec also owns the loops in §6. A rejection or a plain-language edit produces a new Snapshot that re-enters at Logic checks, never at the Drafting agent (rule 3). An Agent_Failure stops the change and surfaces the error to a person, never a guess (rule 7). A build failure either forces a new snapshotHash and a new content approval, or rebuilds the same snapshotHash under the existing approval when the Hash_Inputs are unchanged (Decisions Log #7). Retries are bounded, and a preview Snapshot never reaches `deployed`. Rollback redeploys a prior tested, approved release Snapshot through the cht-deployer.

Source: Solution Design §3, §5, §6, §11, §14, and §18.

### Dependencies

| Spec | What this spec uses or provides |
|---|---|
| logic-model-snapshots | Uses: Snapshot_Service (store, read with Integrity check), Hash_Calculator, Hash_Inputs, Toolchain_Identity, Designation, Origin, Change_Plan_Applier. The Changes table also serves as that spec's Index_Table; this spec owns only the change-state items. |
| authoring-agents | Uses: Intake Agent, Drafting agent, Change Planner Agent, and the Agent_Request, Agent_Result, and Agent_Failure contracts, including the schema-repair loop that runs before an Agent_Failure is returned. |
| logic-checks-golden-cases | Uses: Logic_Checker Run, Check_Report, Check_Report location, Overall result, Flags listing. |
| review-ui-approvals | Provides: Start_Requests, Approval_Decisions, Revisions, Escalation_Resolutions, and Rollback_Requests, together with role and separation-of-duties enforcement. Uses: Parked_Token items, Escalations, and change history from this spec. |
| cht-config-compiler | Uses: compile of an approved snapshotHash and its Build_Failure_Category on failure. |
| build-test-sandbox | Uses: build and synthetic-patient test of an approved snapshotHash, Build_Record, and Build_Failure_Category on failure. |
| cht-deployer | Uses: deploy and verify of a Build_Record, redeploy for rollback, and the deployer's own release-only refusal. |
| decision-memory-history-check (Should-Have) | Uses: the History_Check worker and its History_Flags when History_Check is enabled. Reads the Decision_Log written by this spec. |
| platform-infrastructure | Provides: the State_Machine resource, the Changes, Approvals, Audit, and Tokens tables, the Artifact_Bucket, the services EC2 instance, and the IAM roles named in this spec. |

## Glossary

Terms reused from earlier specs keep the meaning defined there.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **Snapshot**, **snapshotHash**, **Snapshot_Service**, **Hash_Inputs**, **Hash_Calculator**, **Toolchain_Identity**, **Designation**, **Origin**, **changeId**, **Author**, **Base_Snapshot**, **Flag**, **ChangePlan**, **Change_Plan_Applier**, **Integrity check**, **Artifact_Bucket**: As defined in the logic-model-snapshots spec.
- **Logic_Checker**, **Run**, **Check_Report**, **Check_Report location**, **Overall result**, **Decision_Log**, **Pipeline_Orchestrator**: As defined in the logic-checks-golden-cases spec. In this spec, the Decision_Log consists of the Approvals table, the Audit table, and a Decision_Log prefix in the Artifact_Bucket.
- **Agent_Request**, **Agent_Result**, **Agent_Failure**, **runId**, **Tenant**: As defined in the authoring-agents spec.
- **State_Machine**: The AWS Step Functions standard workflow that runs the Pipeline_States for one change.
- **Execution**: One Step Functions execution of the State_Machine for one changeId.
- **Worker_API**: The internal API on the services EC2 instance through which the State_Machine calls each Pipeline_State's worker.
- **Worker_Call_Id**: A unique identifier the State_Machine assigns to one worker call and reuses on every retry of that call.
- **Review_UI**: The review UI and API defined in the review-ui-approvals spec.
- **Pipeline_State**: One of the nine steps of the State_Machine, in this fixed order: Intake, Draft, Logic_Checks, Content_Approval, Compile, Build_Test, History_Check, Deploy_Approval, Deploy.
- **Optional_State**: History_Check, enabled or disabled in the Pipeline_Configuration.
- **Pipeline_Configuration**: The settings the Pipeline_Orchestrator reads at Execution start: the Optional_State switches, a Retry_Limit per Pipeline_State, the Rebuild_Limit, and the Deploy_Retry_Limit.
- **Retry_Limit**: The maximum number of automatic attempts of one worker call in one Pipeline_State.
- **Rebuild_Limit**: The maximum number of automatic Tooling_Retries for one approved snapshotHash.
- **Deploy_Retry_Limit**: The maximum number of automatic deploy or redeploy attempts for one Build_Record.
- **Lifecycle_State**: The recorded state of one change: `draft`, `checked`, `content_review`, `content_approved`, `built`, `tested`, `deploy_review`, `deploy_approved`, `deployed`, or `rolledback` (§11).
- **Legal_Transition**: One row of the transition table in Requirement 2.
- **Current snapshotHash**: The snapshotHash recorded in the Changes table as the Snapshot the change is working on.
- **Start_Request**: A request from the Review_UI to begin a change, carrying a Start_Request_Id, the request type (guideline upload, pathway pick, or plain-language edit), the Tenant, and the Author.
- **Revision**: A new Snapshot for an existing changeId with Origin `human_edit` or `change_plan`, whose parent snapshotHash is the change's Current snapshotHash.
- **Approval_Gate**: Content_Approval or Deploy_Approval.
- **Parked_Token**: The Tokens table item for one Step Functions task token parked at one Approval_Gate, holding the changeId, the Approval_Gate, the snapshotHash, the Build_Record identifier for Deploy_Approval, the task token, and a consumed marker.
- **Approval_Decision**: A decision submitted through the Review_UI at one Approval_Gate, holding the changeId, the Approval_Gate, the snapshotHash, the Build_Record identifier for Deploy_Approval, `approve` or `reject`, the approver identity, the approver Cognito group, a note, and, for Deploy_Approval, one acknowledgment per History_Flag.
- **Decision_Recorder**: The State_Machine step, running under its own IAM role, that writes every Decision_Log entry.
- **Open ambiguity Flag**: A Flag of type `ambiguity` that appears in the Flags listing of the Check_Report for the change's Current snapshotHash.
- **Escalation**: A record, visible in the Review_UI, that stops a change at one Pipeline_State and holds the changeId, the Pipeline_State, the runId, the error text, the attempt count, and the allowed Escalation_Resolutions.
- **Escalation_Resolution**: A human choice that ends an Escalation: `retry_state`, `submit_revision`, `logic_change`, or `tooling_retry`.
- **Build_Record**: The build-test-sandbox's record of one build and synthetic-patient test of one snapshotHash, including the test report and the result.
- **Build_Failure_Category**: The failure class reported by the cht-config-compiler or the build-test-sandbox: `infrastructure` (the tooling or host failed with the logic unchanged) or `build_or_test` (the compile, the `cht-conf` build, or a synthetic-patient test failed).
- **Tooling_Retry**: A rebuild of the same approved snapshotHash, starting again at Compile, under the existing content approval.
- **Logic_Change**: The Escalation_Resolution that returns a change to `draft` so that a Revision with a new snapshotHash goes through content approval again.
- **History_Flag**: One advisory flag produced by History_Check, with an identifier.
- **Rollback_Request**: A request from the Review_UI naming a change in `deployed` and a target snapshotHash to redeploy.
- **Changes table**, **Approvals table**, **Audit table**, **Tokens table**: The DynamoDB tables listed in §14, each with partition key `changeId`.
- **Approved snapshotHash**: The snapshotHash named in the change's recorded `approve` entry at Content_Approval.
- **Worker_Call_Timeout**: The longest time the State_Machine waits for one worker call attempt to return a result: 900 seconds.
- **Transient_Error**: A worker call outcome in which the Worker_API cannot be reached, the worker process stops before returning a result, or the worker returns an error it marks as retryable. Failures reported with a Build_Failure_Category or by the cht-deployer are not Transient_Errors.
- **History_Check_Failure_Notice**: The record stored on a change when History_Check returns an Agent_Failure, holding the error and the runId, and shown at Deploy_Approval in place of History_Flags (Requirement 10.3).
- **Decision_Log prefix**: The Artifact_Bucket prefix that holds one object per Decision_Log entry.

## Requirements

### Requirement 1: Fixed pipeline order

**User Story:** As a national IT lead, I want every change to run through one fixed sequence of states, so that no agent or person can skip a check or an approval.

#### Acceptance Criteria

1. THE State_Machine SHALL be an AWS Step Functions standard workflow.
2. WHEN the Review_UI submits a Start_Request that passes the checks in criterion 11 and whose Start_Request_Id no Changes table item records, THE Pipeline_Orchestrator SHALL create a changeId that no other Changes table item holds and a new runId, and write one Changes table item for the changeId that records the Start_Request_Id, the request type, the Tenant, and the Author in Lifecycle_State `draft`.
3. WHEN the Pipeline_Orchestrator has written the Changes table item for a new changeId, THE Pipeline_Orchestrator SHALL start exactly one Execution whose input holds the changeId, the runId, the Tenant, the Author, and the request type, and return the changeId to the Review_UI.
4. IF a Start_Request carries the same Start_Request_Id, request type, Tenant, and Author as an earlier or concurrent Start_Request, THEN THE Pipeline_Orchestrator SHALL return the one changeId recorded for that Start_Request_Id, create no second changeId, and start an Execution for that changeId only if no Execution has yet started for it.
5. THE State_Machine SHALL begin every Execution at Intake and run the Pipeline_States in the order Intake, Draft, Logic_Checks, Content_Approval, Compile, Build_Test, History_Check, Deploy_Approval, Deploy, skipping no Pipeline_State other than an Optional_State disabled in the Pipeline_Configuration and returning to an earlier Pipeline_State only through the loops defined in Requirements 7, 8, and 9.
6. THE State_Machine SHALL choose each next Pipeline_State only from the State_Machine definition, the Pipeline_Configuration read at Execution start, and the outcome reported for the current Pipeline_State, without reading a next-state name or instruction from any Agent_Result.
7. WHEN the State_Machine enters a Pipeline_State other than an Approval_Gate, THE State_Machine SHALL call that Pipeline_State's worker only through the Worker_API, assigning the call a Worker_Call_Id that no earlier worker call holds.
8. WHEN the State_Machine enters Draft for a change whose Start_Request type is plain-language edit, THE State_Machine SHALL invoke the Change Planner Agent, pass the resulting ChangePlan to the Change_Plan_Applier, and invoke no Drafting agent for that Draft run.
9. WHERE the Pipeline_Configuration read at Execution start sets History_Check to disabled, THE State_Machine SHALL pass from Build_Test directly to Deploy_Approval without calling the History_Check worker.
10. THE Pipeline_Orchestrator SHALL permit starting an Execution of the State_Machine and resuming a parked task token only for calls made under the Review_UI service identity, denying both operations to every agent role, worker role, and other identity.
11. IF a Start_Request has a missing or empty Tenant or Author, a Start_Request_Id that is missing, empty, or longer than 128 characters, or a request type other than guideline upload, pathway pick, or plain-language edit, THEN THE Pipeline_Orchestrator SHALL refuse the Start_Request with an error naming each missing or invalid field, write no Changes table item, and start no Execution.
12. IF the Execution for a new changeId fails to start, THEN THE Pipeline_Orchestrator SHALL return to the Review_UI the changeId and an error indicating that the change did not start, keeping the Changes table item in Lifecycle_State `draft` so that a repeat of the same Start_Request starts the Execution under criterion 4.
13. IF a Start_Request carries a Start_Request_Id already recorded in a Changes table item but names a request type, Tenant, or Author that differs from the values recorded in that item, THEN THE Pipeline_Orchestrator SHALL refuse the Start_Request with an error indicating the conflict, return no changeId, and start no Execution.

### Requirement 2: Change lifecycle and legal transitions

**User Story:** As a clinician, I want each change to move only through the lifecycle states in the design, so that a change cannot reach build or deploy without passing every gate.

#### Transition table

| # | From | To | Trigger |
|---|---|---|---|
| T1 | (none) | `draft` | Start_Request accepted |
| T2 | `draft` | `checked` | Logic_Checker Overall result `pass` for the Current snapshotHash |
| T3 | `checked` | `content_review` | Content_Approval Parked_Token written |
| T4 | `content_review` | `content_approved` | `approve` decision recorded for the Current snapshotHash with no Open ambiguity Flag |
| T5 | `content_review` | `draft` | `reject` decision recorded at Content_Approval |
| T6 | `content_approved` | `built` | Successful `cht-conf` build reported for the approved snapshotHash |
| T7 | `built` | `tested` | Every synthetic-patient test in the Build_Record passed |
| T8 | `built` | `content_approved` | Tooling_Retry accepted for the same snapshotHash |
| T9 | `content_approved` | `draft` | Logic_Change resolution recorded |
| T10 | `built` | `draft` | Logic_Change resolution recorded |
| T11 | `tested` | `deploy_review` | Deploy_Approval Parked_Token written for a `release` Snapshot |
| T12 | `deploy_review` | `deploy_approved` | `approve` decision recorded for the snapshotHash and Build_Record |
| T13 | `deploy_review` | `draft` | `reject` decision recorded at Deploy_Approval |
| T14 | `deploy_approved` | `deployed` | cht-deployer reports upload and verification succeeded |
| T15 | `deployed` | `rolledback` | cht-deployer reports the Rollback_Request target redeployed and verified |

#### Acceptance Criteria

1. THE Pipeline_Orchestrator SHALL hold in the Changes table exactly one Lifecycle_State per changeId, taken from the ten values defined for Lifecycle_State.
2. THE Pipeline_Orchestrator SHALL change a change's Lifecycle_State only by applying a Legal_Transition whose from-state equals the recorded Lifecycle_State and whose trigger, as stated in the transition table, has occurred for that changeId.
3. IF a Pipeline_State outcome, an Approval_Decision, an Escalation_Resolution, or a Rollback_Request requests a transition that is absent from the transition table, whose from-state differs from the recorded Lifecycle_State, or whose changeId has no Changes table item, THEN THE Pipeline_Orchestrator SHALL refuse the transition, keep the recorded Lifecycle_State and Current snapshotHash unchanged, return an error indicating the refused transition to the requesting component, and record the refusal in the Audit table with the changeId, the recorded Lifecycle_State, the requested to-state, the trigger, and the UTC time.
4. THE Pipeline_Orchestrator SHALL write each transition to the Changes table only if the Changes table still records the transition's from-state at the moment of the write, so that when two transitions from the same from-state are requested for one changeId, exactly one is applied and the other is refused under criterion 3.
5. WHEN the Pipeline_Orchestrator applies a transition, THE Decision_Recorder SHALL append exactly one Audit table entry, before the Pipeline_Orchestrator applies any later transition to the same changeId, holding the transition number (T1 to T15), the changeId, the from-state, the to-state, the Current snapshotHash or an empty value when no Snapshot is yet recorded, the target snapshotHash for T15, the Execution identifier, the trigger, and the UTC time to the millisecond.
6. WHEN the Draft state stores a Snapshot, or a Revision is stored for a change in `draft`, THE Pipeline_Orchestrator SHALL record that Snapshot's snapshotHash as the change's Current snapshotHash before the State_Machine enters the next Pipeline_State.
7. IF a Revision is submitted for a change whose Lifecycle_State is not `draft`, THEN THE Pipeline_Orchestrator SHALL refuse the Revision, keep the Lifecycle_State and the Current snapshotHash unchanged, and record the refusal in the Audit table.
8. IF the trigger of any transition other than T1 and T15 names a snapshotHash that differs from the change's Current snapshotHash, THEN THE Pipeline_Orchestrator SHALL refuse the transition, keep the recorded Lifecycle_State unchanged, and record the refusal in the Audit table with both snapshotHashes.
9. THE Pipeline_Orchestrator SHALL deny every agent and every Pipeline_State worker write access to the Lifecycle_State and the Current snapshotHash in the Changes table.

### Requirement 3: Logic checks gate and open ambiguities

**User Story:** As a clinician, I want deterministic checks to pass and every ambiguity to be resolved before I can approve, so that I never approve logic with a known gap.

#### Acceptance Criteria

1. WHEN the State_Machine enters Logic_Checks, THE State_Machine SHALL request exactly one Logic_Checker Run on the snapshotHash recorded as the change's Current snapshotHash at the moment of entry, with every retry under Requirement 8.2 reusing that Run's Worker_Call_Id.
2. THE State_Machine SHALL run the same Logic_Checks state, with no skip and no Origin-specific variant, on every Snapshot that becomes the change's Current snapshotHash, including Snapshots with Origin `human_edit` or `change_plan`.
3. WHEN the Logic_Checker returns an Overall result of `pass` for the snapshotHash that is still the change's Current snapshotHash, THE Pipeline_Orchestrator SHALL store the Check_Report location together with that snapshotHash in the change's Changes table item and then apply transition T2.
4. WHEN the Logic_Checker returns an Overall result of `fail` for the snapshotHash that is still the change's Current snapshotHash, THE Pipeline_Orchestrator SHALL store the Check_Report location together with that snapshotHash in the change's Changes table item, keep the change in `draft` without entering Content_Approval, and wait until a Revision is stored.
5. IF an `approve` Approval_Decision arrives at Content_Approval while the change has an Open ambiguity Flag or while the Check_Report at the change's stored Check_Report location cannot be read, THEN THE Pipeline_Orchestrator SHALL refuse the decision with an error to the Review_UI indicating each Open ambiguity Flag or the unreadable Check_Report, add no Approvals table entry, keep the change in `content_review`, park a new task token at Content_Approval, and record the refusal in the Audit table.
6. IF the Logic_Checker returns a result for a snapshotHash that is no longer the change's Current snapshotHash, THEN THE Pipeline_Orchestrator SHALL discard the result, leave the change's Lifecycle_State and stored Check_Report location unchanged, and record the discarded result in the Audit table.
7. IF the Logic_Checker returns a result with no Check_Report location or with an Overall result other than `pass` or `fail`, THEN THE State_Machine SHALL keep the change in `draft`, apply no transition, and raise an Escalation at Logic_Checks without an automatic retry, holding an error that indicates the missing or invalid field and offering the `retry_state` and `submit_revision` resolutions.
8. WHILE the change has an Open ambiguity Flag, WHEN a `reject` Approval_Decision that passes the checks in Requirement 5 arrives at Content_Approval, THE Pipeline_Orchestrator SHALL accept the decision and apply transition T5 as stated in Requirement 7.1.

### Requirement 4: Approval gates with task tokens

**User Story:** As a national IT lead, I want each approval wait to be held by Step Functions, so that a pending approval survives any restart of the services or the UI.

#### Acceptance Criteria

1. WHEN the State_Machine enters an Approval_Gate, THE State_Machine SHALL park one Step Functions task token and write one Parked_Token item to the Tokens table holding the changeId, the Approval_Gate, the Current snapshotHash, the Build_Record identifier stored on the change when the Approval_Gate is Deploy_Approval, the task token, and a consumed marker set to not consumed.
2. THE State_Machine SHALL apply transition T3 or T11 only after the Tokens table has stored the Parked_Token item for that Approval_Gate.
3. WHILE a change waits at an Approval_Gate, WHEN the services EC2 instance, a worker process, or the Review_UI restarts, THE Pipeline_Orchestrator SHALL keep the Execution waiting at that Approval_Gate, the Lifecycle_State unchanged, and the same Parked_Token item unconsumed and resumable by the next Approval_Decision.
4. WHEN an Approval_Decision resumes a Parked_Token, THE Pipeline_Orchestrator SHALL mark that Parked_Token as consumed, so that only one Approval_Decision resumes each Parked_Token even when two Approval_Decisions for it arrive at the same time.
5. IF an Approval_Decision arrives for a Parked_Token already marked consumed, or for a changeId that has no unconsumed Parked_Token item, THEN THE Pipeline_Orchestrator SHALL refuse the decision, resume no task token, add no entry to the Approvals table, and record the refusal in the Audit table.
6. THE Pipeline_Orchestrator SHALL grant read and write access to Tokens table items only to the Review_UI service identity and the State_Machine role.
7. IF writing the Parked_Token item still fails after the Approval_Gate's Retry_Limit, THEN THE State_Machine SHALL keep the change in its current Lifecycle_State, apply neither T3 nor T11, and raise an Escalation holding the write error and the attempt count.
8. THE State_Machine SHALL set no timeout on an Approval_Gate wait shorter than the Step Functions standard workflow maximum Execution duration of one year.
9. IF Step Functions refuses to resume a Parked_Token's task token because the Execution has stopped, failed, or timed out, THEN THE Pipeline_Orchestrator SHALL refuse the Approval_Decision, add no entry to the Approvals table, and raise an Escalation at that Approval_Gate holding the Step Functions error.

### Requirement 5: Approval binding to one exact snapshotHash

**User Story:** As a clinician, I want my approval to apply only to the exact version I reviewed, so that no other version can be built or deployed under my name.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator accepts an Approval_Decision, THE Pipeline_Orchestrator SHALL take the approved snapshotHash, and at Deploy_Approval the approved Build_Record identifier, from the Parked_Token that the decision resumes and not from any session or conversation identifier.
2. IF an Approval_Decision's changeId, Approval_Gate, snapshotHash, or, at Deploy_Approval, Build_Record identifier is absent or is not an exact, case-sensitive, character-for-character match of the corresponding value in the Parked_Token that the decision resumes, THEN THE Pipeline_Orchestrator SHALL refuse the decision.
3. IF an Approval_Decision has an absent or empty approver identity, an absent or empty approver Cognito group, or a decision value other than exactly `approve` or `reject`, THEN THE Pipeline_Orchestrator SHALL refuse the decision.
4. IF an `approve` decision at Content_Approval carries an approver Cognito group other than `clinician` or `program_reviewer`, or an `approve` decision at Deploy_Approval carries an approver Cognito group other than `it_deploy`, THEN THE Pipeline_Orchestrator SHALL refuse the decision.
5. IF the approver identity of an `approve` decision equals the Author recorded on the Snapshot named by the Parked_Token's snapshotHash, or equals the approver identity of any `approve` entry in the Approvals table at the other Approval_Gate for the same changeId, THEN THE Pipeline_Orchestrator SHALL refuse the decision.
6. WHERE History_Check is enabled in the Pipeline_Configuration, IF an `approve` decision at Deploy_Approval lacks an acknowledgment naming the identifier of each History_Flag stored on the change, or carries an acknowledgment naming an identifier that matches no History_Flag stored on the change, THEN THE Pipeline_Orchestrator SHALL refuse the decision.
7. THE Pipeline_Orchestrator SHALL treat a recorded `approve` entry as satisfying an approval check only for the exact snapshotHash named in that entry and, for a Deploy_Approval entry, only for the exact Build_Record identifier named in that entry, and never for a Revision, a recomputed snapshotHash, or another Build_Record of the same changeId.
8. IF the Pipeline_Orchestrator refuses an Approval_Decision under any of criteria 2 to 6, THEN THE Decision_Recorder SHALL write no Approvals table entry and append one Audit table entry holding the Parked_Token's changeId and Approval_Gate, the snapshotHash and Build_Record identifier carried by the decision, the approver identity, every check in criteria 2 to 6 that the decision failed, and the time.
9. IF the Pipeline_Orchestrator refuses an Approval_Decision under any of criteria 2 to 6, THEN THE State_Machine SHALL keep the change's Lifecycle_State unchanged and park a new task token at the same Approval_Gate, with a Parked_Token holding the same changeId, snapshotHash, and Build_Record identifier as the Parked_Token that the refused decision resumed.

### Requirement 6: Decision_Log recording

**User Story:** As an auditor, I want every human decision written once to an append-only log by the orchestrator, so that the record is complete and no agent can alter it.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator accepts an Approval_Decision that has passed every check in Requirements 3, 4, and 5, THE Decision_Recorder SHALL append exactly one Approvals table entry and write exactly one object to the Decision_Log prefix of the Artifact_Bucket before the State_Machine applies the resulting transition.
2. THE Decision_Recorder SHALL include in both the Approvals table entry and the Decision_Log prefix object for each accepted Approval_Decision every field of the Approval_Decision with its submitted value unchanged, the Execution identifier, and the acceptance time in UTC with millisecond precision.
3. WHEN the Pipeline_Orchestrator accepts an Escalation_Resolution or a Rollback_Request, THE Decision_Recorder SHALL append one Audit table entry and write one Decision_Log prefix object, each holding the changeId, the Escalation_Resolution value or the Rollback_Request target snapshotHash, the submitter identity and Cognito group, the Execution identifier, and the acceptance time in UTC, before the State_Machine applies any transition or calls any worker for that decision.
4. THE Decision_Recorder SHALL write each Decision_Log entry only under a key that holds no existing entry, leaving every existing entry in the Approvals table, the Audit table, and the Decision_Log prefix unchanged.
5. THE Pipeline_Orchestrator SHALL grant permission to add entries to the Approvals table, the Audit table, and the Decision_Log prefix only to the Decision_Recorder role, and permission to update or delete those entries to no role.
6. IF a Decision_Log write still fails after the number of attempts set as the Decision_Recorder's Retry_Limit in the Pipeline_Configuration, THEN THE State_Machine SHALL keep the change in its current Lifecycle_State, call no worker for the decision, and raise an Escalation that holds the write error text, the attempt count, and `retry_state` as an allowed Escalation_Resolution.
7. IF the Decision_Recorder makes more than one attempt to record the same decision, THEN THE Decision_Recorder SHALL leave at most one entry for that decision in each of the Approvals table, the Audit table, and the Decision_Log prefix.
8. WHEN the Pipeline_Orchestrator refuses an Approval_Decision, an Escalation_Resolution, or a Rollback_Request, THE Decision_Recorder SHALL append one Audit table entry holding the changeId, every submitted field of the refused submission, a refusal reason naming the check that failed, and the refusal time in UTC, and add no Approvals table entry.

### Requirement 7: Reject loop and Revisions

**User Story:** As a program officer, I want a rejection or an edit to produce a new version that goes back through the checks, so that hand edits and AI drafts get the same scrutiny and nothing is re-guessed by the AI.

#### Acceptance Criteria

1. WHEN the Decision_Recorder records a `reject` decision at Content_Approval, THE Pipeline_Orchestrator SHALL apply transition T5, keep the Current snapshotHash unchanged, and start no further Pipeline_State for the change until the Pipeline_Orchestrator accepts a Revision.
2. WHEN the Decision_Recorder records a `reject` decision at Deploy_Approval, THE Pipeline_Orchestrator SHALL apply transition T13, keep the Current snapshotHash unchanged, and start no further Pipeline_State for the change until the Pipeline_Orchestrator accepts a Revision.
3. WHEN a plain-language edit request that criterion 6 does not refuse arrives for a change in `draft`, THE Pipeline_Orchestrator SHALL invoke the Change Planner Agent with the edit text and the change's Current snapshotHash, and pass the resulting ChangePlan to the Change_Plan_Applier to produce a Revision whose parent snapshotHash is the Current snapshotHash.
4. WHEN the Pipeline_Orchestrator accepts a Revision that neither criterion 5 nor criterion 6 refuses, THE State_Machine SHALL run Logic_Checks on the Revision's snapshotHash as the next Pipeline_State, without re-running Intake or Draft and without invoking the Drafting agent.
5. IF a Revision's changeId differs from the changeId of the change it is submitted for, the Revision's parent snapshotHash differs from the change's Current snapshotHash at the moment the Pipeline_Orchestrator records the Revision, the Revision's snapshotHash equals the Current snapshotHash, or the Revision's Origin is neither `human_edit` nor `change_plan`, THEN THE Pipeline_Orchestrator SHALL refuse the Revision, keep the Lifecycle_State and the Current snapshotHash unchanged, return the refusal reason to the Review_UI, and record the refusal in the Audit table.
6. IF a Revision or a plain-language edit request names a changeId with no Changes table item, names a change whose Lifecycle_State is not `draft`, or arrives while a worker call for the change, including its retries, has not yet returned, THEN THE Pipeline_Orchestrator SHALL refuse it without invoking any agent, keep the Lifecycle_State and the Current snapshotHash unchanged, return the refusal reason to the Review_UI, and record the refusal in the Audit table.
7. IF the Change Planner Agent returns an Agent_Failure for a plain-language edit request, or the Change_Plan_Applier reports that the ChangePlan cannot be applied to the Snapshot of the Current snapshotHash, THEN THE Pipeline_Orchestrator SHALL keep the change in `draft` with the Current snapshotHash unchanged, make no automatic retry of the Change Planner Agent, and raise an Escalation holding the error text.

### Requirement 8: Agent failures, bounded retries, and escalation

**User Story:** As a national IT lead, I want every failure to stop after a fixed number of attempts and reach a person with the error, so that the pipeline never loops freely or guesses.

#### Acceptance Criteria

1. IF a worker returns an Agent_Failure at any Pipeline_State other than History_Check, THEN THE State_Machine SHALL make no automatic retry, keep the change at the current Pipeline_State with its Lifecycle_State unchanged, and raise an Escalation holding the changeId, the Pipeline_State, the runId, the Agent_Failure error text, and the attempt count.
2. IF a worker call attempt returns no result within the Worker_Call_Timeout or ends in a Transient_Error, THEN THE State_Machine SHALL make a further attempt with the same Worker_Call_Id until an attempt ends without a timeout or Transient_Error or the number of attempts, counting the first, reaches the Pipeline_State's Retry_Limit read at Execution start.
3. IF the attempt that reaches the Pipeline_State's Retry_Limit also times out or ends in a Transient_Error, THEN THE State_Machine SHALL keep the change at the current Pipeline_State with its Lifecycle_State unchanged and raise an Escalation holding the changeId, the Pipeline_State, the runId, the last error text, and the attempt count.
4. IF the Pipeline_Configuration read at Execution start lacks a Retry_Limit for the Decision_Recorder or for any enabled Pipeline_State other than an Approval_Gate, lacks the Rebuild_Limit or the Deploy_Retry_Limit, or holds any of these limits as a value other than an integer from 1 to 10, THEN THE Pipeline_Orchestrator SHALL refuse to start the Execution and return an error to the Review_UI naming each invalid setting.
5. WHILE an Escalation is open, THE State_Machine SHALL keep the change at the escalated Pipeline_State with its Lifecycle_State unchanged and make no worker call for the change, across restarts of the services EC2 instance, the worker processes, and the Review_UI, until the Decision_Recorder records an Escalation_Resolution for that Escalation.
6. WHEN the Decision_Recorder records a `retry_state` resolution, THE State_Machine SHALL re-run the escalated Pipeline_State with a new Worker_Call_Id and an attempt count starting again at 1, bounded by that Pipeline_State's Retry_Limit.
7. WHEN the Decision_Recorder records a `submit_revision` resolution naming a stored Revision that passes the checks in Requirement 7.5, THE State_Machine SHALL run Logic_Checks on the Revision's snapshotHash as the next Pipeline_State without re-running Intake or Draft.
8. IF a worker call attempt ends in an error that is not an Agent_Failure, not a Transient_Error, and not a failure reported with a Build_Failure_Category or by the cht-deployer, THEN THE State_Machine SHALL make no automatic retry, keep the change at the current Pipeline_State with its Lifecycle_State unchanged, and raise an Escalation holding the changeId, the Pipeline_State, the runId, the error text, and the attempt count.
9. WHEN the State_Machine raises an Escalation under criterion 1, 3, or 8, THE State_Machine SHALL list `retry_state` as an allowed Escalation_Resolution and list `submit_revision` only if the change is in `draft` and has a Current snapshotHash.
10. IF an Escalation_Resolution is not among the Escalation's allowed Escalation_Resolutions, targets an Escalation whose Escalation_Resolution is already recorded, or is a `submit_revision` that names no stored Revision passing the checks in Requirement 7.5, THEN THE Pipeline_Orchestrator SHALL refuse the resolution, leave the Escalation and the change unchanged, and record the refusal in the Audit table.

### Requirement 9: Compile, build, test, and the build-failure split

**User Story:** As a clinician, I want a tooling retry to reuse my approval only when nothing hashed has changed, so that I am not asked again for an infrastructure fault but always re-approve a change in meaning.

#### Acceptance Criteria

1. IF, at any entry to Compile including the entry for a Tooling_Retry, the Decision_Log holds no `approve` entry at Content_Approval whose snapshotHash equals the change's Current snapshotHash, or the change's Lifecycle_State is not `content_approved`, THEN THE State_Machine SHALL refuse to enter Compile, keep the change's Lifecycle_State, and raise an Escalation.
2. WHEN the State_Machine enters Compile, THE State_Machine SHALL request the cht-config-compiler to compile only the Snapshot whose snapshotHash equals the Approved snapshotHash, read through the Snapshot_Service with an Integrity check.
3. IF the Snapshot_Service reports an Integrity check failure for the Approved snapshotHash, THEN THE State_Machine SHALL send no compile request, start no automatic Tooling_Retry, keep the change's Lifecycle_State, and raise an Escalation holding the Integrity check error.
4. WHEN the build-test-sandbox reports a successful `cht-conf` build whose snapshotHash equals the Approved snapshotHash, THE Pipeline_Orchestrator SHALL apply transition T6.
5. WHEN the build-test-sandbox returns a Build_Record for the Approved snapshotHash whose test report lists at least one synthetic-patient test and shows every listed test as passed, THE Pipeline_Orchestrator SHALL store the Build_Record identifier on the change and apply transition T7.
6. IF Compile or Build_Test fails with Build_Failure_Category `infrastructure` and the number of automatic Tooling_Retries already run for the Approved snapshotHash is less than the Rebuild_Limit, THEN THE State_Machine SHALL start one automatic Tooling_Retry of that snapshotHash and count it toward a per-snapshotHash total that is never reset and that excludes Tooling_Retries started by a `tooling_retry` resolution.
7. IF Compile or Build_Test fails with Build_Failure_Category `build_or_test`, with a missing or unrecognized Build_Failure_Category, or with Build_Failure_Category `infrastructure` when the number of automatic Tooling_Retries already run for the Approved snapshotHash equals the Rebuild_Limit, THEN THE State_Machine SHALL keep the change's Lifecycle_State, start no automatic Tooling_Retry, and raise an Escalation that holds the failing Pipeline_State, the Build_Failure_Category, and the automatic Tooling_Retry count and that offers only the `logic_change` and `tooling_retry` resolutions.
8. WHEN an automatic Tooling_Retry starts or the Decision_Recorder records a `tooling_retry` resolution, THE Pipeline_Orchestrator SHALL recompute the snapshotHash through the Hash_Calculator from the current Hash_Inputs of the approved Snapshot, including the Toolchain_Identity that the cht-config-compiler and the build-test-sandbox would use for the retry, before the State_Machine re-enters Compile.
9. IF the recomputed snapshotHash differs from the Approved snapshotHash, THEN THE Pipeline_Orchestrator SHALL refuse the Tooling_Retry, start no Compile, keep the change's Lifecycle_State, record the refusal in the Audit table, and raise an Escalation that offers only the `logic_change` resolution.
10. WHEN the Decision_Recorder records a `logic_change` resolution, THE Pipeline_Orchestrator SHALL apply transition T9 to a change in `content_approved` or transition T10 to a change in `built` and then wait for a Revision.
11. WHEN the recomputed snapshotHash equals the Approved snapshotHash, THE State_Machine SHALL re-enter Compile for the Approved snapshotHash with a new Worker_Call_Id under the existing content approval and without parking a new Content_Approval task token.
12. WHEN the Pipeline_Orchestrator accepts a Tooling_Retry for a change in `built`, THE Pipeline_Orchestrator SHALL apply transition T8 before the State_Machine re-enters Compile.
13. IF the cht-config-compiler or the build-test-sandbox reports a result for a snapshotHash other than the Approved snapshotHash, or the build-test-sandbox returns a Build_Record that lists no synthetic-patient test, THEN THE Pipeline_Orchestrator SHALL refuse the result, apply no transition, record the refusal in the Audit table, and raise an Escalation.

### Requirement 10: History check and release-only deploy

**User Story:** As a national IT lead, I want advisory history flags in front of me and preview builds kept out of deployment, so that I approve with full context and only release Snapshots reach the CHT instance.

#### Acceptance Criteria

1. WHERE History_Check is enabled, WHEN the Pipeline_Orchestrator applies transition T7, THE State_Machine SHALL run History_Check for the change's Current snapshotHash and stored Build_Record identifier and store each resulting History_Flag with its identifier on the change, replacing any History_Flags stored for an earlier Build_Record of the same change.
2. WHERE History_Check is enabled, WHEN History_Check returns its History_Flags, THE State_Machine SHALL proceed to Deploy_Approval for any count of History_Flags, including zero, without waiting for any human action before entering Deploy_Approval.
3. WHERE History_Check is enabled, IF History_Check returns an Agent_Failure, THEN THE State_Machine SHALL store on the change a History_Check_Failure_Notice holding the Agent_Failure error and the runId, store zero History_Flags for the change, and proceed to Deploy_Approval without raising an Escalation, taking precedence over Requirement 8.1.
4. IF the State_Machine is about to enter Deploy_Approval or Deploy and the Snapshot_Service returns Designation `preview` for the change's Current snapshotHash, THEN THE Pipeline_Orchestrator SHALL refuse to enter Deploy_Approval or Deploy, refuse transitions T11, T12, and T14, park no Deploy_Approval task token, send no request to the cht-deployer, keep the change in its current Lifecycle_State, and record the refusal in the Audit table.
5. WHEN the Decision_Recorder records an `approve` decision at Deploy_Approval, THE State_Machine SHALL apply transition T12 and then request the cht-deployer to deploy the Build_Record named in the Parked_Token, passing the Approved snapshotHash and the identifier of the Approvals table entry for that decision.
6. WHEN the cht-deployer reports that both the upload and the verification succeeded for the Build_Record named in the deploy approval, THE Pipeline_Orchestrator SHALL apply transition T14.
7. IF the cht-deployer reports that the upload or the verification failed, THEN THE State_Machine SHALL keep the change in `deploy_approved` and repeat the deploy request for the same Build_Record under the same Approvals table entry, without a new Approval_Decision, until the total number of deploy attempts for that Build_Record, counting the first attempt, equals the Deploy_Retry_Limit.
8. IF the deploy attempt whose count equals the Deploy_Retry_Limit fails, THEN THE State_Machine SHALL keep the change in `deploy_approved` and raise an Escalation holding the last cht-deployer error, the attempt count, and `retry_state` as the only allowed Escalation_Resolution.
9. IF the State_Machine is about to enter Deploy_Approval or Deploy and the Snapshot_Service reports an Integrity check failure or returns no Designation for the change's Current snapshotHash, THEN THE State_Machine SHALL keep the change in its current Lifecycle_State without entering Deploy_Approval or Deploy and raise an Escalation holding the Snapshot_Service error.
10. IF the cht-deployer refuses a deploy request because the Snapshot is not a `release` Snapshot, THEN THE State_Machine SHALL make no further deploy attempt for that Build_Record, keep the change in `deploy_approved`, record the refusal in the Audit table, and raise an Escalation holding the cht-deployer's refusal.

### Requirement 11: Rollback

**User Story:** As a national IT lead, I want to redeploy a prior tested, approved Snapshot, so that any deployed change can be reversed.

#### Acceptance Criteria

1. WHEN a Rollback_Request passes the checks in criteria 2, 3, 7, and 8, THE Decision_Recorder SHALL append one Decision_Log entry holding every field of the Rollback_Request, including the changeId and the target snapshotHash, and the time of recording before the State_Machine sends any redeploy request to the cht-deployer.
2. IF the changeId named in a Rollback_Request has no Changes table item or has a Lifecycle_State other than `deployed`, THEN THE Pipeline_Orchestrator SHALL refuse the Rollback_Request, leave any recorded Lifecycle_State unchanged, start no redeploy, and record the refusal in the Audit table.
3. IF the Snapshot_Service returns no Snapshot that passes the Integrity check for the target snapshotHash, the target Snapshot has Designation `preview`, the target Snapshot's Tenant differs from the Tenant of the named change, or the target snapshotHash equals the named change's Current snapshotHash, THEN THE Pipeline_Orchestrator SHALL refuse the Rollback_Request, leave the named change in `deployed`, start no redeploy, and record the refusal with the failed condition in the Audit table.
4. WHEN the Decision_Recorder records a Rollback_Request under criterion 1, THE State_Machine SHALL request the cht-deployer to redeploy the Build_Record named in the most recent `approve` entry at Deploy_Approval for the target snapshotHash, passing the identifier of that Rollback_Request's Decision_Log entry.
5. WHEN the cht-deployer reports that the redeploy of the Build_Record requested under criterion 4 was uploaded and verified, THE Pipeline_Orchestrator SHALL apply transition T15 to the change named in the Rollback_Request and record the target snapshotHash and the redeployed Build_Record identifier in the Audit table entry for T15.
6. IF the cht-deployer reports a failure for the redeploy attempt whose attempt number equals the Deploy_Retry_Limit, THEN THE State_Machine SHALL keep the named change in `deployed` and raise an Escalation holding the last cht-deployer error, the attempt count, and `retry_state` as the only allowed Escalation_Resolution.
7. IF the Decision_Log holds no `approve` entry at Content_Approval for the target snapshotHash under any changeId, holds no `approve` entry at Deploy_Approval for the target snapshotHash under any changeId, or the Build_Record named in the most recent `approve` entry at Deploy_Approval for the target snapshotHash does not record that every synthetic-patient test passed, THEN THE Pipeline_Orchestrator SHALL refuse the Rollback_Request, leave the named change in `deployed`, start no redeploy, and record the refusal with the failed condition in the Audit table.
8. WHILE a Rollback_Request recorded under criterion 1 for a changeId has not led to transition T15, IF another Rollback_Request names the same changeId, THEN THE Pipeline_Orchestrator SHALL refuse the later Rollback_Request, start no second redeploy, and record the refusal in the Audit table.
9. IF the cht-deployer reports a failure for a redeploy attempt whose attempt number is below the Deploy_Retry_Limit, THEN THE State_Machine SHALL send another redeploy request for the same Build_Record while keeping the named change in `deployed`.

### Requirement 12: Restart resilience, execution history, and run tagging

**User Story:** As a national IT lead, I want interrupted work to resume safely and each change's history and cost to be traceable, so that I can show one change from request to deploy and attribute its cost.

#### Acceptance Criteria

1. IF a worker call ends without a result because a worker process or the services EC2 instance restarted during the call, THEN THE State_Machine SHALL retry the interrupted call with the same Worker_Call_Id, count the interrupted call as one attempt toward the Pipeline_State's Retry_Limit, and leave the change's Lifecycle_State unchanged.
2. WHEN the Worker_API receives a call whose Worker_Call_Id, changeId, and Pipeline_State match an earlier call that already returned a result or an Agent_Failure, THE Worker_API SHALL return that stored result or Agent_Failure without repeating any Agent_Request, Snapshot store, Logic_Checker Run, compile, build, or deploy for that Worker_Call_Id.
3. WHEN the Review_UI requests the history of a changeId that has a Changes table item, THE Pipeline_Orchestrator SHALL return every Audit table entry, every Approvals table entry, every other Decision_Log entry, every Execution identifier, and every snapshotHash recorded for that changeId, each with its recorded time, in ascending order of recorded time and with no entry recorded for any other changeId.
4. THE Pipeline_Orchestrator SHALL give each Execution a name that contains both the changeId and the runId held in that Execution's input.
5. THE Pipeline_Orchestrator SHALL include in every Agent_Request and every worker call the changeId, the runId, and the Tenant exactly as held in the Execution's input.
6. THE Pipeline_Orchestrator SHALL write the Tenant and the runId into every worker log entry, and the agent name into every worker log entry written during a worker call that runs an agent.
7. IF the Worker_API receives a call whose Worker_Call_Id matches an earlier call but whose changeId or Pipeline_State differs from that earlier call's, THEN THE Worker_API SHALL refuse the call with an error indicating a Worker_Call_Id conflict, run no work, and return no stored result.
8. IF the Worker_API receives a call that lacks the Worker_Call_Id, the changeId, the runId, or the Tenant, THEN THE Worker_API SHALL refuse the call with an error naming each missing value and run no work.
9. IF the Review_UI requests the history of a changeId that has no Changes table item, THEN THE Pipeline_Orchestrator SHALL return an error indicating that the changeId is unknown and return no history entries.

## Open Questions

1. **Compiler fixes and approvals.** Toolchain_Identity is part of Hash_Inputs, so a compiler bug fix changes the snapshotHash and forces a new content approval. Only host or infrastructure faults can reuse an approval (Requirement 9.8–9.9). Is that the intended scope of Decisions Log #7?
2. **Ambiguity gate.** §11 says `content_review` "cannot be exited" while an ambiguity is open, but its diagram routes rejection back to `draft`. This spec blocks approval only (3.5) and allows rejection. Is a Flag resolved only by a Revision that removes it?
3. **Deploy rejection target.** This spec returns a deploy rejection to `draft` (T13). Should it return to `tested` for re-review instead?
4. **Rollback approval.** Does a rollback need a fresh deploy approval under rule 2, or is a recorded Rollback_Request from an `it_deploy` user enough?
5. **Terminal state.** §11 has no state for an abandoned or permanently failed change. Should an `abandoned` state be added?
6. **Storage layout.** §14 lists no Decision_Log prefix in the Artifact_Bucket, and the Changes table is shared with the logic-model-snapshots Index_Table. platform-infrastructure needs to fix both layouts.
7. **Worker call timeout.** Requirement 8.2 sets the Worker_Call_Timeout to 900 seconds, which the design does not specify. The `cht-conf` build and synthetic-patient run may need longer. Confirm the value per Pipeline_State.
8. **Approvals across changes for rollback.** Requirement 11.7 accepts approvals for the target snapshotHash recorded under any changeId, because a rollback target usually belongs to an earlier change. Confirm that separation-of-duties checks need not be re-run for a rollback.
