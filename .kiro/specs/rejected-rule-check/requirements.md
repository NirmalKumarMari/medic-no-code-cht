# Requirements Document

## Introduction

This spec makes sure Vera never re-adds a Rule that a clinician rejected. When a clinician rejects a Snapshot at Content_Approval, the clinician marks which of its Rules they reject. The Decision_Recorder stores one Rejected_Rule_Record per marked Rule in the Approvals table, keyed by a Rule_Fingerprint that ignores the Rule's id and position. Before every content approval, the Logic_Checker runs the Rejected_Rule_Check as the sixth check of its Check_Suite. If any Rule of the Snapshot has the same Rule_Fingerprint as a rejected Rule for the same Tenant and Pathway, the check fails and the Overall result fails, so the Snapshot never reaches the clinician again.

Everything in this spec is deterministic code reading data stored in the database. No model or agent takes part. This spec replaces the former decision-memory-history-check spec: AgentCore Memory, the Memory_Writer, memory rebuild, the History_Check_Agent, the `decision-log-read` and `decision-memory-read` tools, similarity flags, and the deploy-time History_Check state are removed.

### Dependencies

| Spec | What this spec uses or provides |
|---|---|
| logic-model-snapshots | Uses: Snapshot, Rule, Condition, Action, Follow_Up, Canonical_Serializer and Canonical_Form, snapshotHash encoding, Snapshot_Service read with the Integrity check. |
| logic-checks-golden-cases | Must add the Rejected_Rule_Check to the Check_Suite as its sixth check, include its result in the Check_Results, and scope its determinism statement to the same Snapshot and the same Consulted_Records. |
| pipeline-orchestrator | Must add Rejected_Rule_Ids to the Approval_Decision, supply the Run Tenant when starting a Logic_Checker Run, and remove the History_Check Optional_State. Owns refusing a Clinician_Rejection that names a Rule id absent from its Snapshot, and retrying a Decision_Recorder call that returns an error. The Decision_Recorder writes the Rejected_Rule_Records defined here. |
| review-ui-approvals | Must let a clinician mark zero or more Rules on the Content_Approval_Screen when rejecting, refuse at the Review_API a Rule id absent from the Snapshot, and remove History_Flag display at Deploy_Approval. |
| authoring-agents | No interface. No agent or Gateway_Tool gets access to Rejected_Rule_Records. |
| platform-infrastructure | Provides: the Rejected_Rule_Index on the Approvals table and the Access_Policy. |

## Glossary

