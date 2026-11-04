# Requirements Document

## Introduction

This spec covers the Review_UI of the Vera Solution Design: the authenticated web UI and API on the services EC2 instance through which people start changes, edit logic by hand, approve or reject at the two Approval_Gates, resolve Escalations, request rollbacks, and read a change's history (§4, §5, §6 states 5 and 9, §11). Every call is authorized on the server against the caller's Cognito group. The Pipeline_Orchestrator already enforces approval binding, group checks, and separation of duties. The Review_API repeats those checks at its own boundary as defence in depth, so a request that would fail at the orchestrator is refused before the Review_API forwards it.

The approver's view is rendered from the same Snapshot data the compiler reads (rule 5), and every approval names the exact snapshotHash shown on screen (rule 4). The program officer drafts and clarifies but never approves. A program reviewer approves wording-only edits and refers anything with clinical meaning to a clinician (rule 2). The IT lead acknowledges each History_Flag individually before deploy approval, and the flags stay advisory (§9). The approver view format (decision table or flowchart) is an open item and chat-based approver UX is on the cut list, so the Must-Have is a structured, non-chat view. The Review_UI accepts only synthetic data and public guidelines and never handles CHT credentials (§15).

This spec does not own the State_Machine, the Decision_Log writes (the Decision_Recorder owns those), or the deployer.

Source: Solution Design §3, §4, §5, §6, §9, §11, §14, §15, §19, and §20.

### Dependencies

| Spec | What this spec uses or provides |
|---|---|
| logic-model-snapshots | Uses: Snapshot_Service (store, read with Integrity check), logic model schema validation, Logic_Differ and its Difference, Author, Origin, Designation, parent snapshotHash. |
| authoring-agents | Uses: Agent_Failure error text and runId as shown in Escalations; the Tenant. |
| logic-checks-golden-cases | Uses: Check_Report, Overall result, per-check and golden-case outcomes, Flags listing. |
| pipeline-orchestrator | Provides to the orchestrator: Start_Requests, Approval_Decisions, Revisions, Escalation_Resolutions, Rollback_Requests. Uses: Parked_Token items, Escalations, Lifecycle_State history, History_Check_Failure_Notice, Pipeline_Configuration, refusal reasons. |
| cht-config-compiler | Uses: compiled configuration files for the Config_Diff. |
| build-test-sandbox | Uses: Build_Record, including the synthetic-patient test report and result. |
| cht-deployer | No direct interface; deploys and rollbacks go through the Pipeline_Orchestrator. |
| decision-memory-history-check (Should-Have) | Uses: History_Flags with identifier, severity, text, and the past decision referenced. |
| platform-infrastructure | Provides: the Cognito user pool and the four groups, the optional ALB, the services EC2 instance, Session Manager access, the Review_API IAM role, the Changes, Approvals, Audit, and Tokens tables, and the Artifact_Bucket. |

## Glossary

