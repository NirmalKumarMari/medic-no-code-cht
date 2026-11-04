# Requirements Document

## Introduction

This spec covers the authoring agents of Vera (Solution Design §7, with §3, §6, §14, and §15). Vera has three authoring agents. The Intake_Agent turns a Change_Request into a StructuredSpec. The Drafting_Agent turns a StructuredSpec into a LogicModel and flags gaps for a person. The Change_Planner_Agent turns a plain-language edit into a ChangePlan. The spec also covers the shared Agent_Runtime that hosts the agents, the schema-repair loop, per-Attempt limits, the Model_Interface, input screening, tracing, and the agent-facing AgentCore_Gateway with its Cedar Tool_Policy.

Agents draft and flag. Agents never approve, compile, build, test, deploy, or write configuration files, approvals, the Decision_Log, or AgentCore_Memory (design rules 1, 2, 7, and 8).

### Scope and dependencies

| Concern | Owning spec |
|---|---|
| LogicModel, StructuredSpec, and ChangePlan schemas; Schema_Validator; Snapshot_Store; `get-logic`, `diff-logic`, and Change_Plan_Applier behavior | logic-model-snapshots |
| Completeness, exclusivity, reachability, catch-all, and golden-case checks (state 4) | logic-checks-golden-cases |
| Step Functions states, invoking agents, storing agent drafts as Snapshots, surfacing Agent_Failures to a person, the Decision_Log | pipeline-orchestrator |
| Content and deploy approvals, separation of duties | review-ui-approvals |
| Compiling approved Snapshots into XLSForm and `tasks.js` | cht-config-compiler |
| `cht-conf` build and synthetic-patient tests | build-test-sandbox |
| Upload to the CHT test instance and deploy verification | cht-deployer |
| History_Check_Agent and AgentCore_Memory | decision-memory-history-check |
| VPC, Services_Instance, IAM roles, Screening_Guardrail resource, CloudWatch | platform-infrastructure |
| Agent_Runtime, Intake_Agent, Drafting_Agent, Change_Planner_Agent, Spec_Store_Write, exposing `get-logic`, `diff-logic`, and `validate-logic` on Agent_Gateway, Tool_Policy, Workload_Identities, Model_Interface, agent tracing | **this spec** |

## Glossary