Terms marked *(lms)*, *(aa)*, *(lcgc)*, *(po)*, or *(rua)* keep the meaning defined in the logic-model-snapshots, authoring-agents, logic-checks-golden-cases, pipeline-orchestrator, or review-ui-approvals spec.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **LogicModel**, **Snapshot**, **snapshotHash**, **Rule**, **Condition**, **Action**, **Follow_Up**, **Source**, **Canonical_Form**, **Canonical_Serializer**, **Base_Snapshot**, **changeId**, **Snapshot_Service**, **Integrity check**: *(lms)*.
- **Tenant**, **Workload_Identity**, **Agent_Gateway**, **Gateway_Tool**: *(aa)*.
- **Logic_Checker**, **Check_Suite**, **Run**, **Check_Results**, **Check_Report**, **Overall result**: *(lcgc)*.
- **Decision_Log**, **Decision_Recorder**, **Approvals table**, **Approval_Decision**, **Approval_Gate**, **Content_Approval**, **Deploy_Approval**, **Pipeline_Orchestrator**: *(po)*.
- **Review_API**, **Content_Approval_Screen**, **Role_Group**: *(rua)*.
- **Pathway**: The value of the `pathway` field of a Snapshot's LogicModel.
- **Fingerprint_Input**: The Condition, the Action, and the Follow_Up (or its absence) of one Rule, excluding the Rule id, the Source, and the Rule's position in its Snapshot.
- **Rule_Fingerprint**: The SHA-256 digest of the Canonical_Form of one Rule's Fingerprint_Input.
- **Fingerprint_Calculator**: Deterministic code that computes Rule_Fingerprints.
- **Rejected_Rule_Ids**: The list of zero or more Rule ids that a clinician marks as rejected in a `reject` Approval_Decision at Content_Approval.
- **Clinician_Rejection**: An Approval_Decision at Content_Approval with decision `reject` whose approver Cognito group is `clinician`.
- **Rejection note**: The note of a Clinician_Rejection.
- **Decision_Log entry identifier**: The identifier the Decision_Recorder assigns to one Decision_Log entry.
- **Decision time**: The time recorded in the Decision_Log entry of an Approval_Decision.
- **Rejected_Rule_Record**: An append-only Approvals table item recording that a clinician rejected one Rule of one Snapshot.
- **Rejected_Rule_Record identifier**: The identifier of one Rejected_Rule_Record, unique across the Approvals table.
- **Rejected_Rule_Index**: The Approvals table secondary index, provisioned by platform-infrastructure, keyed by Tenant, Pathway, and Rule_Fingerprint.
- **Index visibility timeout**: The 30 seconds the Decision_Recorder waits for stored Rejected_Rule_Records to appear in the Rejected_Rule_Index (Requirement 3.7).
- **Rejected_Rule_Check**: The sixth check of the Check_Suite, defined in this spec.
- **Run Tenant**: The Tenant of the change named by a Run's changeId, supplied by the Pipeline_Orchestrator when the Run starts.
- **Consulted_Records**: The Rejected_Rule_Records whose Tenant equals the Run Tenant and whose Pathway equals the checked Snapshot's Pathway, as read during one Run.
- **Rejected_Rule_Match**: A Rule of the checked Snapshot whose Rule_Fingerprint equals the Rule_Fingerprint of at least one Consulted_Record.
- **Rejected_Rule_Finding**: The finding the Rejected_Rule_Check reports for one Rejected_Rule_Match.
- **Record read timeout**: The 10 seconds the Rejected_Rule_Check waits for one read of the Rejected_Rule_Index (Requirement 4.8).
- **Access_Policy**: The IAM policies, provisioned by platform-infrastructure, that govern access to Rejected_Rule_Records and the Rejected_Rule_Index.

## Requirements

### Requirement 1: Rule fingerprints

**User Story:** As a clinician, I want a rejected rule recognized by its clinical content, so that renaming or moving the rule does not let it back in.

#### Acceptance Criteria

1. THE Fingerprint_Calculator SHALL compute each Rule_Fingerprint as the SHA-256 digest of the Canonical_Form of the Rule's Fingerprint_Input, encoded the same way as snapshotHash.
2. THE Fingerprint_Calculator SHALL build each Fingerprint_Input from the Rule's Condition, Action, and Follow_Up only.
3. THE Fingerprint_Calculator SHALL return the same Rule_Fingerprint for the same Fingerprint_Input on every invocation, regardless of when or in which process the computation runs.
4. THE Fingerprint_Calculator SHALL return equal Rule_Fingerprints for two Rules whose Fingerprint_Inputs have identical Canonical_Forms, including when the Rules differ in Rule id, Source, or position, or belong to different Snapshots.
5. THE Fingerprint_Calculator SHALL return different Rule_Fingerprints for two Rules whose Fingerprint_Inputs have different Canonical_Forms, including any difference in Condition, Action, or Follow_Up.
6. THE Fingerprint_Calculator SHALL represent an absent Follow_Up in the Fingerprint_Input with a Canonical_Form different from that of every present Follow_Up.
7. THE Fingerprint_Calculator SHALL compute each Rule_Fingerprint from the Rule alone, with no model call and no read of stored data.

### Requirement 2: Recording rejected rules at Content_Approval

**User Story:** As a clinician, I want only the rules I mark when rejecting a Snapshot to be recorded as rejected, so that Vera blocks exactly what I rejected.

#### Acceptance Criteria