Terms reused from earlier specs keep the meaning defined there.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **Snapshot**, **snapshotHash**, **Snapshot_Service**, **Integrity check**, **Designation**, **Origin**, **changeId**, **Author**, **Base_Snapshot**, **Flag**, **Logic_Differ**, **Difference**, **Artifact_Bucket**: As defined in the logic-model-snapshots spec.
- **Check_Report**, **Overall result**, **Flags listing**, **golden case**: As defined in the logic-checks-golden-cases spec.
- **Agent_Failure**, **runId**, **Tenant**: As defined in the authoring-agents spec.
- **Pipeline_Orchestrator**, **State_Machine**, **Pipeline_State**, **Pipeline_Configuration**, **History_Check**, **Start_Request**, **Start_Request_Id**, **Revision**, **Approval_Gate**, **Content_Approval**, **Deploy_Approval**, **Parked_Token**, **Approval_Decision**, **Decision_Recorder**, **Decision_Log**, **Decision_Log prefix**, **Lifecycle_State**, **Current snapshotHash**, **Open ambiguity Flag**, **Escalation**, **Escalation_Resolution**, **Build_Record**, **History_Flag**, **History_Check_Failure_Notice**, **Rollback_Request**, **Changes table**, **Approvals table**, **Audit table**, **Tokens table**: As defined in the pipeline-orchestrator spec.
- **Review_UI**: The authenticated review web application defined in this spec, consisting of the screens below and the Review_API.
- **Review_API**: The server-side API of the Review_UI on the services EC2 instance; every check this spec assigns to the Review_API runs on the server.
- **Signed_In_User**: A person whose Cognito token the Review_API has verified.
- **Caller identity**: The `sub` claim of the verified Cognito token.
- **Role_Group**: One of the Cognito groups `program_officer`, `program_reviewer`, `clinician`, or `it_deploy`.
- **Operation_Permission table**: The table in Requirement 1 that maps each Review_API operation to the Role_Groups permitted to call the operation.
- **Pathway_List**: The pathways a program_officer can pick, each naming the pathway and the stored guideline the pathway comes from.
- **Hand_Edit_Screen**: The screen on which a program_officer edits a Snapshot's logic by hand to produce a Revision.
- **Content_Approval_Screen**: The screen on which a clinician or program_reviewer decides at Content_Approval.
- **Deploy_Approval_Screen**: The screen on which an it_deploy user decides at Deploy_Approval.
- **Approval_Screen**: The Content_Approval_Screen or the Deploy_Approval_Screen.
- **Plain_Clinical_View**: The structured, non-chat rendering of a Snapshot's inputs and rules on the Content_Approval_Screen, using input labels and action names in place of identifiers.
- **Display_Text field**: A Snapshot field shown to a health worker as text that no rule condition, action, or follow-up reads, such as an input `label`.
- **Edit_Class**: The classification of a Snapshot at Content_Approval: `wording_only` or `clinical`.
- **Clinician_Referral**: A program_reviewer's record that a `wording_only` Snapshot has clinical meaning and needs a clinician's decision at Content_Approval.
- **Config_Diff**: The line-level difference between the compiled configuration files in a Build_Record and those of the release Snapshot most recently deployed for the same pathway, with every file shown as added when no release has been deployed.
- **Rejected_Match_Flag**: A History_Flag that reports an exact rule-fingerprint match to a previously rejected rule (§9).
- **Rollback_Candidate**: A Snapshot for the same pathway, other than the currently deployed Snapshot, that has Designation `release`, a Build_Record with a passing result, and recorded `approve` entries at both Approval_Gates.
- **Escalation_View**: The screen that lists open Escalations and accepts Escalation_Resolutions.
- **Change_History_View**: The read-only screen showing the full history of one changeId.
- **Free_Text_Field**: Any text a Signed_In_User types into the Review_UI: plain-language edit text, hand-edit text values, decision notes, and resolution notes.
- **Personal_Data_Screen**: The Bedrock Guardrails sensitive-information check that detects personal data and credentials in text.
- **Forwarding timeout**: The 30 seconds the Review_API waits for the Pipeline_Orchestrator to confirm a forwarded request (Requirement 1.11).
- **Screening timeout**: The 10 seconds the Review_API waits for the Personal_Data_Screen to return a result for one Free_Text_Field value (Requirement 11.6).

## Requirements

### Requirement 1: Sign-in, access paths, and server-side authorization

**User Story:** As a Vera operator, I want every Review_UI call authenticated and checked against the caller's Cognito group on the server, so that no role can act outside the authority §4 gives it.

**Operation_Permission table:**

| Operation | Permitted Role_Groups |
|---|---|
| Start_Request (guideline upload, pathway pick, plain-language edit) | `program_officer` |
| Submit a hand edit (Revision) | `program_officer` |
| Approval_Decision at Content_Approval | `clinician`, `program_reviewer` (limited by Requirement 5) |
| Clinician_Referral | `program_reviewer` |
| Approval_Decision at Deploy_Approval | `it_deploy` |
| Escalation_Resolution `retry_state` | `program_officer`, `it_deploy` |
| Escalation_Resolution `submit_revision` | `program_officer` |
| Escalation_Resolution `logic_change` | `clinician`, `it_deploy` |
| Escalation_Resolution `tooling_retry` | `it_deploy` |
| Rollback_Request | `it_deploy` |
| Read changes, Snapshots, Check_Reports, Build_Records, Escalations, and history | all four Role_Groups |

#### Acceptance Criteria