Terms marked *(logic-model-snapshots)* keep the meaning defined in that spec.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **CHT**: Community Health Toolkit.
- **StructuredSpec**, **LogicModel**, **ChangePlan**, **Change_Operation**, **Snapshot**, **snapshotHash**, **Base_Snapshot**, **Rule**, **Flag**, **Flag-type enumeration**, **Source**, **Validation_Result**, **Schema_Validator**, **StructuredSpec_Schema**, **LogicModel_Schema**, **ChangePlan_Schema**, **Canonical_Form**, **Snapshot_Store**, **Logic_Differ**, **Change_Plan_Applier**, **changeId**, **get-logic**, **Input**, **Condition**, **Follow_Up**, **Difference**: *(logic-model-snapshots)*.
- **Screening_Guardrail**: The Amazon Bedrock Guardrail that detects personal data and credentials, provisioned by the platform-infrastructure spec.
- **AgentCore_Gateway**: The Amazon Bedrock AgentCore Gateway through which agents reach tools.
- **Pipeline_Orchestrator**: The Step Functions state machine and its workers, defined in the pipeline-orchestrator spec.
- **Intake_Agent**, **Drafting_Agent**, **Change_Planner_Agent**: The Intake, Drafting / Clinical Review, and Change Planner agents listed in §7. These three agents are the Agents of this spec.
- **History_Check_Agent**: The agent defined by the decision-memory-history-check spec.
- **Agent**: One of the Intake_Agent, Drafting_Agent, or Change_Planner_Agent.
- **Agent_Runtime**: The shared code, built on a portable agent framework (Strands Agents or equivalent), that runs one Agent inside one Agent_Container and performs that Agent's model calls, tool calls, output validation, schema-repair loop, and Attempt_Limit enforcement.
- **Agent_Container**: The container that runs exactly one Agent on the Services_Instance.
- **Services_Instance**: The services EC2 instance listed in §14, provisioned by the platform-infrastructure spec.
- **Change_Request**: The request that starts a change, holding a Request_Type, the request content, and the Author.
- **Request_Type**: One of `guideline_upload`, `pathway_pick`, or `plain_language_edit`.
- **Edit text**: The plain-language description of the requested change that a Change_Request with Request_Type `plain_language_edit` carries.
- **Author**: The authenticated identity of the person who submitted the Change_Request.
- **Tenant**: The identifier of the program or deployment that a change belongs to, supplied by the Pipeline_Orchestrator.
- **runId**: The identifier of one Agent_Run, supplied by the Pipeline_Orchestrator.
- **Agent_Request**: The input the Pipeline_Orchestrator sends to one Agent: a changeId, a runId, a Tenant, and the Agent's payload (Requirements 2, 4, and 5).
- **Agent_Run**: The processing of one Agent_Request by one Agent, made of at most two Attempts.
- **Agent_Result**: The single result of one Agent_Run: an Agent_Output or an Agent_Failure.
- **Agent_Output**: An Agent_Result holding one output document with a passing Validation_Result, the identifier of the model that produced the document, and whether the document came from the Escalation_Model.
- **Agent_Failure**: An Agent_Result holding no output document, holding the failure reason and every Validation_Result and output-check error produced during the Agent_Run.
- **Output_Type**: The document type an Agent produces: StructuredSpec for the Intake_Agent, LogicModel for the Drafting_Agent, and ChangePlan for the Change_Planner_Agent.
- **Output_Failure**: An output document that receives a failing Validation_Result from the Schema_Validator or fails an output check in Requirement 5.
- **Output-check error**: An error produced by an output check in Requirement 5, naming the failing element by JSON path, Rule id, field name, or Change_Operation list position.
- **Element kind**: The kind of LogicModel element that a Change_Operation targets: Input, Rule, or Flag.
- **Attempt**: One try by an Agent to produce a valid output document on one model.
- **Attempt number**: The position of an Attempt within its Agent_Run: 1 for the Attempt on the Primary_Model and 2 for the Attempt on the Escalation_Model.
- **Bedrock_Turn**: One model invocation made through the Model_Interface.
- **Schema_Repair_Turn**: A Bedrock_Turn that sends an Output_Failure's errors back to the model that produced the output document and asks for a corrected output document.
- **Attempt_Limits**: The configured per-Attempt limits: Max_Tool_Calls, Max_Bedrock_Turns, and Max_Schema_Repair_Turns.
- **Max_Tool_Calls**: The largest number of tool calls in one Attempt. Initial value: 4.
- **Max_Bedrock_Turns**: The largest number of Bedrock_Turns in one Attempt, not counting a Schema_Repair_Turn. Initial value: 2.
- **Max_Schema_Repair_Turns**: The largest number of Schema_Repair_Turns in one Attempt. Initial value: 1.
- **Model_Interface**: The single interface through which the Agent_Runtime calls Amazon Bedrock models.
- **Model_Config**: The configuration that maps each Agent to a Primary_Model and an Escalation_Model, each named by an Amazon Bedrock inference profile identifier that starts with `us.`.
- **Primary_Model**: The model an Agent uses for the first Attempt of an Agent_Run.
- **Escalation_Model**: The stronger model an Agent uses for the second Attempt of an Agent_Run.
- **Haiku-tier model**, **Sonnet-tier model**: A Claude Haiku-class and a Claude Sonnet-class model on Amazon Bedrock.
- **Model_Input**: All content the Agent_Runtime sends to a model in one Bedrock_Turn: instructions, Agent_Request payload, tool results, and earlier turn content.
- **Input_Detection**: One personal-data or credential entity that the Screening_Guardrail finds in a Model_Input.
- **Model-call timeout**: The configured time the Model_Interface waits for a model response to one Bedrock_Turn. Initial value: 120 seconds.
- **Screening timeout**: The configured time the Agent_Runtime waits for the Screening_Guardrail to return a result for one Model_Input. Initial value: 10 seconds.
- **Agent_Gateway**: The AgentCore_Gateway that Agents and the History_Check_Agent call for tools.
- **Gateway_Tool**: A tool registered on the Agent_Gateway.
- **Tool timeout**: The configured time the Agent_Gateway waits for a permitted Gateway_Tool call to return a result. Initial value: 30 seconds.
- **Tool error**: A result the Agent_Gateway returns when a permitted Gateway_Tool call fails or exceeds the Tool timeout, marked as distinct from a Tool_Policy denial.
- **validate-logic**: The read-only Gateway_Tool that runs the Schema_Validator on a supplied LogicModel and returns the Validation_Result.
- **diff-logic**: The read-only Gateway_Tool that returns the Logic_Differ's Difference for two snapshotHashes.
- **Spec_Store_Write**: The Gateway_Tool that stores one draft StructuredSpec for one changeId through the Snapshot_Store.
- **Spec_Reference**: The value Spec_Store_Write returns for a stored StructuredSpec: the changeId and the SHA-256 digest of the StructuredSpec's Canonical_Form.
- **Draft status**: The status that Spec_Store_Write gives a stored StructuredSpec, marking the StructuredSpec as an unapproved agent draft.
- **Snapshot_Store write timeout**: The configured time Spec_Store_Write waits for the Snapshot_Store to confirm a write. Initial value: 10 seconds.
- **Tool_Policy**: The AgentCore Policy (Cedar) policy set attached to the Agent_Gateway.
- **Allowed_Tool_List**: The set of Gateway_Tools that the Tool_Policy permits for one agent. Requirement 8 sets the lists for the Agents; the decision-memory-history-check spec sets the list for the History_Check_Agent.
- **Never_Available_Tools**: `approve-content`, `approve-deploy`, `deploy`, `verify-deploy`, `apply-change-plan`, `compile-config`, `cht-conf-build`, `run-synthetic-tests`, `write-xlsform`, and `write-tasksjs`.
- **Workload_Identity**: The AgentCore Identity workload identity of one Agent_Container.
- **AgentCore_Observability**: Amazon Bedrock AgentCore Observability, which sends OpenTelemetry traces to CloudWatch.
- **Agent-step span**: An AgentCore_Observability span that records one Agent_Run or one Attempt (Requirement 12).
- **Model-call span**: An AgentCore_Observability span that records one model call through the Model_Interface (Requirement 12).
- **Tool-call span**: An AgentCore_Observability span that records one tool call sent to the Agent_Gateway (Requirement 12).
- **Screening span**: An AgentCore_Observability span that records one Screening_Guardrail check of one Model_Input (Requirement 11).
- **Refusal record**: The AgentCore_Observability record of a Tool_Policy denial or an Agent_Gateway rejection.
- **Test gateway**: An AgentCore_Gateway separate from the Agent_Gateway, used only to test the Tool_Policy (Requirement 9).
- **AgentCore_Memory**: The AgentCore Memory long-term store defined by the decision-memory-history-check spec.
- **Decision_Log**: The append-only log of human decisions defined by the pipeline-orchestrator spec.
- **Gateway_Smoke_Test**: The post-deployment check that exercises the Agent_Gateway and Tool_Policy (Requirements 8 and 9).

## Requirements

### Requirement 1: Agent hosting and invocation