1. WHEN the Decision_Recorder records a Clinician_Rejection, THE Decision_Recorder SHALL store exactly one Rejected_Rule_Record for each distinct Rule id in the Clinician_Rejection's Rejected_Rule_Ids.
2. THE Decision_Recorder SHALL compute each Rejected_Rule_Record's Rule_Fingerprint with the Fingerprint_Calculator from the Rule with that Rule id in the Snapshot named by the Clinician_Rejection's snapshotHash, read through the Snapshot_Service with the Integrity check.
3. THE Decision_Recorder SHALL store in each Rejected_Rule_Record the Rejected_Rule_Record identifier, the Rule_Fingerprint, the Rule id, and the snapshotHash, changeId, Tenant, Pathway, Decision_Log entry identifier, Rejection note, and Decision time of the Clinician_Rejection.
4. WHEN a Clinician_Rejection has an empty Rejected_Rule_Ids list, THE Decision_Recorder SHALL record the Clinician_Rejection with no Rejected_Rule_Record.
5. WHEN the Decision_Recorder records an Approval_Decision that is not a Clinician_Rejection, including a `reject` at Deploy_Approval or a `reject` by a caller in the `program_reviewer` Role_Group, THE Decision_Recorder SHALL store no Rejected_Rule_Record for that Approval_Decision.
6. THE Decision_Recorder SHALL store the Approvals table entry of a Clinician_Rejection and all of its Rejected_Rule_Records in one atomic write, so that either all of them are stored or none of them is.
7. IF the Decision_Recorder cannot read the Snapshot named by a Clinician_Rejection's snapshotHash, or that Snapshot fails the Integrity check, THEN THE Decision_Recorder SHALL store neither the Approvals table entry nor any Rejected_Rule_Record for that Clinician_Rejection and return an error naming the snapshotHash.
8. IF a Clinician_Rejection names a Rule id absent from the Snapshot named by its snapshotHash, THEN THE Decision_Recorder SHALL store neither the Approvals table entry nor any Rejected_Rule_Record for that Clinician_Rejection and return an error naming each absent Rule id.

### Requirement 3: Append-only storage of Rejected_Rule_Records

**User Story:** As an auditor, I want rejected-rule records that are written once and never changed, so that a recorded rejection cannot be lost, duplicated, or altered.

#### Acceptance Criteria

1. THE Decision_Recorder SHALL store every Rejected_Rule_Record as an item in the Approvals table under the changeId of its Clinician_Rejection.
2. THE Rejected_Rule_Index SHALL index every Rejected_Rule_Record by Tenant, Pathway, and Rule_Fingerprint.
3. THE Decision_Recorder SHALL derive each Rejected_Rule_Record identifier from the Decision_Log entry identifier and the Rule id, so that every attempt to record the same Clinician_Rejection produces the same identifiers.
4. THE Decision_Recorder SHALL create a Rejected_Rule_Record only when no item with the same Rejected_Rule_Record identifier exists in the Approvals table.
5. WHEN the Decision_Recorder records the same Clinician_Rejection more than once, THE Decision_Recorder SHALL leave exactly one Rejected_Rule_Record per distinct Rule id in its Rejected_Rule_Ids, with content identical to the record stored first.
6. THE Decision_Recorder SHALL report a Clinician_Rejection as recorded only after the Rejected_Rule_Index returns every Rejected_Rule_Record of that Clinician_Rejection.
7. IF the Rejected_Rule_Index does not return every Rejected_Rule_Record of a Clinician_Rejection within the Index visibility timeout after they are stored, THEN THE Decision_Recorder SHALL return an error naming the Clinician_Rejection's Decision_Log entry identifier.

### Requirement 4: Rejected_Rule_Check

**User Story:** As a clinician, I want every Snapshot checked against the rules I rejected before it reaches me, so that I never see a rejected rule again.

#### Acceptance Criteria

1. WHEN the Logic_Checker starts a Run on a Snapshot, THE Logic_Checker SHALL run the Rejected_Rule_Check on that Snapshot as one check of the Check_Suite.
2. THE Rejected_Rule_Check SHALL compute the Rule_Fingerprint of every Rule of the Snapshot with the Fingerprint_Calculator.
3. THE Rejected_Rule_Check SHALL read every Consulted_Record for the Run Tenant and the Snapshot's Pathway from the Rejected_Rule_Index.
4. THE Rejected_Rule_Check SHALL read Rejected_Rule_Records only from the Rejected_Rule_Index, with no model call and no agent call.
5. WHEN at least one Rule of the Snapshot is a Rejected_Rule_Match, THE Rejected_Rule_Check SHALL return a fail result holding one Rejected_Rule_Finding for each Rejected_Rule_Match.
6. THE Rejected_Rule_Check SHALL include in each Rejected_Rule_Finding the Rule id, the Rule_Fingerprint, and, for each matching Consulted_Record, the Rejected_Rule_Record identifier, snapshotHash, changeId, Rejection note, and Decision time.
7. WHEN no Rule of the Snapshot is a Rejected_Rule_Match, including when there are no Consulted_Records, THE Rejected_Rule_Check SHALL return a pass result with no Rejected_Rule_Findings.
8. IF the Run has no Run Tenant, or a read of the Rejected_Rule_Index returns an error or no response within the Record read timeout, THEN THE Rejected_Rule_Check SHALL return a fail result with an error naming the cause.
9. WHEN the Rejected_Rule_Check returns a fail result, THE Logic_Checker SHALL set the Overall result of the Run to fail.