1. IF a request reaches the Review_API without a Cognito token, or with a token that fails signature, issuer, app client, or expiry verification, THEN THE Review_API SHALL reject the request with HTTP 401 without forwarding the request to the Pipeline_Orchestrator.
2. WHEN the Review_API authorizes a request, THE Review_API SHALL take the Caller identity only from the verified token's `sub` claim and the caller's Role_Groups only from the verified token's `cognito:groups` claim, disregarding any user identifier or group name carried in the request body, query parameters, or other headers.
3. IF the requested operation is not listed in the Operation_Permission table, or none of the caller's Role_Groups is permitted for the operation (including a token whose `cognito:groups` claim is absent, empty, or names no Role_Group), THEN THE Review_API SHALL reject the request with HTTP 403 without forwarding the request to the Pipeline_Orchestrator.
4. WHEN the Review_API rejects a request with HTTP 401 or HTTP 403, THE Review_API SHALL write one CloudWatch Logs entry holding the Caller identity (or a marker that no verified identity exists for an HTTP 401), the requested operation, the HTTP status, the reason (the failed verification check for HTTP 401, or the unlisted operation or missing permitted Role_Group for HTTP 403), and the rejection time in UTC, with no token value in the entry.
5. WHERE the ALB is deployed, THE Review_UI SHALL be served through the ALB only over HTTPS, with any plain-HTTP request redirected to HTTPS or refused without returning Review_UI content.
6. WHERE the ALB is not deployed, THE Review_UI SHALL be reachable only through Systems Manager Session Manager port forwarding, with no Review_UI port reachable from the internet.
7. THE Review_UI SHALL operate with the services EC2 instance accepting no inbound SSH or RDP connections and no inbound connections on any port other than the Review_UI serving port.
8. THE Review_API SHALL run under an IAM role that grants read actions and no create, update, or delete action on the Approvals table, the Audit table, and objects under the Decision_Log prefix.
9. IF the Pipeline_Orchestrator refuses a request the Review_API forwarded, THEN THE Review_UI SHALL show the refusal reason the Pipeline_Orchestrator returned, unaltered, on the screen from which the request was submitted, keeping the values the user entered on that screen.
10. WHEN a person opens a Review_UI screen without a Cognito session, or the Review_API rejects a request from the Review_UI with HTTP 401, THE Review_UI SHALL send the person to Cognito sign-in and show no change, Snapshot, Check_Report, Build_Record, Escalation, or history data until sign-in completes.
11. IF the Review_API cannot reach the Pipeline_Orchestrator or receives no response to a forwarded request within 30 seconds, THEN THE Review_UI SHALL show an error indicating that the Pipeline_Orchestrator did not confirm the request, keeping the values the user entered and showing no indication that the request succeeded.

### Requirement 2: Start a change

**User Story:** As a program officer, I want to upload a guideline, pick a pathway, or describe an edit in plain language, so that Vera drafts the change for review.

#### Acceptance Criteria

1. WHEN a program_officer submits a guideline upload that criterion 3 does not reject, THE Review_API SHALL store the file byte-for-byte under the `docs/` prefix of the Artifact_Bucket at a location that no earlier upload uses.
2. WHEN the Review_API has stored a guideline file, THE Review_API SHALL send the Pipeline_Orchestrator a Start_Request of type guideline upload that carries the stored file's Artifact_Bucket location.
3. IF an uploaded guideline file is empty, is larger than 50 MB, or has content that does not start with the PDF file signature regardless of the file name or declared file type, THEN THE Review_API SHALL reject the upload with an error naming the failed condition and stating that only PDF files of at most 50 MB are accepted, store no file, and send no Start_Request.
4. WHEN a program_officer picks a pathway that is in the Pathway_List, THE Review_API SHALL send the Pipeline_Orchestrator a Start_Request of type pathway pick naming the pathway and the stored guideline that the pathway's Pathway_List entry names.
5. WHEN a program_officer submits a plain-language edit that criterion 9 does not reject, THE Review_API SHALL send the Pipeline_Orchestrator a Start_Request of type plain-language edit carrying the edit text unchanged and the selected Base_Snapshot's snapshotHash.
6. THE Review_API SHALL set the Author of every Start_Request to the Caller identity, ignoring any Author value supplied in the request body.
7. WHEN the Review_UI submits a Start_Request, THE Review_UI SHALL carry a Start_Request_Id of 1 to 128 characters that no earlier Start_Request has used for a first submission and that equals the original Start_Request_Id for a repeat of a submission that returned an error or no response within 60 seconds.
8. IF a pathway pick names a pathway that is not in the Pathway_List, THEN THE Review_API SHALL reject the pick with an error stating that the pathway is not available and send no Start_Request.
9. IF a plain-language edit has edit text that is empty, whitespace-only, or longer than 2,000 characters, or names a Base_Snapshot that the Snapshot_Service cannot return with a passing Integrity check, THEN THE Review_API SHALL reject the edit with an error naming each failed condition and send no Start_Request.

### Requirement 3: Resolve flags with a hand edit

**User Story:** As a program officer, I want to resolve flags by editing the logic by hand, so that a person settles each ambiguity and the edit goes through the same checks as an AI draft.

#### Acceptance Criteria