**User Story:** As a platform engineer, I want each agent in its own container on a portable framework, so that agents have no AWS-proprietary hosting dependency and one agent's failure stays contained.

#### Acceptance Criteria

1. THE Agent_Runtime SHALL run the Intake_Agent, the Drafting_Agent, and the Change_Planner_Agent on the Services_Instance in separate Agent_Containers, with no Agent_Container running more than one Agent.
2. THE Agent_Runtime SHALL be built on Strands Agents or another agent framework that runs as ordinary code inside the Agent_Container.
3. WHILE no AgentCore Runtime resource exists in the AWS account, THE Agent_Runtime SHALL complete Agent_Runs without calling any AgentCore Runtime endpoint.
4. WHEN the Pipeline_Orchestrator sends an Agent_Request to an Agent's Agent_Container, THE Agent_Runtime in that Agent_Container SHALL perform one Agent_Run for that Agent and return to the Pipeline_Orchestrator exactly one Agent_Result carrying the Agent_Request's changeId and runId.
5. IF an Agent_Request's changeId, runId, Tenant, or Agent payload is absent, null, or empty, THEN THE Agent_Runtime SHALL return an Agent_Failure that names each such field and carries whichever of the changeId and runId are present.
6. IF an Agent_Request's changeId, runId, Tenant, or Agent payload is absent, null, or empty, THEN THE Agent_Runtime SHALL make no Bedrock_Turn and no tool call for that Agent_Request.
7. THE Agent_Runtime SHALL return each LogicModel and ChangePlan only inside the Agent_Output sent to the Pipeline_Orchestrator.
8. THE Agent_Runtime SHALL store no LogicModel or ChangePlan in the Snapshot_Store.
9. IF, during an Agent_Run, a Bedrock_Turn fails with an error from Amazon Bedrock, a tool call cannot reach the Agent_Gateway, or the Agent's code raises an unhandled error, THEN THE Agent_Runtime SHALL end the Agent_Run, return an Agent_Failure stating which of these three errors occurred, and remain ready to accept the next Agent_Request.
10. THE Agent_Runtime SHALL start each Agent_Run with no model conversation content, tool results, output documents, or Attempt counts carried over from any earlier Agent_Run.
11. WHILE one Agent_Container is stopped, THE Agent_Runtime in each other Agent_Container SHALL continue to accept Agent_Requests and return Agent_Results.

### Requirement 2: Intake Agent

**User Story:** As a program officer, I want my guideline upload, pathway pick, or plain-language edit turned into a structured spec, so that the pipeline can draft from a precise request.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator sends the Intake_Agent an Agent_Request whose payload holds a Change_Request, THE Intake_Agent SHALL return exactly one Agent_Result, which is either an Agent_Output holding one StructuredSpec with a passing Validation_Result against the StructuredSpec_Schema or an Agent_Failure.
2. WHEN the Intake_Agent produces a StructuredSpec, THE Intake_Agent SHALL set the StructuredSpec's request kind equal to the Change_Request's Request_Type and the StructuredSpec's changeId equal to the Agent_Request's changeId.
3. WHEN the Intake_Agent processes a Change_Request whose Request_Type is `guideline_upload` or `pathway_pick`, THE Intake_Agent SHALL take the StructuredSpec's guideline name, guideline version, and pathway name from the Change_Request.
4. IF a Change_Request whose Request_Type is `guideline_upload` or `pathway_pick` lacks a guideline name, guideline version, or pathway name, THEN THE Intake_Agent SHALL return an Agent_Failure naming each missing value and make no Spec_Store_Write call.
5. WHEN a StructuredSpec produced by the Intake_Agent receives a passing Validation_Result, THE Intake_Agent SHALL call Spec_Store_Write exactly once in the Agent_Run, passing the Agent_Request's changeId and that StructuredSpec, before returning the Agent_Output.
6. WHEN Spec_Store_Write returns a Spec_Reference, THE Intake_Agent SHALL return an Agent_Output holding that Spec_Reference unchanged together with the same StructuredSpec that the Intake_Agent passed to Spec_Store_Write.
7. WHEN the Intake_Agent produces a StructuredSpec for a Change_Request whose Request_Type is `plain_language_edit`, THE Intake_Agent SHALL copy the edit text and the Base_Snapshot snapshotHash from the Change_Request into the StructuredSpec character for character.
8. IF Spec_Store_Write returns a conflict error, a failing Validation_Result, or any other error instead of a Spec_Reference, THEN THE Intake_Agent SHALL return an Agent_Failure stating the Spec_Store_Write error and, for a conflict error, holding the existing Spec_Reference that Spec_Store_Write returned.

### Requirement 3: Draft-only spec-store write

**User Story:** As a pipeline operator, I want the Intake Agent's only write to be an idempotent draft StructuredSpec, so that retries cause no duplicates and no agent can store anything else.

#### Acceptance Criteria

