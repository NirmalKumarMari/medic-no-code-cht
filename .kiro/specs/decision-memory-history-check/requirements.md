# Requirements Document

## Introduction

This spec covers decision memory and the History_Check step of Vera (Solution Design §6 state 8, §7 History Check Agent row, §9, §14 AgentCore Memory row, §18). It is a Should-Have feature and the second cut if day 1 runs long.

Decision memory uses two stores, AgentCore_Memory and the Decision_Log, each with one job. AgentCore_Memory holds plain-language summaries of past approvals and rejections, written only by deterministic code. The Decision_Log (DynamoDB + S3) is the exact source of truth and is written only by the Decision_Recorder. History_Check compares a change against past decisions and produces advisory History_Flags for the IT lead. Deterministic code finds exact Rule_Fingerprint matches; the History_Check_Agent adds similarity flags from memory. History_Check never approves and never blocks a run.

Dependencies, referenced and not redefined here:
- **logic-model-snapshots**: Snapshot, snapshotHash, Rule, Base_Snapshot, Canonical_Form, Snapshot_Store.
- **authoring-agents**: Agent_Runtime, Model_Interface, Attempt_Limits, Screening_Guardrail, Agent_Gateway, Tool_Policy, AgentCore_Observability spans and Refusal records, Workload_Identity, Gateway_Smoke_Test.
- **pipeline-orchestrator**: the History_Check Optional_State, the Decision_Recorder, the Decision_Log tables, and the rule that the pipeline proceeds with a History_Check_Failure_Notice when History_Check fails.
- **review-ui-approvals**: display of History_Flags at Deploy_Approval, Rejected_Match_Flags shown first, and acknowledgment of each flag.
- **platform-infrastructure**: the Services_Instance, the AgentCore_Memory resource, and IAM roles.

## Glossary

Terms marked *(lms)*, *(aa)*, *(po)*, or *(rua)* keep the meaning defined in the logic-model-snapshots, authoring-agents, pipeline-orchestrator, or review-ui-approvals spec.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **Snapshot**, **snapshotHash**, **Rule**, **Condition**, **Follow_Up**, **Base_Snapshot**, **Canonical_Form**, **Snapshot_Store**, **changeId**: *(lms)*.
- **Agent_Runtime**, **Agent_Container**, **Services_Instance**, **Agent_Request**, **Agent_Run**, **Agent_Result**, **Agent_Output**, **Agent_Failure**, **Output_Failure**, **Attempt_Limits**, **Model_Interface**, **Model_Config**, **Primary_Model**, **Escalation_Model**, **Haiku-tier model**, **Sonnet-tier model**, **Screening_Guardrail**, **Agent_Gateway**, **Gateway_Tool**, **Tool_Policy**, **Allowed_Tool_List**, **Never_Available_Tools**, **Workload_Identity**, **AgentCore_Observability**, **Refusal record**, **Gateway_Smoke_Test**, **AgentCore_Memory**, **Tenant**, **runId**: *(aa)*.
- **Decision_Log**, **Decision_Recorder**, **Approvals table**, **Audit table**, **Approval_Decision**, **Approval_Gate**, **History_Flag**, **History_Check_Failure_Notice**, **Optional_State**, **Pipeline_Configuration**, **Approved snapshotHash**, **Build_Record**, **Pipeline_Orchestrator**, **Execution**: *(po)*.
- **Rejected_Match_Flag**: *(rua)* A high-severity History_Flag. In this spec, the History_Matcher produces it (Requirement 4).
- **History_Check**: The History_Check Optional_State *(po)* and its worker, which runs the History_Matcher and the History_Check_Agent and returns a History_Check_Result.
- **History_Check_Agent**: The Haiku-tier agent that produces Similarity_Flags from AgentCore_Memory (§7).
- **History_Matcher**: Deterministic code in the History_Check worker that produces Exact_Match_Flags from the Decision_Log.
- **Fingerprint_Calculator**: Deterministic code that computes Rule_Fingerprints and Fingerprint_Records.
- **Fingerprint_Input**: The Condition, the action, and the Follow_Up of one Rule, excluding the Rule id and the Rule's position in its Snapshot.
- **Rule_Fingerprint**: The SHA-256 digest of the Canonical_Form of one Rule's Fingerprint_Input.
- **Changed_Rule**: A Rule in a Snapshot whose Rule_Fingerprint does not appear among the Rule_Fingerprints of that Snapshot's Base_Snapshot.
- **Decided Snapshot**: The Snapshot named by the snapshotHash of one Approval_Decision.
- **Fingerprint_Record**: The record of one Decided Snapshot listing, for every Rule, the Rule id, the Rule_Fingerprint, and whether the Rule is a Changed_Rule.
- **Decision_Log entry identifier**: The identifier of one Decision_Log entry.
- **Past_Decision**: A Decision_Log entry holding an Approval_Decision, with the same Tenant as the current change, recorded before the current History_Check started, excluding entries whose changeId and snapshotHash equal the current change's changeId and Approved snapshotHash.
- **Pathway**: The identifier of the care pathway (CHT form and its tasks) that a change targets.
- **Memory_Namespace**: The AgentCore_Memory namespace for one Tenant and one Pathway.
- **Memory_Summary**: One AgentCore_Memory record derived from one Decision_Log entry.
- **Memory_Writer**: Deterministic code, not an agent, that writes Memory_Summaries to AgentCore_Memory.
- **Memory write retry limit**: The maximum number of attempts the Memory_Writer makes for one Memory_Summary write. Initial value: 3.
- **Memory_Rebuild**: An operator-started job that regenerates the Memory_Summaries of one Tenant from the Decision_Log.
- **Flag severity**: One of `high`, `medium`, or `low`.
- **Exact_Match_Flag**: A History_Flag produced by the History_Matcher: a Rejected_Match_Flag or an Approved_Match_Flag.
- **Approved_Match_Flag**: A low-severity History_Flag stating that a Changed_Rule exactly matches a Changed_Rule in an approved Past_Decision.
- **Similarity_Flag**: A History_Flag produced by the History_Check_Agent from Memory_Summaries.
- **History_Flags_Schema**: The JSON Schema for the History_Check_Agent's output document, a list of Similarity_Flags.
- **History_Check_Result**: The result History_Check returns to the Pipeline_Orchestrator for one change.
- **decision-log-read**: The read-only Gateway_Tool that returns Past_Decisions and their Fingerprint_Records.
- **decision-memory-read**: The read-only Gateway_Tool that returns Memory_Summaries.
- **Memory write timeout**: The 10 seconds the Memory_Writer waits for AgentCore_Memory to answer one Memory_Summary write attempt (Requirement 2.8).