### Requirement 5: Deterministic, reported results

**User Story:** As an IT lead, I want the rejected-rule result to be repeatable and to show exactly which records it used, so that I can trust and audit the block.

#### Acceptance Criteria

1. THE Rejected_Rule_Check SHALL return an identical result, including findings, order, and counts, on every Run for the same Snapshot and the same set of Consulted_Records.
2. THE Rejected_Rule_Check SHALL record in its result the Rejected_Rule_Record identifier of every Consulted_Record that matches a Rule of the Snapshot.
3. THE Rejected_Rule_Check SHALL record in its result the number of Consulted_Records it read.
4. THE Rejected_Rule_Check SHALL order Rejected_Rule_Findings by Rule id in ascending code-point order.
5. THE Rejected_Rule_Check SHALL order the matching Consulted_Records within each Rejected_Rule_Finding by Decision time, earliest first, and then by Rejected_Rule_Record identifier in ascending code-point order.
6. THE Rejected_Rule_Check SHALL list the matched Rejected_Rule_Record identifiers in its result in ascending code-point order.
7. THE Rejected_Rule_Check SHALL copy every value taken from a Consulted_Record into its result unchanged.
8. WHEN the Rejected_Rule_Check completes, THE Logic_Checker SHALL include the Rejected_Rule_Check result in the Check_Results of the Run under the check name `rejected_rule`.

### Requirement 6: Access to Rejected_Rule_Records

**User Story:** As a security reviewer, I want only the Decision_Recorder to write rejected-rule records and no agent to touch them, so that no automated author can erase or bypass a clinician's rejection.

#### Acceptance Criteria

1. THE Access_Policy SHALL grant permission to create Rejected_Rule_Records only to the Decision_Recorder's IAM role.
2. THE Access_Policy SHALL grant the Logic_Checker's IAM role permission to query the Rejected_Rule_Index and no permission to create, update, or delete items in the Approvals table.
3. THE Access_Policy SHALL grant no IAM role permission to update or delete a Rejected_Rule_Record.
4. THE Access_Policy SHALL grant no Workload_Identity permission to read or write Rejected_Rule_Records or to query the Rejected_Rule_Index.
5. THE Agent_Gateway SHALL register no Gateway_Tool whose backing permissions read or write Rejected_Rule_Records or query the Rejected_Rule_Index.

## Open Questions

1. **Lifting a rejection.** This spec has no lift path, so a rejected Rule stays blocked for its Tenant and Pathway permanently. How should a clinician lift a rejection if they later want the Rule, for example through a clinician-only decision that the Decision_Recorder records and the Rejected_Rule_Check honors?
2. **Matching scope.** This spec matches only within the same Tenant and Pathway. Should a Rule rejected in one Pathway also block identical Rules in the Tenant's other Pathways?
3. **Zero-rule rejections.** A Clinician_Rejection with no marked Rules creates no Rejected_Rule_Records (Requirement 2.4). Should the Review_UI allow it, or require at least one marked Rule?
4. **Concurrent changes.** A Snapshot that passed the Rejected_Rule_Check before another change's Clinician_Rejection was recorded can still reach the clinician. Should the check run again when the clinician opens or submits a decision at Content_Approval?
5. **Comparison order.** If the Canonical_Form keeps the order of a Condition's `all` list, reordering the Comparisons of a rejected Rule produces a new Rule_Fingerprint. Should the Fingerprint_Input sort the Comparisons?