1. WHEN Spec_Store_Write receives a changeId with no stored draft StructuredSpec and a StructuredSpec that receives a passing Validation_Result from the Schema_Validator run by Spec_Store_Write against the StructuredSpec_Schema, THE Spec_Store_Write tool SHALL store the StructuredSpec with draft status for that changeId through the Snapshot_Store and return a Spec_Reference holding that changeId and the SHA-256 digest of the StructuredSpec's Canonical_Form.
2. IF the document supplied to Spec_Store_Write, including a LogicModel, a ChangePlan, or any other document that is not a StructuredSpec, receives a failing Validation_Result when Spec_Store_Write runs the Schema_Validator against the StructuredSpec_Schema, THEN THE Spec_Store_Write tool SHALL return that Validation_Result in place of a Spec_Reference or conflict error, store nothing, and leave any draft already stored for the changeId unchanged.
3. WHEN Spec_Store_Write receives a changeId and a StructuredSpec with a passing Validation_Result whose Canonical_Form equals the Canonical_Form of the draft already stored for that changeId, including a StructuredSpec that differs from the stored draft only in ways that Canonical_Form normalizes, THE Spec_Store_Write tool SHALL return the Spec_Reference of the stored draft, store no second copy, and leave the stored draft unchanged.
4. IF Spec_Store_Write receives a changeId and a StructuredSpec with a passing Validation_Result whose Canonical_Form differs from the Canonical_Form of the draft already stored for that changeId, THEN THE Spec_Store_Write tool SHALL return a conflict error holding the Spec_Reference of the stored draft, return no new Spec_Reference, store nothing, and leave the stored draft unchanged.
5. THE Spec_Store_Write tool SHALL write only StructuredSpecs with draft status, setting no other status on any StructuredSpec and writing no Snapshot, LogicModel, ChangePlan, approval, Decision_Log entry, AgentCore_Memory record, or configuration file.
6. FOR ALL StructuredSpecs with a passing Validation_Result and all valid changeIds, calling Spec_Store_Write two or more times in sequence with the same changeId and StructuredSpec SHALL leave the same stored state and return the same Spec_Reference as calling Spec_Store_Write once (idempotence property).
7. IF the changeId supplied to Spec_Store_Write is missing, empty, or not a valid changeId as defined by the logic-model-snapshots spec, THEN THE Spec_Store_Write tool SHALL return an error indicating an invalid changeId without running the Schema_Validator, return no Spec_Reference, and store nothing.
8. IF the Snapshot_Store returns an error or does not confirm the write within the configured Snapshot_Store write timeout (initial value: 10 seconds), THEN THE Spec_Store_Write tool SHALL return an error indicating the storage failure, return no Spec_Reference, and store no partially written draft for the changeId.
9. IF two or more Spec_Store_Write calls for the same changeId overlap in time, THEN THE Spec_Store_Write tool SHALL store at most one draft for that changeId, return that draft's Spec_Reference to every call whose StructuredSpec has the stored draft's Canonical_Form, and return a conflict error to every other call whose StructuredSpec has a passing Validation_Result.

### Requirement 4: Drafting / Clinical Review Agent

**User Story:** As a clinician, I want the drafted logic to flag every gap it cannot resolve, so that no ambiguity is resolved without me.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator sends the Drafting_Agent an Agent_Request holding a StructuredSpec, THE Drafting_Agent SHALL return an Agent_Result holding either a LogicModel whose `pathway` equals the StructuredSpec's pathway name or an Agent_Failure.
2. THE Drafting_Agent SHALL call `get-logic` only with the Base_Snapshot snapshotHash held in the Agent_Request's StructuredSpec.
3. WHEN the Agent_Request's StructuredSpec holds a Base_Snapshot snapshotHash, THE Drafting_Agent SHALL call `get-logic` with that snapshotHash before producing the Agent_Run's first output document.
4. WHEN the Drafting_Agent cannot determine a Rule's Condition comparison value, action, or Follow_Up `dueInDays` or `openForDays` value from the StructuredSpec without assuming a value, THE Drafting_Agent SHALL add a Flag of type `ambiguity` whose `text` contains the Rule id and names each undetermined value.
5. IF `get-logic` returns an error or no LogicModel for the Base_Snapshot snapshotHash held in the Agent_Request's StructuredSpec, THEN THE Drafting_Agent SHALL return an Agent_Failure that names the snapshotHash and holds no LogicModel.

### Requirement 5: Change Planner Agent

**User Story:** As a program officer, I want my plain-language edit turned into a structured change plan, so that deterministic code applies the edit and the edit goes through the same checks as a draft.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator sends the Change_Planner_Agent an Agent_Request whose StructuredSpec has Request_Type `plain_language_edit`, edit text, and a Base_Snapshot snapshotHash, THE Change_Planner_Agent SHALL return an Agent_Result holding either a ChangePlan whose changeId equals the Agent_Request's changeId and whose Base_Snapshot snapshotHash equals the StructuredSpec's Base_Snapshot snapshotHash, or an Agent_Failure.
2. WHEN the Change_Planner_Agent processes an Agent_Request, THE Change_Planner_Agent SHALL call `get-logic` with the StructuredSpec's Base_Snapshot snapshotHash before producing the first ChangePlan of the Agent_Run.
3. THE Change_Planner_Agent SHALL express every proposed edit as Change_Operations in the ChangePlan and return the ChangePlan as the only output document in the Agent_Output, leaving application of the ChangePlan to the Change_Plan_Applier and compilation to the cht-config-compiler spec.
4. IF a `modify` or `remove` Change_Operation targets an element id that is absent, under case-sensitive comparison, from the Base_Snapshot's list for the Change_Operation's target element kind (Input, Rule, or Flag), with the effect of the earlier Change_Operations of the ChangePlan in list order taken into account, THEN THE Agent_Runtime SHALL treat the ChangePlan as an Output_Failure and record an output-check error naming the Change_Operation's zero-based list position and target element id.
5. IF the edit text asks to modify or remove an element and identifies no Input, Rule, or Flag of the Base_Snapshot, or identifies two or more of them, THEN THE Change_Planner_Agent SHALL include an `add` Change_Operation for a Flag of type `ambiguity` whose text quotes the unmatched or multiply-matched part of the edit text and, for a multiple match, names each matching element id.
6. IF the edit text asks to modify or remove an element and identifies no Input, Rule, or Flag of the Base_Snapshot, or identifies two or more of them, THEN THE Change_Planner_Agent SHALL include no `modify` or `remove` Change_Operation for that part of the edit text.
7. IF the StructuredSpec in an Agent_Request to the Change_Planner_Agent has a Request_Type other than `plain_language_edit`, or lacks the edit text or the Base_Snapshot snapshotHash, THEN THE Agent_Runtime SHALL return an Agent_Failure stating the received Request_Type and each missing field, and make no model call and no tool call.
8. IF the `get-logic` call for the Base_Snapshot snapshotHash returns a not-found, integrity, or invalid-request error, or returns no LogicModel, THEN THE Agent_Runtime SHALL end the Agent_Run without a further model call or tool call and return an Agent_Failure stating the Base_Snapshot snapshotHash and the error kind.
9. IF the ChangePlan's changeId differs from the Agent_Request's changeId, or the ChangePlan's Base_Snapshot snapshotHash differs from the StructuredSpec's Base_Snapshot snapshotHash, THEN THE Agent_Runtime SHALL treat the ChangePlan as an Output_Failure and record an output-check error naming each mismatched field.
10. IF an `add` Change_Operation targets an element id that is already present, under case-sensitive comparison, in the Base_Snapshot's list for the Change_Operation's target element kind, with the effect of the earlier Change_Operations of the ChangePlan in list order taken into account, THEN THE Agent_Runtime SHALL treat the ChangePlan as an Output_Failure and record an output-check error naming the Change_Operation's zero-based list position and target element id.