## Requirements

### Requirement 1: Rule fingerprints and fingerprint records

**User Story:** As an IT lead, I want every decided Rule to carry a stable fingerprint, so that a rule seen before is recognized exactly, whatever its id or position.

#### Acceptance Criteria

1. THE Fingerprint_Calculator SHALL compute each Rule_Fingerprint as the SHA-256 digest of the Canonical_Form of the Rule's Fingerprint_Input, encoded the same way as snapshotHash.
2. THE Fingerprint_Calculator SHALL return the same Rule_Fingerprint for the same Fingerprint_Input on every invocation, regardless of when or in which process the computation runs.
3. THE Fingerprint_Calculator SHALL return equal Rule_Fingerprints for two Rules whose Fingerprint_Inputs have identical Canonical_Forms, even when the Rules differ in Rule id, differ in position, or belong to different Snapshots.
4. THE Fingerprint_Calculator SHALL return different Rule_Fingerprints for two Rules whose Fingerprint_Inputs have different Canonical_Forms, including any difference in Condition, action, or Follow_Up.
5. WHEN the Decision_Recorder records an Approval_Decision with decision `approve` or `reject`, THE Decision_Recorder SHALL store the Fingerprint_Record of the Decided Snapshot as part of that Decision_Log entry.
6. THE Fingerprint_Calculator SHALL include in each Fingerprint_Record exactly one entry for each Rule of the Decided Snapshot and no entry for any other Rule, each entry holding the Rule id, the Rule_Fingerprint, and the Changed_Rule marker.
7. IF the Decided Snapshot has a Base_Snapshot, THEN THE Fingerprint_Calculator SHALL mark a Rule as a Changed_Rule if and only if the Rule's Rule_Fingerprint is absent from the Rule_Fingerprints computed from the Base_Snapshot's Rules, regardless of Rule id or position.
8. IF the Decided Snapshot has no Base_Snapshot, THEN THE Fingerprint_Calculator SHALL mark every Rule of the Decided Snapshot as a Changed_Rule.
9. IF the Fingerprint_Calculator cannot read the Decided Snapshot or its Base_Snapshot from the Snapshot_Store, THEN THE Fingerprint_Calculator SHALL return an error naming the unreadable snapshotHash instead of a full or partial Fingerprint_Record.