1. WHEN a program_officer opens the Hand_Edit_Screen for a change, THE Review_UI SHALL load the Snapshot for the change's Current snapshotHash through a Snapshot_Service read that includes the Integrity check.
2. WHEN the Hand_Edit_Screen loads a Snapshot, THE Hand_Edit_Screen SHALL show every Open ambiguity Flag on that Snapshot, each with the Flag's text and guideline source, above the editable logic.
3. WHEN a program_officer submits a hand edit, THE Review_API SHALL validate the edited logic against the logic model schema defined in the logic-model-snapshots spec before storing any Snapshot.
4. IF the edited logic fails schema validation, THEN THE Review_API SHALL reject the hand edit without storing a Snapshot or sending a Revision and return every schema error with the error's field path.
5. IF the parent snapshotHash of a submitted hand edit differs from the change's Current snapshotHash at the time of submission, THEN THE Review_API SHALL reject the hand edit without storing a Snapshot or sending a Revision and return an error stating that a newer Snapshot exists and naming the Current snapshotHash.
6. WHEN a hand edit passes both the schema validation in criterion 3 and the parent snapshotHash check in criterion 5, THE Review_API SHALL store the edited logic through the Snapshot_Service as a Snapshot with Origin `human_edit`, the Caller identity as Author, and the Current snapshotHash as parent.
7. WHEN the Snapshot_Service returns the new snapshotHash, THE Review_API SHALL send one Revision to the Pipeline_Orchestrator naming the changeId and the new snapshotHash.
8. IF the Snapshot read for the Hand_Edit_Screen fails the Integrity check, THEN THE Review_UI SHALL show an error stating that the Snapshot failed its Integrity check in place of the editable logic.
9. IF the Snapshot_Service fails to store the edited logic, THEN THE Review_API SHALL reject the hand edit without sending a Revision and return an error stating that the Snapshot was not stored.

### Requirement 4: Content approval screen

**User Story:** As a clinician or program reviewer, I want to see the exact logic, its citations, its flags, and its check results in plain clinical terms, so that I approve exactly what will be compiled.

#### Acceptance Criteria

1. WHEN a Signed_In_User opens the Content_Approval_Screen for a change with an unconsumed Parked_Token at Content_Approval, THE Review_UI SHALL load the Snapshot whose snapshotHash the Parked_Token names (the snapshotHash under review) through the Snapshot_Service read with Integrity check.
2. THE Review_UI SHALL render the Plain_Clinical_View only from the fields of the Snapshot under review, with no model call, producing identical content for every rendering of the same snapshotHash.
3. THE Review_UI SHALL present the Plain_Clinical_View as a structured decision table or flowchart rather than as chat messages or generated prose.
4. THE Plain_Clinical_View SHALL show exactly one entry per rule in the Snapshot under review, in the Snapshot's rule order, giving each condition comparison as input label, comparison operator, and value (or the `otherwise` condition), the action by action name, and the follow-up due-in and open-for days or a statement that the rule has no follow-up.
5. THE Plain_Clinical_View SHALL show beside each rule the rule's guideline citation as section and page, or a no-citation marker where the rule has no citation.
6. THE Content_Approval_Screen SHALL show the snapshotHash under review in full, without truncation, beside the approve and reject controls.
7. THE Content_Approval_Screen SHALL list every Flag in the Snapshot under review and every entry in the Flags listing of the Check_Report for the snapshotHash under review, each with its type, text, and source where one is recorded, or a statement that there are no Flags when both are empty.
8. THE Content_Approval_Screen SHALL show the Overall result of the Check_Report for the snapshotHash under review and the name and outcome of every logic check and every golden case in that Check_Report.
9. WHEN the Snapshot under review has a parent snapshotHash, THE Content_Approval_Screen SHALL show every added, removed, and modified input, rule, and Flag, every pathway or guideline change, and every order change in the Difference that the Logic_Differ produces from the parent Snapshot to the Snapshot under review, with the before and after values of each modification.
10. WHILE one or more Open ambiguity Flags exist for the change, THE Content_Approval_Screen SHALL disable the approve control and identify the open ambiguity Flags as the reason.
11. IF the Snapshot_Service reports an Integrity check failure for, or fails to return, the Snapshot under review or its parent Snapshot, or the Check_Report for the snapshotHash under review cannot be loaded, THEN THE Content_Approval_Screen SHALL disable the approve control and name each item that failed the Integrity check or failed to load.
12. IF a Signed_In_User opens the Content_Approval_Screen for a change that has no unconsumed Parked_Token at Content_Approval, THEN THE Content_Approval_Screen SHALL show the change's Lifecycle_State and a statement that the change is not awaiting content approval in place of the approve and reject controls.
13. WHEN the Snapshot under review has no parent snapshotHash, THE Content_Approval_Screen SHALL state, in place of the Difference, that the Snapshot has no parent Snapshot to compare against.

### Requirement 5: Content approval decision and reviewer scope

**User Story:** As a clinician or program reviewer, I want to approve or reject the exact Snapshot I was shown, with program reviewers limited to wording-only edits, so that every clinical change gets a clinician's decision.

#### Acceptance Criteria