### Requirement 6: Output validation and schema-repair loop

**User Story:** As a clinician, I want malformed agent output retried a bounded number of times and then handed to a person, so that the system never guesses a fix silently.

#### Acceptance Criteria

1. WHEN a Bedrock_Turn returns a model response that requests no tool call, THE Agent_Runtime SHALL treat the response as an output document, validate it with the Schema_Validator against the schema for the Agent's Output_Type (StructuredSpec_Schema, LogicModel_Schema, or ChangePlan_Schema), and apply the output checks for that Output_Type (Requirement 5 criteria 4, 9, and 10 for a ChangePlan, none for a LogicModel or a StructuredSpec) to each output document whose Validation_Result passes.
2. THE Agent_Runtime SHALL pass each output document to the Schema_Validator exactly as the model produced the document, adding, removing, renaming, defaulting, or type-converting no field.
3. IF an output document cannot be parsed as a document, for example because it is free text or truncated, THEN THE Agent_Runtime SHALL treat the output document as an Output_Failure whose errors state that the output document could not be parsed.
4. IF the first output document of the first Attempt is an Output_Failure, THEN THE Agent_Runtime SHALL make one Schema_Repair_Turn on the Primary_Model whose Model_Input holds every Validation_Result error and every output-check error of that Output_Failure and asks for a corrected output document.
5. IF the response to the Schema_Repair_Turn is an Output_Failure or requests a tool call, THEN THE Agent_Runtime SHALL withhold any requested tool call, end the first Attempt, and start a second Attempt for the same Agent_Request on the Agent's Escalation_Model from Model_Config, with the second Attempt's tool-call and Bedrock_Turn counts starting at zero.
6. IF the output document of the second Attempt is an Output_Failure, THEN THE Agent_Runtime SHALL end the Agent_Run with no Schema_Repair_Turn and no further tool call, and return an Agent_Failure whose failure reason states that the schema-repair loop was exhausted and that holds every Validation_Result and output-check error from both Attempts, each labeled with the inference profile identifier of the model that produced the failing output document.
7. WHEN an output document receives a passing Validation_Result and passes every output check for the Agent's Output_Type, THE Agent_Runtime SHALL make no further Schema_Repair_Turn or Attempt and return an Agent_Output holding the output document, the Model_Config inference profile identifier of the model that produced the document, and a value stating whether that model was the Escalation_Model.
8. IF the Schema_Validator or an output check returns an error instead of a Validation_Result or check outcome for an output document, THEN THE Agent_Runtime SHALL end the Agent_Run with no Schema_Repair_Turn and no second Attempt and return an Agent_Failure stating the validation error.
9. IF a Bedrock_Turn returns a model invocation error instead of a model response, THEN THE Agent_Runtime SHALL end the Agent_Run with no Schema_Repair_Turn and no second Attempt and return an Agent_Failure stating the inference profile identifier of the model and the error.
10. FOR ALL Agent_Runs, every Agent_Output SHALL hold an output document that received a passing Validation_Result and passed every output check for its Output_Type, and every Agent_Run SHALL make at most two Attempts and at most one Schema_Repair_Turn, made on the Primary_Model during the first Attempt (invariant).

### Requirement 7: Per-Attempt limits

**User Story:** As a platform engineer, I want hard limits on tool calls and model turns per attempt, so that a confused agent fails fast to a person instead of looping.

#### Acceptance Criteria