### Requirement 2: Memory_Writer summaries

**User Story:** As a program lead, I want each human decision summarized in plain language in decision memory, so that agents can learn from precedent without being able to change it.

#### Acceptance Criteria

1. WHEN the Decision_Recorder records a Decision_Log entry for an Approval_Decision, THE Memory_Writer SHALL write one Memory_Summary for that entry to AgentCore_Memory within 60 seconds of the entry being recorded.
2. THE Memory_Writer SHALL generate each Memory_Summary with deterministic template code, without a model call, using only values read from the Decision_Log entry, its Fingerprint_Record, and the Decided Snapshot, and producing identical Memory_Summary text whenever those three inputs are identical.
3. THE Memory_Writer SHALL include in each Memory_Summary, as plain-language text, the Decision_Log entry identifier, changeId, Tenant, Pathway, Approval_Gate, decision, snapshotHash, approver Cognito group, decision time, the note or a statement that no note was given, and each Changed_Rule's Rule id, Rule_Fingerprint, Condition, action, and Follow_Up or a statement that the Decided Snapshot has no Changed_Rules.
4. THE Memory_Writer SHALL omit the approver's name, email address, and Cognito user identifier from every Memory_Summary.
5. THE Memory_Writer SHALL store each Memory_Summary only in the Memory_Namespace of the Tenant and Pathway recorded in its Decision_Log entry.
6. WHEN the Memory_Writer processes a Decision_Log entry whose Decision_Log entry identifier already has a Memory_Summary in AgentCore_Memory, THE Memory_Writer SHALL leave exactly one Memory_Summary for that identifier, with content identical to the Memory_Summary stored before processing.
7. THE Memory_Writer SHALL be the only principal granted permission to create, update, or delete records in AgentCore_Memory.
8. IF a Memory_Summary write attempt returns an error or receives no response within 10 seconds, THEN THE Memory_Writer SHALL retry the write until it succeeds or the total number of attempts for that Memory_Summary equals the Memory write retry limit.
9. IF the attempt numbered at the Memory write retry limit fails, THEN THE Memory_Writer SHALL record the Decision_Log entry identifier, the number of attempts made, and the last error in AgentCore_Observability.
10. IF the Memory_Writer cannot read the Decision_Log entry, its Fingerprint_Record, or the Decided Snapshot, THEN THE Memory_Writer SHALL write no Memory_Summary for that entry and record the Decision_Log entry identifier and the name of the unreadable input in AgentCore_Observability.

### Requirement 3: Decision_Log authority and memory rebuild

**User Story:** As an auditor, I want the Decision_Log to remain the only record of authority and memory to be rebuildable from it, so that memory can never drift from or alter what humans decided.

#### Acceptance Criteria

1. THE Memory_Writer SHALL hold read permission, and no create, update, or delete permission, on every Decision_Log table and stored object.
2. THE Memory_Writer SHALL process Decision_Log entries outside the Execution, so that no Memory_Summary write, retry, or write failure delays the Execution's next state or changes the Execution's status.
3. WHEN an operator starts a Memory_Rebuild for a Tenant, THE Memory_Writer SHALL leave exactly one Memory_Summary, equal to the template output defined in Requirement 2 for that entry and stored in the Memory_Namespace of the entry's Tenant and Pathway, for every Decision_Log entry of that Tenant that holds an Approval_Decision and was recorded before the Memory_Rebuild started.
4. WHEN a Memory_Rebuild has written every Memory_Summary required by criterion 3 with no failed write, THE Memory_Writer SHALL delete every Memory_Summary in the Tenant's Memory_Namespaces whose Decision_Log entry identifier matches no Decision_Log entry of that Tenant that holds an Approval_Decision.
5. THE Memory_Writer SHALL produce, after a Memory_Rebuild of a Tenant, a set of Memory_Summaries identical in count, Memory_Namespace, and content to the set that incremental writes of the same Decision_Log entries produce.
6. WHERE History_Check is disabled in the Pipeline_Configuration, THE Memory_Writer SHALL write Memory_Summaries and run Memory_Rebuilds exactly as it does when History_Check is enabled.
7. IF a Memory_Rebuild fails to read the Decision_Log, or a Memory_Summary write fails on the last attempt allowed by the Memory write retry limit, THEN THE Memory_Writer SHALL end the Memory_Rebuild as failed without deleting any Memory_Summary, recording the Tenant, the error, and any affected Decision_Log entry identifiers in AgentCore_Observability.
8. WHILE a Memory_Rebuild runs for a Tenant, WHEN the Decision_Recorder records a Decision_Log entry for an Approval_Decision of that Tenant, THE Memory_Writer SHALL write that entry's Memory_Summary as an incremental write and keep it through the end of the Memory_Rebuild.