1. WHEN a Signed_In_User submits approve or reject on the Content_Approval_Screen, THE Review_API SHALL build an Approval_Decision holding the changeId, Content_Approval, the snapshotHash shown on the screen, the decision, the Caller identity, the Role_Group (`clinician` if the caller is in the `clinician` group, otherwise `program_reviewer`), and the note.
2. IF an approve at Content_Approval is submitted while an Open ambiguity Flag exists for the change, THEN THE Review_API SHALL reject the submission with an error listing the text and guideline source of each Open ambiguity Flag.
3. WHEN the Review_API serves the Content_Approval_Screen or receives an Approval_Decision or Clinician_Referral at Content_Approval, THE Review_API SHALL compute the Edit_Class from the Snapshot under review, the parent Snapshot read through the Snapshot_Service, and the Approvals table, ignoring any Edit_Class supplied in the request.
4. WHEN the Review_API computes the Edit_Class for a Snapshot under review that has a parent snapshotHash, whose parent Snapshot passes the Integrity check and has an `approve` at Content_Approval recorded in the Approvals table, and whose Logic_Differ Difference from the parent Snapshot changes at least one Display_Text field and no other field, THE Review_API SHALL set the Edit_Class to `wording_only`.
5. IF any condition that criterion 4 sets for `wording_only` does not hold for the Snapshot under review, including when the Snapshot has no parent snapshotHash, THEN THE Review_API SHALL set the Edit_Class to `clinical`.
6. THE Content_Approval_Screen SHALL show the Edit_Class that the Review_API computed for the Snapshot under review beside the snapshotHash under review.
7. IF a caller who is in the `program_reviewer` group and not in the `clinician` group submits an approve or reject at Content_Approval for a Snapshot whose Edit_Class is `clinical`, THEN THE Review_API SHALL reject the submission with HTTP 403 stating that a clinician must decide.
8. WHEN a program_reviewer refers a `wording_only` Snapshot named in the change's unconsumed Parked_Token at Content_Approval to a clinician, THE Review_API SHALL record a Clinician_Referral holding the changeId, the snapshotHash, the Caller identity, and the time of the referral.
9. WHILE a Clinician_Referral exists for the changeId and snapshotHash under review, IF a caller outside the `clinician` group submits an approve or reject at Content_Approval, THEN THE Review_API SHALL reject the submission with HTTP 403 stating that a clinician must decide.
10. WHEN a program_reviewer who is not in the `clinician` group opens the Content_Approval_Screen for a Snapshot whose Edit_Class is `clinical` or that has a Clinician_Referral, THE Review_UI SHALL disable the approve and reject controls and show that a clinician must decide.

### Requirement 6: Deploy approval screen

**User Story:** As an IT lead, I want to see the config diff, the test report, and every history flag, so that I deploy only a build I have reviewed.

#### Acceptance Criteria

1. WHEN an it_deploy user opens the Deploy_Approval_Screen for a change with an unconsumed Parked_Token at Deploy_Approval, THE Review_UI SHALL show the snapshotHash and the Build_Record identifier named in the Parked_Token beside the approve and reject controls.
2. THE Deploy_Approval_Screen SHALL show the Config_Diff for the Build_Record named in the Parked_Token with each compiled configuration file named and each added and removed line marked.
3. THE Deploy_Approval_Screen SHALL show the result of the Build_Record named in the Parked_Token and, for each synthetic-patient test listed in the Build_Record's test report, the test's pass or fail result.
4. THE Deploy_Approval_Screen SHALL list every History_Flag stored on the change with the flag's identifier, severity, text, and the past decision the flag refers to.
5. THE Deploy_Approval_Screen SHALL list every Rejected_Match_Flag before every other History_Flag, each with a marker labelling the flag as high severity.
6. THE Deploy_Approval_Screen SHALL show beside each History_Flag one acknowledgment control that acknowledges only that History_Flag.
7. WHILE at least one History_Flag stored on the change is unacknowledged on the Deploy_Approval_Screen, THE Deploy_Approval_Screen SHALL disable the approve control and keep the reject control enabled.
8. IF a History_Check_Failure_Notice exists for the change, THEN THE Deploy_Approval_Screen SHALL show the notice's error and runId in place of the History_Flags.
9. WHERE History_Check is disabled in the Pipeline_Configuration, THE Deploy_Approval_Screen SHALL state that History_Check did not run for the change.
10. IF an it_deploy user opens the Deploy_Approval_Screen for a change that has no unconsumed Parked_Token at Deploy_Approval, THEN THE Deploy_Approval_Screen SHALL show no approve or reject control and state that no deploy decision is pending for the change.
11. IF the Review_API cannot read the Build_Record named in the Parked_Token, the compiled configuration files needed for the Config_Diff, or the History_Flags stored on the change, THEN THE Deploy_Approval_Screen SHALL disable the approve control and show an error naming each item that could not be read.

### Requirement 7: Deploy approval decision and flag acknowledgments

**User Story:** As an IT lead, I want my deploy decision to carry an acknowledgment of every history flag, so that advisory warnings are seen by a person but never block a release on their own.

#### Acceptance Criteria