1. WHEN an Agent_Run starts, THE Agent_Runtime SHALL read the Attempt_Limits from configuration and apply those values to every Attempt of that Agent_Run, with initial configured values of 4 for Max_Tool_Calls, 2 for Max_Bedrock_Turns, and 1 for Max_Schema_Repair_Turns.
2. IF an Agent requests a tool call after the current Attempt has made Max_Tool_Calls tool calls, THEN THE Agent_Runtime SHALL withhold the tool call from the Agent_Gateway, end the Agent_Run with no further Bedrock_Turn and no further Attempt, and return an Agent_Failure naming the Max_Tool_Calls limit, its configured value, and the number (1 or 2) of the Attempt in which the limit was reached.
3. IF the response to an Attempt's Max_Bedrock_Turns-th Bedrock_Turn, not counting Schema_Repair_Turns, holds no output document, THEN THE Agent_Runtime SHALL withhold every tool call requested in that response, end the Agent_Run with no further Bedrock_Turn and no further Attempt, and return an Agent_Failure naming the Max_Bedrock_Turns limit, its configured value, and the number (1 or 2) of the Attempt in which the limit was reached.
4. THE Agent_Runtime SHALL count toward Max_Tool_Calls every tool call it sends to the Agent_Gateway, including tool calls that the Tool_Policy denies and tool calls that return an error or time out.
5. FOR ALL Agent_Runs, each Attempt SHALL make at most Max_Tool_Calls tool calls, at most Max_Bedrock_Turns Bedrock_Turns other than Schema_Repair_Turns, and at most Max_Schema_Repair_Turns Schema_Repair_Turns, using the Attempt_Limits values read at the start of that Agent_Run (invariant).
6. IF an Attempt_Limits value read at the start of an Agent_Run is missing, is not a whole number, or lies outside its allowed range (1 to 20 for Max_Tool_Calls, 1 to 10 for Max_Bedrock_Turns, and 1 to 3 for Max_Schema_Repair_Turns), THEN THE Agent_Runtime SHALL return an Agent_Failure naming each invalid limit and make no model call and no tool call.
7. WHEN the Agent_Runtime starts the second Attempt of an Agent_Run, THE Agent_Runtime SHALL count the second Attempt's tool calls, Bedrock_Turns, and Schema_Repair_Turns from zero, separately from the first Attempt's counts.
8. IF an Attempt has made Max_Schema_Repair_Turns Schema_Repair_Turns and the output document of the latest Schema_Repair_Turn is an Output_Failure, THEN THE Agent_Runtime SHALL make no further Schema_Repair_Turn in that Attempt.

### Requirement 8: Gateway tools and per-agent allow lists

**User Story:** As a security reviewer, I want every agent tool call to go through one gateway under a deny-by-default policy, so that each agent can reach only the tools its job needs.

#### Acceptance Criteria

1. THE Agent_Runtime SHALL send every tool call of an Agent to the Agent_Gateway carrying the Agent_Request's changeId and runId, making no direct call to the Snapshot_Store, the Schema_Validator, or the Logic_Differ.
2. THE Agent_Gateway SHALL register `get-logic`, `diff-logic`, `validate-logic`, and Spec_Store_Write as Gateway_Tools.
3. WHEN a permitted call to `get-logic`, `diff-logic`, or `validate-logic` completes, THE Agent_Gateway SHALL return the tool's result (the requested Snapshot for `get-logic`, the Difference for `diff-logic`, or the Validation_Result for `validate-logic`) to the Agent_Runtime and leave every stored Snapshot and StructuredSpec identical to its state before the call.
4. THE Tool_Policy SHALL identify the calling Agent by its Workload_Identity, deny every tool call that no permit statement matches, and permit only these Allowed_Tool_Lists: the Intake_Agent may call Spec_Store_Write; the Drafting_Agent may call `get-logic` and `validate-logic`; the Change_Planner_Agent may call `get-logic` and `diff-logic`.
5. THE Agent_Gateway SHALL evaluate the Tool_Policy in `ENFORCE` mode for every tool call before forwarding the call to the Gateway_Tool.
6. IF the Tool_Policy denies a tool call, THEN THE Agent_Gateway SHALL return to the Agent_Runtime a denial result naming the Gateway_Tool without forwarding the call to the tool, and record the denial in AgentCore_Observability with the Workload_Identity, the tool name, the changeId, the runId, and the UTC timestamp of the denial.
7. FOR ALL pairs of Agent and Gateway_Tool, evaluating the Tool_Policy SHALL return permit if and only if the Gateway_Tool is in the Agent's Allowed_Tool_List (model-based property).
8. WHEN the Agent_Gateway is deployed, THE Gateway_Smoke_Test SHALL call each of `get-logic`, `diff-logic`, `validate-logic`, and Spec_Store_Write once as each Agent, using synthetic arguments and a changeId reserved for the Gateway_Smoke_Test, and confirm that every call to a Gateway_Tool in the calling Agent's Allowed_Tool_List returns a non-error response, every other call returns a Tool_Policy denial, and the Tool_Policy is in `ENFORCE` mode.
9. IF a permitted call to a Gateway_Tool returns an error or returns no result within the configured tool timeout (initial value: 30 seconds), THEN THE Agent_Gateway SHALL return to the Agent_Runtime an error result that names the Gateway_Tool, states the error or the timeout, and marks the result as a tool error rather than a Tool_Policy denial.
10. IF any Gateway_Smoke_Test call returns a result other than the one criterion 8 expects, or the Tool_Policy is in any mode other than `ENFORCE`, THEN THE Gateway_Smoke_Test SHALL fail and name each Agent, Gateway_Tool, and check that did not pass.

### Requirement 9: Never-available tools

**User Story:** As a clinician and IT lead, I want approval, compile, build, test, and deploy operations out of every agent's reach in two independent ways, so that one misconfiguration cannot let an agent act on its own output.

#### Acceptance Criteria