### Requirement 4: Exact fingerprint matching

**User Story:** As an IT lead, I want deterministic code to tell me when a changed rule exactly matches a rule humans approved or rejected before, so that a known-bad rule is caught at deploy approval.

#### Acceptance Criteria

1. WHEN History_Check starts for a change, THE History_Matcher SHALL compute, with the Fingerprint_Calculator, the Fingerprint_Record of the Snapshot named by the change's Approved snapshotHash, marking Changed_Rules against that Snapshot's Base_Snapshot.
2. THE History_Matcher SHALL read Past_Decisions and their Fingerprint_Records only from the Decision_Log, with read-only permissions, and never from AgentCore_Memory.
3. WHEN a Changed_Rule's Rule_Fingerprint equals the Rule_Fingerprint of a Rule marked as a Changed_Rule in the Fingerprint_Record of at least one Past_Decision with decision `reject`, THE History_Matcher SHALL produce exactly one Rejected_Match_Flag with Flag severity `high` for that Changed_Rule.
4. WHEN a Changed_Rule's Rule_Fingerprint equals the Rule_Fingerprint of a Rule marked as a Changed_Rule in the Fingerprint_Record of at least one Past_Decision with decision `approve`, THE History_Matcher SHALL produce exactly one Approved_Match_Flag with Flag severity `low` for that Changed_Rule, including when that Changed_Rule also has a Rejected_Match_Flag.
5. THE History_Matcher SHALL include in each Exact_Match_Flag the current Rule id, the Rule_Fingerprint, and, for every matched Past_Decision ordered by decision time earliest first and then by Decision_Log entry identifier, the Decision_Log entry identifier, changeId, Approval_Gate, snapshotHash, and note.
6. WHEN a Rule of the Snapshot named by the Approved snapshotHash is not a Changed_Rule, or its Rule_Fingerprint matches no Rule marked as a Changed_Rule in the Fingerprint_Record of any Past_Decision with decision `approve` or `reject`, THE History_Matcher SHALL produce no Exact_Match_Flag for that Rule.
7. THE History_Matcher SHALL produce identical Exact_Match_Flags, including flag identifiers, Flag severities, and the order of matched Past_Decisions, on every run for the same changeId, Approved snapshotHash, and Decision_Log contents.
8. IF the History_Matcher cannot read the Snapshot named by the Approved snapshotHash or that Snapshot's Base_Snapshot from the Snapshot_Store, THEN THE History_Matcher SHALL return a read error naming the unreadable snapshotHash in place of any Exact_Match_Flags.
9. IF a Past_Decision has no Fingerprint_Record in the Decision_Log, THEN THE History_Matcher SHALL return a read error naming that Past_Decision's Decision_Log entry identifier in place of any Exact_Match_Flags.

### Requirement 5: History_Check_Agent similarity flags

**User Story:** As an IT lead, I want an agent to point out past decisions that resemble this change without matching exactly, so that I see relevant precedent the exact match misses.

#### Acceptance Criteria