1. WHEN an it_deploy user submits approve or reject on the Deploy_Approval_Screen, THE Review_API SHALL build an Approval_Decision holding the changeId, Deploy_Approval, the snapshotHash and Build_Record identifier shown on the screen, the decision, the Caller identity, the Role_Group `it_deploy`, the note, and one acknowledgment for each History_Flag the caller acknowledged.
2. WHEN the Review_API builds an acknowledgment for an Approval_Decision at Deploy_Approval, THE Review_API SHALL record in the acknowledgment the History_Flag identifier, the Caller identity of the submission, and the UTC time, to the second, at which the caller selected that flag's acknowledgment control.
3. IF an approve at Deploy_Approval omits any History_Flag identifier recorded for the Build_Record, names an identifier not recorded for the Build_Record, or names any identifier more than once, THEN THE Review_API SHALL reject the submission without forwarding it to the Pipeline_Orchestrator, with an error listing the missing, unknown, and duplicated identifiers.
4. WHEN an approve at Deploy_Approval acknowledges every History_Flag recorded for the Build_Record exactly once, THE Review_API SHALL forward the approve to the Pipeline_Orchestrator unless criterion 6, 7, 8, or 9 rejects it, whatever the severity of the History_Flags (Rejected_Match_Flags included) and whatever their number, including zero when History_Check is disabled or a History_Check_Failure_Notice exists.
5. WHEN an it_deploy user submits a reject at Deploy_Approval, THE Review_API SHALL forward the reject to the Pipeline_Orchestrator whether the reject carries no, some, or all History_Flag acknowledgments, unless criterion 8 rejects it.
6. IF the Snapshot named in a deploy approve has Designation `preview`, THEN THE Review_API SHALL reject the submission without forwarding it to the Pipeline_Orchestrator, with an error stating that only release Snapshots deploy.
7. IF the Build_Record named in a deploy approve does not record a passing result, THEN THE Review_API SHALL reject the submission without forwarding it to the Pipeline_Orchestrator, with an error naming the Build_Record result.
8. IF a decision submitted at Deploy_Approval names a changeId that has no unconsumed Parked_Token at Deploy_Approval, or names a snapshotHash or Build_Record identifier that is not an exact, case-sensitive match of the value in that Parked_Token, THEN THE Review_API SHALL reject the submission without forwarding it to the Pipeline_Orchestrator, with an error stating that the submission does not match the pending deploy approval.
9. IF the Caller identity of a deploy approve equals the Author recorded on the Snapshot under approval or the approver identity of any `approve` entry at Content_Approval in the Approvals table for the same changeId, THEN THE Review_API SHALL reject the submission without forwarding it to the Pipeline_Orchestrator, with an error stating that the person who authored or content-approved the change cannot also approve its deploy.

### Requirement 8: Approval binding and separation of duties

**User Story:** As Medic, I want every approval bound to the exact Snapshot shown and refused when the approver authored that Snapshot or approved the other gate, so that no single person can draft, approve, and deploy the same clinical change.

#### Acceptance Criteria

1. IF the snapshotHash in a submitted Approval_Decision, or at Deploy_Approval its Build_Record identifier, is absent or is not an exact, case-sensitive, character-for-character match of the corresponding value in the unconsumed Parked_Token for that changeId and Approval_Gate, THEN THE Review_API SHALL reject the submission with a stale-snapshot error that names the snapshotHash held in the Parked_Token.
2. IF the Tokens table holds no unconsumed Parked_Token for the changeId and Approval_Gate named in a submitted Approval_Decision, THEN THE Review_API SHALL reject the submission with an already-decided error.
3. IF a submitted Approval_Decision with decision `reject` has a note that is absent, empty, or made up only of whitespace characters, THEN THE Review_API SHALL reject the submission with a note-required error.
4. IF the Caller identity of a submitted Approval_Decision with decision `approve` at either Approval_Gate equals the Author that the Snapshot_Service records for the snapshotHash in the unconsumed Parked_Token, THEN THE Review_API SHALL reject the submission with HTTP 403 citing separation of duties.
5. IF the Caller identity of a submitted Approval_Decision with decision `approve` equals the approver identity of any `approve` entry in the Approvals table at the other Approval_Gate for the same changeId, for any snapshotHash of that changeId, THEN THE Review_API SHALL reject the submission with HTTP 403 citing separation of duties.
6. THE Review_API SHALL read the Snapshot Author from the Snapshot_Service and the prior approvals from the Approvals table at the time of each submission, ignoring any approver identity, Author, or Role_Group value supplied in the request body.
7. WHEN a Signed_In_User opens an Approval_Screen for a change where the Caller identity is the Author of the Snapshot named by the unconsumed Parked_Token, or where the Approvals table records an `approve` by the Caller identity at the other Approval_Gate for that changeId, THE Review_UI SHALL disable the approve control and show a separation-of-duties reason stating whether the caller authored the Snapshot or approved the other Approval_Gate.
8. WHEN a submitted Approval_Decision passes every check in Requirements 1, 5, 7, and 8, THE Review_API SHALL forward the Approval_Decision to the Pipeline_Orchestrator.
9. IF the Review_API rejects a submitted Approval_Decision under any criterion of Requirements 1, 5, 7, or 8, THEN THE Review_API SHALL return the rejection to the caller without forwarding the Approval_Decision to the Pipeline_Orchestrator, so that the Parked_Token stays unconsumed.
10. IF the Review_API cannot read the Parked_Token for a submitted Approval_Decision, or cannot read the Snapshot Author from the Snapshot_Service or the prior approvals from the Approvals table for a submitted `approve`, THEN THE Review_API SHALL reject the submission with an error stating that the approval checks could not be completed.