1. THE Agent_Gateway SHALL register only Gateway_Tools whose names exactly match an entry in the Allowed_Tool_List of an Agent or the History_Check_Agent.
2. THE Agent_Gateway SHALL register no Never_Available_Tool.
3. THE Tool_Policy SHALL hold an explicit forbid for each of the Never_Available_Tools that applies to every caller of the Agent_Gateway, including every Agent and the History_Check_Agent, and that overrides any permit in the Tool_Policy.
4. FOR ALL Never_Available_Tools, all call arguments, and all callers (every Agent, the History_Check_Agent, and a caller with no Allowed_Tool_List), a call to the tool SHALL receive a deny decision from the Tool_Policy and run no tool, including on a test gateway, separate from the Agent_Gateway, that registers the tool and whose copy of the Tool_Policy also holds a permit for that tool and caller (independence property).
5. IF the registered tool list that the Gateway_Smoke_Test reads from the Agent_Gateway holds a Never_Available_Tool or a tool name that exactly matches no Allowed_Tool_List entry, THEN THE Gateway_Smoke_Test SHALL report a failing result naming every such tool.
6. WHEN the Agent_Gateway is deployed or the Tool_Policy changes, THE Gateway_Smoke_Test SHALL call each Never_Available_Tool once as each Agent through the Agent_Gateway with synthetic arguments and confirm that each call returns a denial or error response without running a tool and that AgentCore_Observability holds a refusal record with the caller's Workload_Identity and the tool name within 300 seconds of the call.
7. IF a Never_Available_Tool call made by the Gateway_Smoke_Test returns a success response, runs a tool, or has no refusal record in AgentCore_Observability within 300 seconds of the call, THEN THE Gateway_Smoke_Test SHALL report a failing result naming each Agent and Never_Available_Tool involved.
8. IF the Gateway_Smoke_Test cannot reach the Agent_Gateway, read its registered tool list, read the Tool_Policy, or query AgentCore_Observability, THEN THE Gateway_Smoke_Test SHALL report a failing result that names the step that could not complete.
9. IF the Tool_Policy holds a permit that names a Never_Available_Tool for any caller, THEN THE Gateway_Smoke_Test SHALL report a failing result naming the tool and the caller.

### Requirement 10: Workload identity and write boundaries

**User Story:** As a security reviewer, I want each agent container to have its own short-lived identity and no write path to approvals, logs, or memory, so that a compromised agent cannot approve, deploy, or rewrite history.

#### Acceptance Criteria

1. THE Agent_Runtime SHALL attach to every Agent_Gateway call an unexpired token for the Workload_Identity of the calling Agent_Container.
2. THE Agent_Container SHALL hold a Workload_Identity that no other Agent_Container and no other container on the Services_Instance holds.
3. THE Agent_Container SHALL obtain every credential as a token that expires no more than 3600 seconds after issue, with no AWS access key, API key, CHT credential, or other credential lacking such an expiry present in the container image, environment variables, or file system.
4. IF an Agent_Gateway call carries no Workload_Identity token, or carries a token that is expired or fails verification against AgentCore Identity, THEN THE Agent_Gateway SHALL reject the call without running a tool, return an authentication error to the caller, and record the rejection in AgentCore_Observability with the tool name and the time.
5. THE Agent_Container's permissions SHALL be limited to obtaining tokens for its own Workload_Identity, invoking the Primary_Model and Escalation_Model that Model_Config maps to its Agent, applying the Screening_Guardrail, calling the Agent_Gateway, and sending new traces to AgentCore_Observability, with every other AWS action from the Agent_Container denied.
6. THE Agents SHALL write stored data, other than traces sent to AgentCore_Observability, only through Spec_Store_Write calls that the Intake_Agent makes for the Agent_Request's changeId.
7. THE Agents SHALL add, change, or delete no approval, Decision_Log entry, or AgentCore_Memory record.
8. THE Agent_Gateway SHALL evaluate the Tool_Policy for each call against the Agent that owns the call's verified Workload_Identity, ignoring any agent name or identity claimed in tool arguments or other call content.
9. THE Agent_Container SHALL hold no permission to read the CHT credential, obtain the Services_Instance's IAM instance-role credentials, send a result to a Pipeline_Orchestrator approval wait, read or write the Snapshot_Store, approvals, the Decision_Log, or AgentCore_Memory other than through a Gateway_Tool, or delete or change traces recorded in AgentCore_Observability.
10. THE Agent_Runtime SHALL exclude every Workload_Identity token and other credential value from Model_Inputs, tool arguments, Agent_Results, and traces sent to AgentCore_Observability.
11. IF the Agent_Gateway rejects a call for a missing, expired, or unverifiable Workload_Identity token, THEN THE Agent_Runtime SHALL end the Agent_Run without making any further model call or tool call and return an Agent_Failure stating the authentication failure.

### Requirement 11: Input screening

**User Story:** As a data protection officer, I want every model input screened for personal data before a model sees it, so that no real patient data or credentials reach a prompt or trace.

#### Acceptance Criteria

1. WHEN the Agent_Runtime prepares the Model_Input for any Bedrock_Turn, including a Schema_Repair_Turn and every Bedrock_Turn of the second Attempt, THE Agent_Runtime SHALL screen the complete Model_Input (instructions, Agent_Request payload, tool results, and earlier turn content) with the Screening_Guardrail and send the Model_Input to the model only after the Screening_Guardrail returns zero Input_Detections for that Model_Input.
2. IF the Screening_Guardrail reports one or more Input_Detections in a Model_Input, THEN THE Agent_Runtime SHALL send neither the Model_Input nor a masked or redacted version of the Model_Input to any model, make no further model call or tool call, start no second Attempt, end the Agent_Run, and return an Agent_Failure whose failure reason states that input screening found personal data or credentials and that lists, for each Input_Detection, the entity type reported by the Screening_Guardrail and the part of the Model_Input where the Input_Detection occurred, given as instructions, Agent_Request payload, tool result with the Gateway_Tool name, or earlier turn content.
3. IF the Screening_Guardrail call returns an error, returns a malformed result, or returns no result within the screening timeout read from configuration (initial value: 10 seconds), THEN THE Agent_Runtime SHALL send the Model_Input to no model, retry neither the screening call nor the Bedrock_Turn, start no second Attempt, end the Agent_Run, and return an Agent_Failure whose failure reason states that input screening could not complete and whether the cause was an error, a malformed result, or a timeout, with no Model_Input content in the Agent_Failure.
4. IF the Screening_Guardrail reports an Input_Detection, THEN THE Agent_Runtime SHALL record each Input_Detection in AgentCore_Observability traces, in logs written by the Agent_Runtime, and in the Agent_Failure only as its entity type and the part of the Model_Input where it occurred, excluding the detected value in full or in part and all other Model_Input content.
5. THE Agent_Runtime SHALL write no part of a Model_Input to AgentCore_Observability traces or to logs written by the Agent_Runtime until the Screening_Guardrail has returned zero Input_Detections for that Model_Input.
6. WHEN the Agent_Runtime finishes screening a Model_Input, THE Agent_Runtime SHALL record one screening span in AgentCore_Observability carrying the changeId, the runId, the Attempt number, the sequence number of the Bedrock_Turn within the Agent_Run, the outcome (passed, detection, or screening error), and the count of Input_Detections.
7. FOR ALL Agent_Runs, each Model_Input sent to a model SHALL be identical to a Model_Input for which the Screening_Guardrail returned zero Input_Detections earlier in the same Agent_Run, and the number of screening spans with outcome passed SHALL equal the number of Bedrock_Turns made (invariant).