1. THE History_Check_Agent SHALL run on the Agent_Runtime in its own Agent_Container on the Services_Instance with its own Workload_Identity.
2. THE Model_Config SHALL map the History_Check_Agent to a Haiku-tier model as Primary_Model and a Sonnet-tier model as Escalation_Model.
3. THE Agent_Runtime SHALL apply the Attempt_Limits, the Screening_Guardrail check, the schema-repair and escalation handling of Output_Failures, and the AgentCore_Observability spans defined in authoring-agents to every History_Check_Agent Agent_Run.
4. WHEN a History_Check_Agent Agent_Run ends, THE Agent_Runtime SHALL return exactly one Agent_Result, which is an Agent_Output only if its output document conforms to the History_Flags_Schema and passes the checks in criteria 6 and 7.
5. THE History_Flags_Schema SHALL define the output document as a list of 0 to 10 Similarity_Flags, each holding a reason text of 1 to 500 characters, 1 to 5 Memory_Summary references given as Decision_Log entry identifiers, 0 to 10 Rule ids, and a Flag severity of `medium` or `low`.
6. IF a Similarity_Flag cites a Decision_Log entry identifier that matches no Memory_Summary returned by decision-memory-read during the same Agent_Run, THEN THE Agent_Runtime SHALL treat the output document as an Output_Failure with an output-check error naming each unmatched identifier.
7. IF a Similarity_Flag names a Rule id absent from the Snapshot named by the Approved snapshotHash in the Agent_Request, THEN THE Agent_Runtime SHALL treat the output document as an Output_Failure with an output-check error naming each such Rule id.
8. WHEN no decision-memory-read call during a History_Check_Agent Agent_Run returns a Memory_Summary and no decision-memory-read call returns an error, THE History_Check_Agent SHALL return an Agent_Output whose output document is an empty Similarity_Flag list.
9. WHEN History_Check sends an Agent_Request to the History_Check_Agent, THE History_Check SHALL include in the payload the Approved snapshotHash, the Pathway, and every Rule of the Snapshot named by that snapshotHash with its Rule id, Condition, action, Follow_Up, Rule_Fingerprint, and Changed_Rule marker.
10. IF a decision-log-read or decision-memory-read call during a History_Check_Agent Agent_Run returns an error, THEN THE Agent_Runtime SHALL end the Agent_Run without a further model call or tool call and return an Agent_Failure whose failure reason names the tool and the error kind.

### Requirement 6: History_Check_Agent tool access

**User Story:** As a security reviewer, I want the History_Check_Agent limited to reading decisions and memory, so that the agent can never write a decision, write memory, approve, or deploy.

#### Acceptance Criteria

1. THE Tool_Policy SHALL permit the History_Check_Agent, identified by its Workload_Identity, to call exactly decision-log-read and decision-memory-read as its Allowed_Tool_List, with no other Gateway_Tool.
2. THE Agent_Gateway SHALL register decision-log-read and decision-memory-read as Gateway_Tools whose backing permissions allow only read actions, on the Decision_Log for decision-log-read and on AgentCore_Memory for decision-memory-read, and allow no create, update, or delete action on any resource.
3. THE decision-log-read tool SHALL return only Past_Decisions and Fingerprint_Records whose Tenant equals the Tenant in the calling Agent_Run's Agent_Request, ignoring any Tenant value in the call arguments.
4. THE decision-log-read tool SHALL return each Past_Decision with its Decision_Log entry identifier, changeId, Approval_Gate, decision, snapshotHash, approver Cognito group, note, decision time, and Fingerprint_Record, and with no approver identity value.
5. THE decision-memory-read tool SHALL return only Memory_Summaries from the Memory_Namespaces of the Tenant in the calling Agent_Run's Agent_Request, ignoring any Tenant value in the call arguments.
6. IF the History_Check_Agent calls a Gateway_Tool outside its Allowed_Tool_List, THEN THE Agent_Gateway SHALL return a denial result to the Agent_Runtime without running the tool and record a Refusal record holding the History_Check_Agent's Workload_Identity, the tool name, the changeId, and the runId.
7. WHEN the Agent_Gateway is deployed or the Tool_Policy changes, THE Gateway_Smoke_Test SHALL call decision-log-read, decision-memory-read, `get-logic`, and each Never_Available_Tool once as the History_Check_Agent, using synthetic arguments and a changeId reserved for the Gateway_Smoke_Test, and confirm that both read tools return non-error responses, the `get-logic` call returns a Tool_Policy denial, each Never_Available_Tool call returns a denial or error response without running a tool, and AgentCore_Observability holds a Refusal record for each denied call within 300 seconds of the call.
8. WHEN a decision-log-read or decision-memory-read call finds no Past_Decisions or Memory_Summaries for the calling Agent_Run's Tenant, THE Agent_Gateway SHALL return to the Agent_Runtime an empty result marked as a success and not as a Tool error.
9. IF any History_Check_Agent call that the Gateway_Smoke_Test makes under criterion 7 returns a result other than the expected one, or has no expected Refusal record within 300 seconds of the call, THEN THE Gateway_Smoke_Test SHALL report a failing result naming each Gateway_Tool and check that did not pass.