### Requirement 9: Escalations and rollback

**User Story:** As a pipeline participant, I want to resolve a stopped change or roll back a deployed one from the Review_UI, so that failures reach a person and every deployment is reversible.

#### Acceptance Criteria

1. WHEN a Signed_In_User opens the Escalation_View, THE Escalation_View SHALL list every Escalation that has no recorded Escalation_Resolution, showing for each Escalation the changeId, Pipeline_State, runId, error text, and attempt count.
2. WHEN a Signed_In_User opens an Escalation, THE Escalation_View SHALL offer a control only for each Escalation_Resolution that is in the Escalation's allowed Escalation_Resolutions and that the Operation_Permission table permits for at least one of the user's Role_Groups.
3. IF a submitted Escalation_Resolution is not in the Escalation's allowed Escalation_Resolutions, THEN THE Review_API SHALL reject the submission with an error listing the allowed resolutions.
4. IF a submitted Escalation_Resolution names an Escalation for which an Escalation_Resolution is already recorded, THEN THE Review_API SHALL reject the submission with an already-resolved error.
5. WHEN a program_officer chooses `submit_revision` on an Escalation, THE Review_UI SHALL open the Hand_Edit_Screen loaded with the Snapshot for the change's Current snapshotHash.
6. WHEN a Signed_In_User submits an Escalation_Resolution that passes the Operation_Permission check in Requirement 1 and the checks in criteria 3, 4, and 11, THE Review_API SHALL send the Escalation_Resolution to the Pipeline_Orchestrator with the changeId, the Pipeline_State, the resolution, the Caller identity, the note, and, for `submit_revision`, the Revision's snapshotHash.
7. WHILE a change's Lifecycle_State is `deployed`, THE Review_UI SHALL offer a rollback action, only to users in the `it_deploy` Role_Group, that lists each of the change's Rollback_Candidates with the candidate's snapshotHash and Deploy_Approval time, most recent Deploy_Approval first.
8. WHEN an it_deploy user selects a Rollback_Candidate, THE Review_UI SHALL show the target snapshotHash, the Caller identity and time of the target's recorded `approve` at Deploy_Approval, and the target's Build_Record result before asking for confirmation.
9. WHEN an it_deploy user confirms a rollback that passes the checks in criterion 10, THE Review_API SHALL send a Rollback_Request naming the changeId, the target snapshotHash, and the Caller identity.
10. IF a Rollback_Request names a change whose Lifecycle_State is not `deployed` when the Review_API receives the request, a target snapshotHash that is not a Rollback_Candidate at that time, or a target Snapshot for which the Snapshot_Service reports an Integrity check failure, THEN THE Review_API SHALL reject the request with an error naming the failed condition.
11. IF a `submit_revision` Escalation_Resolution names no Revision snapshotHash, or names a snapshotHash that the Snapshot_Service does not hold for the changeId with the change's Current snapshotHash as parent, THEN THE Review_API SHALL reject the submission with an error naming the failed condition.
12. IF a change whose Lifecycle_State is `deployed` has no Rollback_Candidate, THEN THE Review_UI SHALL show a statement that no Rollback_Candidate exists in place of the candidate list.

### Requirement 10: Change list and history

**User Story:** As any signed-in role, I want a read-only history of every change, so that I can audit what was drafted, checked, approved, built, and deployed.

#### Acceptance Criteria