### Requirement 12: Model interface and tracing

**User Story:** As a platform engineer, I want models chosen by configuration behind one interface and every agent step traced per change, so that we can swap models without code changes and see cost and behavior for each run.

#### Acceptance Criteria

1. THE Agent_Runtime SHALL make every model call of every Agent through the Model_Interface, including each Schema_Repair_Turn and each call on an Escalation_Model.
2. WHEN Model_Config changes, THE Model_Interface SHALL use the changed Primary_Model and Escalation_Model for every Agent_Run that starts after the Agent_Runtime loads the changed Model_Config, keep the previously loaded models for both Attempts of any Agent_Run already in progress, and require no change to Agent_Runtime code or to the Agent_Container image.
3. IF the Model_Config that the Agent_Runtime loads lacks a Primary_Model or an Escalation_Model for an Agent, or names a model identifier that is not an Amazon Bedrock inference profile identifier starting with `us.`, THEN THE Agent_Runtime SHALL refuse to start, make no model call, and report each missing or invalid entry by Agent name, model role (Primary_Model or Escalation_Model), and identifier.
4. THE Model_Config SHALL hold initial values that name a Haiku-tier model as the Primary_Model of the Intake_Agent, the Drafting_Agent, and the Change_Planner_Agent, and a Sonnet-tier model as the Escalation_Model of each of these three Agents.
5. THE Model_Interface SHALL tag every model call, including each Schema_Repair_Turn and each call that returns an error, with the name of the Agent making the call and with the Tenant and the runId from that Agent_Run's Agent_Request.
6. WHEN a model call through the Model_Interface ends, THE Agent_Runtime SHALL record in AgentCore_Observability one model-call span that carries the changeId, the runId, the Agent name, the Tenant, the model identifier, and whether the call returned a response or an error, plus the input token count and output token count reported by Amazon Bedrock for a call that returned a response.
7. FOR ALL Agent_Runs, the number of model-call spans SHALL equal the number of Bedrock_Turns made, counting each Schema_Repair_Turn and each model call that returned an error or timed out and counting no Model_Input withheld by the Screening_Guardrail, and every model-call span SHALL carry the changeId, the runId, the Agent name, and the Tenant of that Agent_Run (invariant).
8. IF a model call through the Model_Interface returns an error or returns no response within the configured model-call timeout (initial value: 120 seconds), THEN THE Agent_Runtime SHALL end the Agent_Run without starting a further Attempt and return an Agent_Failure stating the model identifier and the error.
9. WHEN a tool call ends, THE Agent_Runtime SHALL record in AgentCore_Observability one tool-call span that carries the changeId, the runId, the Agent name, the Tenant, the tool name, and one outcome out of succeeded, returned an error, or denied by the Tool_Policy.
10. WHEN an Agent_Run ends, THE Agent_Runtime SHALL record in AgentCore_Observability one agent-step span for the Agent_Run and one agent-step span for each Attempt made, each carrying the changeId, the runId, the Agent name, and the Tenant, with the Agent_Run span stating whether the Agent_Result is an Agent_Output or an Agent_Failure and each Attempt span stating the Attempt number (1 or 2) and the model identifier used.

## Open Questions

1. **Escalated Attempt repair turn.** This spec reads §6 and §7 as: first output on the Primary_Model, one Schema_Repair_Turn on the same model, then one output on the Escalation_Model, after which a failure ends the Agent_Run. Should the escalated Attempt also get its own Schema_Repair_Turn?
2. **Turn counting.** This spec counts the Schema_Repair_Turn outside Max_Bedrock_Turns. Should it count inside the limit of 2?
3. **Escalation_Model for every Agent.** The design names a Sonnet-tier escalation model only for the Drafting_Agent. This spec assumes a Sonnet-tier Escalation_Model for every Agent, including the Intake_Agent and the Change_Planner_Agent (Requirement 12.4). Please confirm.
4. **Spec_Store_Write conflict.** When a different StructuredSpec arrives for a changeId that already has a draft, should Spec_Store_Write reject it (this spec's choice) or store a new draft version?
5. **Scope of `validate-logic`.** Does `validate-logic` run only the Schema_Validator (this spec's choice) or also the state-4 logic checks?
6. **Tenant and runId.** The design names neither. Is runId the Step Functions execution id or a per-agent-invocation id, and what does Tenant identify in a single-deployment demo?
7. **Guideline input.** With the knowledge base removed, the Intake_Agent and Drafting_Agent have no defined way to read guideline text. The clinician checks drafted logic against the guideline at content approval. Decide whether guideline text reaches the agents at all, and how.