### Requirement 7: Advisory History_Check result

**User Story:** As an IT lead, I want history results that inform my deploy decision without ever blocking it, so that a history problem never silently stops or silently passes a change.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator calls the History_Check worker for a change, THE History_Check SHALL run the History_Matcher once and send exactly one Agent_Request holding the changeId and the Approved snapshotHash to the History_Check_Agent, whatever the outcome of the History_Matcher.
2. WHEN the History_Matcher completes without a read error and the History_Check_Agent returns an Agent_Output, THE History_Check SHALL return one History_Check_Result holding every Exact_Match_Flag the History_Matcher produced and every Similarity_Flag in the Agent_Output.
3. THE History_Check SHALL give every History_Flag an identifier unique within the History_Check_Result, keeping the identifier the History_Matcher assigned to each Exact_Match_Flag.
4. THE History_Check SHALL list every Rejected_Match_Flag before every other History_Flag in the History_Check_Result.
5. THE History_Check SHALL return every History_Check_Result without a pass, fail, or block verdict, whatever the number or Flag severity of its History_Flags.
6. WHEN the History_Matcher completes with no Exact_Match_Flags and the History_Check_Agent returns an Agent_Output holding an empty Similarity_Flag list, THE History_Check SHALL return one History_Check_Result holding an empty History_Flag list, no read error, and no Agent_Failure.
7. IF the History_Check_Agent returns an Agent_Failure, THEN THE History_Check SHALL return one History_Check_Result holding the Agent_Failure, no Similarity_Flags, and every Exact_Match_Flag the History_Matcher produced.
8. IF the History_Matcher receives an error reading the Decision_Log or reading the Snapshot named by the Approved snapshotHash from the Snapshot_Store, THEN THE History_Check SHALL return one History_Check_Result holding the read error, no Exact_Match_Flags, and either the Similarity_Flags or the Agent_Failure returned by the History_Check_Agent.
9. THE History_Check SHALL include the changeId, the Approved snapshotHash, the Build_Record identifier, and the runId in every History_Check_Result, including a result that holds a read error or an Agent_Failure.
10. THE History_Check SHALL place each Exact_Match_Flag and each Similarity_Flag in the History_Check_Result with every value unchanged from the History_Matcher or the Agent_Output, except the identifier given to a Similarity_Flag.

## Open Questions

1. **AgentCore Memory write path.** §9 requires that only code writes memory. If summaries go in as events processed by a model-based extraction strategy, the stored text is model-generated. Confirm a direct record write, and whether caller-chosen record ids are available for idempotency (Requirement 2.6).
2. **pipeline-orchestrator alignment.** That spec expects History_Check to return an Agent_Result and shows the History_Check_Failure_Notice "in place of" History_Flags. Requirement 7.7 keeps Exact_Match_Flags alongside the failure, so a model failure cannot hide a Rejected_Match_Flag. The Decision_Recorder must also store Fingerprint_Records (Requirement 1.5).
3. **Other memory readers.** §9 also lists the Drafting and Change Planner agents as memory readers, but the authoring-agents Allowed_Tool_Lists grant them no decision-memory-read. Should that spec add it, or does only the History_Check_Agent read memory for the demo?
4. **Pathway source.** Which record carries a change's Pathway: the StructuredSpec, the Changes table, or the Snapshot?
5. **Fingerprint_Input fields.** Which LogicModel_Schema field is the Rule "action", and should the fingerprint normalize the order of commutative Condition terms?
6. **Same-change matches.** Past_Decisions currently include earlier rejected Snapshots of the same changeId, so a revision that keeps a rejected Rule unchanged gets a Rejected_Match_Flag. Keep this or exclude same-change entries?
7. **Notes in memory.** Rejection notes are free text and may contain personal data. Screen them when the Memory_Writer writes them, or rely on the read-time Screening_Guardrail?