1. WHEN a Signed_In_User opens the Review_UI change list, THE Review_UI SHALL list every change recorded in the Changes table, whatever its Lifecycle_State, with the changeId, pathway, Lifecycle_State, and Current snapshotHash, with the change whose latest Lifecycle_State transition is most recent listed first.
2. WHEN a Signed_In_User opens the Change_History_View for a changeId, THE Change_History_View SHALL list every Lifecycle_State transition of the change, oldest first, with the previous Lifecycle_State, the new Lifecycle_State, and the transition's timestamp.
3. THE Change_History_View SHALL list every Snapshot stored for the changeId with the snapshotHash, Origin, Author, Designation, and parent snapshotHash.
4. THE Change_History_View SHALL mark each listed Snapshot that has no parent snapshotHash as having no parent.
5. THE Change_History_View SHALL list every Decision_Log entry for the change, oldest first, with the Approval_Gate, snapshotHash, Build_Record identifier for Deploy_Approval entries, decision, approver Caller identity, approver Role_Group, note, time, and each acknowledgment's History_Flag identifier, acknowledging Caller identity, and acknowledgment time.
6. THE Change_History_View SHALL list, oldest first, every Clinician_Referral, Escalation_Resolution, and Rollback_Request for the change with the acting person's Caller identity and time, and every Escalation for the change with the Pipeline_State, runId, error text, attempt count, and whether the Escalation is open or resolved.
7. WHEN a Check_Report exists for a snapshotHash listed in the Change_History_View, THE Change_History_View SHALL link the snapshotHash to that Check_Report.
8. WHEN a Build_Record exists for a snapshotHash listed in the Change_History_View, THE Change_History_View SHALL link the snapshotHash to that Build_Record.
9. THE Change_History_View SHALL offer no control that creates, changes, or deletes a listed entry.
10. IF the Snapshot_Service reports an Integrity check failure for a Snapshot of the change, THEN THE Change_History_View SHALL show the Integrity check failure beside that Snapshot's snapshotHash.
11. IF the Review_API cannot read the Changes table, the Approvals table, the Audit table, the Decision_Log prefix, or the Snapshot_Service while building the Change_History_View, THEN THE Change_History_View SHALL show an error that names each unreadable source and states that the displayed history is incomplete.

### Requirement 11: Synthetic data and credential handling

**User Story:** As Medic, I want the Review_UI to accept only synthetic data and public guidelines and to stay away from CHT credentials, so that no patient data or deployment secret enters a prompt, a log, or a screen.

#### Acceptance Criteria

1. WHEN the Review_API receives a submission containing one or more non-empty Free_Text_Field values, THE Review_API SHALL screen every such value with the Personal_Data_Screen before storing any part of the submission or forwarding any part of the submission to the Pipeline_Orchestrator or the Snapshot_Service.
2. IF the Personal_Data_Screen detects personal data or a credential in any Free_Text_Field value of a submission, THEN THE Review_API SHALL reject the whole submission without storing or forwarding any part of it and return an error that names each affected field and its detected category without repeating the detected text.
3. WHEN the Personal_Data_Screen rejects a submission, THE Review_API SHALL write one CloudWatch Logs entry per affected field holding the Caller identity, the operation, the field name, and the detected category, with no part of the submitted text.
4. THE Review_API SHALL run under an IAM role with no permission to read the secret value of the CHT test instance login in Secrets Manager.
5. THE Review_UI SHALL show, above the first Free_Text_Field or guideline upload control on every screen that contains one, a notice stating that only synthetic data and public guidelines are accepted.
6. IF the Personal_Data_Screen returns an error or returns no result within 10 seconds for a Free_Text_Field value, THEN THE Review_API SHALL reject the whole submission without storing or forwarding any part of it and return an error stating that the personal-data screen could not run.
7. THE Review_API SHALL exclude every Free_Text_Field value, whether accepted or rejected, from the entries it writes to CloudWatch Logs.

## Open Questions

1. Approver view format: decision table, flowchart, or both (§19 open item). Requirement 4 fixes only "structured, non-chat".
2. The Escalation_Resolution rows of the Operation_Permission table are assumed; the design does not say who resolves each kind.
3. Edit_Class: which fields count as Display_Text fields, whether the Logic_Differ should emit the classification, and where a Clinician_Referral is stored (and whether the Decision_Recorder logs the referral).
4. Config_Diff: which spec produces the diff (cht-config-compiler, build-test-sandbox, or the Review_API) and whether "most recently deployed release for the pathway" is the right baseline.
5. Does a History_Check_Failure_Notice need its own acknowledgment before deploy approval?
6. Which spec supplies the Pathway_List for a pathway pick?
7. Should the Review_API screen uploaded guideline PDFs for personal data before storing them? No other component screens them now that knowledge base ingestion is gone.
8. Separation of duties is scoped per changeId (stricter than per snapshotHash). Confirm that scope.
9. **Upload and edit limits.** Requirement 2 sets a 50 MB limit on guideline PDFs and a 2,000-character limit on plain-language edit text. *(Resolved 2026-11-04: the edit-text bound is 2,000 characters; logic-model-snapshots Requirement 4 was aligned to the same number, so the two specs now agree.)* The 50 MB PDF limit is still unconfirmed against the design.
