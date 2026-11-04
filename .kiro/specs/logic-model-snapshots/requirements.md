# Requirements Document

## Introduction

Vera turns a public clinical guideline, or a plain-language change request, into tested, approved Community Health Toolkit (CHT) configuration. This spec covers the data foundation every other Vera component reads from: the `StructuredSpec`, `LogicModel`, and `ChangePlan` schemas; validation of every model output and human edit against those schemas; the `snapshotHash` that approvals bind to; and append-only, versioned storage of snapshots in S3, indexed in DynamoDB.

One LogicModel snapshot is the single source of truth. The approver view, the logic checks, the compiler, and the expected test outcomes all read the same stored snapshot (design rule 5). An approval binds to one exact `snapshotHash`, never to a conversation (rule 4). AI drafts, human edits, and applied change plans all produce new snapshots through the same validation (rule 3). Snapshots hold pathway logic only, with no patient data (rule 8), and every stored snapshot stays retrievable so any change can be reversed (rule 10).

Source: Solution Design §10, with related rules in §3, §6, §7, §11, and §14.

### Dependencies and scope boundaries

This spec defines the data contracts and the storage service. The following concerns belong to other specs and are referenced here only as dependencies:

| Concern | Owning spec |
|---|---|
| Producing StructuredSpec, LogicModel, and ChangePlan with agents; the schema-repair loop; exposing `get-logic`, `diff-logic`, and `validate-logic` on AgentCore Gateway; Cedar policy | authoring-agents |
| Completeness, exclusivity, reachability, and catch-all checks; golden cases and the golden-case version | logic-checks-golden-cases |
| State machine, lifecycle states, the open-ambiguity gate on `content_review`, approval records, decision log, rollback | pipeline-orchestrator |
| Rendering the approver view, separation-of-duties enforcement, the hand-edit screen | review-ui-approvals |
| Compiling a snapshot into XLSForm and `tasks.js`, including splitting a rule's follow-up between form and task | cht-config-compiler |
| Building, running synthetic patients, computing expected outcomes from the snapshot | build-test-sandbox |
| Refusing to deploy non-release builds at deploy time | cht-deployer |
| Rule fingerprints and the rejected-rule check | rejected-rule-check |
| The S3 bucket, KMS key, DynamoDB tables, IAM roles, and Bedrock Guardrails | platform-infrastructure |

## Glossary

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **CHT**: Community Health Toolkit.
- **StructuredSpec**: The structured form of a request (guideline upload, pathway pick, or plain-language edit), produced by the Intake Agent.
- **LogicModel**: The structured JSON definition of one pathway's logic: `snapshotId`, `snapshotHash`, `pathway`, `guideline`, `inputs`, `rules`, and `flags` (§10).
- **ChangePlan**: A structured list of Change_Operations, proposed by the Change Planner Agent, that modifies an existing Snapshot.
- **Change_Operation**: One entry in a ChangePlan that adds, modifies, or removes one Input, Rule, or Flag, identified by element id.
- **Snapshot**: One immutable LogicModel stored by the Snapshot_Store, together with the Snapshot's Snapshot_Record.
- **Snapshot_Record**: The DynamoDB index entry that describes one Snapshot.
- **Snapshot submission**: A request to the Snapshot_Store to store one LogicModel, carrying the LogicModel, the LogicModel's Hash_Inputs, the `changeId`, the Author, the Origin, the Designation, and, for a Snapshot with a Base_Snapshot, the parent snapshotHash.
- **Base_Snapshot**: The existing Snapshot that a human edit or ChangePlan modifies.
- **snapshotId**: The human-readable identifier of a Snapshot, for example `child-cough-v3`.
- **snapshotHash**: The SHA-256 digest of a Snapshot's Hash_Inputs. Approvals bind to the snapshotHash.
- **Hash_Inputs** (also **Snapshot_Bundle**): The document hashed into a snapshotHash, implemented as `snapshotBundleSchema` in `packages/workflow-data/src/model.ts`. It has exactly seven parts: Schema_Version, Baseline, Full_Specification, Evidence_Versions, Prompt_Context_Refs, Golden_Case_Version, and Toolchain_Identity.
- **Schema_Version**: The `schemaVersion` string of the Snapshot_Bundle format.
- **Baseline**: The `baselineRevision` string naming the configuration a change starts from. The design names this component without defining what it points to (see Open Questions).
- **Full_Specification**: The `spec` object of the Snapshot_Bundle, holding the pathway logic, including its `rules`. The snapshotHash is never part of it.
- **Evidence_Versions**: The `evidenceVersions` list of one or more source entries, each holding exactly a `sourceId`, a `version`, the SHA-256 digest of the source bytes (`sha256`), and the S3 reference of the exact stored source version (`sourceS3Ref`).
- **Prompt_Context_Refs**: The `retrievalEvidenceRefs` list of S3 references to the exact prompt context (full guideline text or curated primer) given to a model. The field keeps its legacy name so the hash format did not change when retrieval was removed. It may be empty when a Snapshot is created but must be non-empty before content review opens.
- **Golden_Case_Version**: The `goldenCaseVersion` string identifying the golden-case set, supplied by the logic-checks-golden-cases spec.
- **Toolchain_Identity**: The `compilerVersion` string and the `toolchainImageDigest`, the `sha256:` digest of the pinned `medicmobile/cht-app-ide` image used to compile and build the Snapshot.
- **Input**: A question the pathway asks, with an `id`, a `type`, and a `label`.
- **Input-type enumeration**: The fixed set of allowed Input `type` values defined in the LogicModel_Schema. The set contains at least `integer` and `yes_no`; the full set is fixed when the schema is locked (see Open Question 5).
- **Rule**: One LogicModel entry holding an `id`, a Condition (`when`), an action (`then`), an optional Follow_Up (`followUp`), and an optional Source (`source`).
- **Condition**: The `when` part of a Rule: either an `all` list of comparisons against Inputs, or `otherwise: true`.
- **Comparison**: One entry in a Condition's `all` list, holding one Input `id` (`input`), exactly one Comparison operator, and one value.
- **Comparison operator**: The operator in a Comparison, taken from the enumerated set of comparison operators defined in the LogicModel_Schema. The set contains at least `eq`; the full set is fixed when the schema is locked (see Open Question 5).
- **Action**: The `then` part of a Rule, holding exactly one `action` value.
- **Follow_Up**: The follow-up timing of a Rule: `dueInDays` and `openForDays`.
- **Source**: A citation to a guideline passage: `section` and `page`.
- **Flag**: A recorded gap or ambiguity for a person to resolve, with a `type`, a `text`, and an optional Source.
- **Flag-type enumeration**: The fixed set of allowed Flag `type` values defined in the LogicModel_Schema. The set contains at least `ambiguity`.
- **Origin**: How a Snapshot was produced: `agent_draft`, `human_edit`, or `change_plan`.
- **Author**: The authenticated identity of the person who submitted the request or edit that produced a Snapshot.
- **Designation**: Whether a Snapshot is a `release` Snapshot, eligible for deployment, or a `preview` Snapshot, used only for before/after edit comparisons and never deployable (§11).
- **Canonical_Form**: The single byte representation of a LogicModel, StructuredSpec, ChangePlan, or Hash_Inputs document produced by the Canonical_Serializer.
- **Validation_Result**: The output of the Schema_Validator: pass or fail, a list of errors (each with a JSON path and a description).
- **JSON path**: The location of one element or property within a document, measured from the document root.
- **changeId**: The identifier of one change request as it moves through the pipeline.
- **Consumer**: Any component that reads a Snapshot: the approver view, the logic checks, the compiler, the test harness, and agents through `get-logic`.
- **get-logic**: The read-only operation, exposed to agents on AgentCore Gateway by the authoring-agents spec, that returns a Snapshot's LogicModel content by snapshotHash.
- **Pipeline_Orchestrator**: The Step Functions state machine and its workers, defined in the pipeline-orchestrator spec.
- **Artifact_Bucket**: The private, versioned, SSE-KMS-encrypted S3 bucket listed in §14, provisioned by the platform-infrastructure spec.
- **Index_Table**: The DynamoDB table that indexes Snapshots and StructuredSpecs. §14 lists `Changes` (partition key `changeId`) as the pipeline-state table for this purpose.
- **Schema_Validator**: The component that validates a StructuredSpec, LogicModel, or ChangePlan against the corresponding schema (Zod or Ajv, per §10).
- **LogicModel_Schema**, **StructuredSpec_Schema**, **ChangePlan_Schema**: The shared schema definitions for each document type.
- **Canonical_Serializer**: The component that converts a document into Canonical_Form.
- **Snapshot_Parser**: The component that converts Canonical_Form bytes back into a document.
- **Hash_Calculator**: The component that computes a snapshotHash from Hash_Inputs.
- **Snapshot_Store**: The write path of the Snapshot_Service, which persists Snapshots and StructuredSpecs.
- **Snapshot_Service**: The component that validates, hashes, stores, retrieves, lists, and compares Snapshots.
- **Integrity check**: The read-time check in Requirement 10.1 that recomputes a Snapshot's snapshotHash from the stored snapshot object and the recorded Hash_Inputs components and compares the result with the requested snapshotHash and the stored LogicModel's `snapshotHash` field.
- **Change_Plan_Applier**: The deterministic code that applies a ChangePlan to a Base_Snapshot (the `apply-change-plan` operation, which no agent can call).
- **Logic_Differ**: The component that compares two Snapshots (the `diff-logic` operation).
- **Difference**: The output of the Logic_Differ for a first and a second Snapshot: the added, removed, and modified Inputs, Rules, and Flags; any change to the `pathway` or `guideline` fields; and any order change in the `inputs`, `rules`, or `flags` lists.

## Requirements

### Requirement 1: Single source of truth

**User Story:** As a clinician, I want the logic I approve to be exactly the logic that is compiled and tested, so that my approval covers what actually ships.

#### Acceptance Criteria

1. THE Snapshot_Service SHALL identify every Snapshot by the Snapshot's snapshotHash, with each snapshotHash identifying at most one Snapshot.
2. WHEN a Consumer requests a Snapshot by a snapshotHash that has a Snapshot_Record and passes the integrity check in Requirement 10, THE Snapshot_Service SHALL return the Canonical_Form bytes stored for that snapshotHash, unaltered from the bytes written when the Snapshot was created.
3. THE Snapshot_Service SHALL return byte-identical content for every read of the same snapshotHash, regardless of which Consumer makes the request and of when the read occurs.
4. THE Snapshot_Service SHALL serve the approver view, the logic checks, the compiler, the test harness, and agents calling the `get-logic` operation through the same read-by-snapshotHash operation.
5. IF a requested snapshotHash is not a string of exactly 64 lowercase hexadecimal characters, THEN THE Snapshot_Service SHALL reject the request with an error indicating a malformed snapshotHash and return no Snapshot content.
6. IF a request for a Snapshot's LogicModel content identifies the Snapshot by snapshotId or `changeId` instead of by snapshotHash, THEN THE Snapshot_Service SHALL reject the request with an error indicating that a snapshotHash is required and return no LogicModel content.

### Requirement 2: LogicModel schema

**User Story:** As a developer, I want one strict schema for pathway logic, so that every component agrees on what a LogicModel contains.

#### Acceptance Criteria

1. THE LogicModel_Schema SHALL require the fields `snapshotId`, `snapshotHash`, `pathway`, `guideline`, `inputs`, `rules`, and `flags`, where `snapshotId` is a string of 1 to 128 characters, `snapshotHash` is a string of exactly 64 lowercase hexadecimal characters, `pathway` is a string of 1 to 200 characters, `inputs` is a list of 1 to 200 Inputs, `rules` is a list of 1 to 200 Rules, and `flags` is a list of 0 to 200 Flags.
2. THE LogicModel_Schema SHALL require the `guideline` field to contain a guideline name of 1 to 300 characters and a guideline version of 1 to 50 characters.
3. THE LogicModel_Schema SHALL require each Input to contain an `id` of 1 to 64 characters, a `type`, and a `label` of 1 to 500 characters.
4. THE LogicModel_Schema SHALL restrict each Input `type` to exactly one value from the input-type enumeration defined in the LogicModel_Schema, which contains at least the values `integer` and `yes_no`.
5. IF two or more Inputs in one LogicModel have `id` values that are identical under case-sensitive comparison, THEN THE Schema_Validator SHALL reject the LogicModel and report, in the Validation_Result, each duplicate `id` together with the JSON path of every Input that carries it.
6. THE LogicModel_Schema SHALL require each Flag to contain a `type` holding exactly one value from the flag-type enumeration defined in the LogicModel_Schema, which contains at least the value `ambiguity`, and a `text` of 1 to 2,000 characters.
7. THE LogicModel_Schema SHALL permit each Flag to carry an optional Source that, when present, conforms to the same Source definition that applies to Rule Sources.
8. IF a LogicModel omits a field required by criteria 1, 2, 3, or 6, or contains a string length or list count outside the bounds set in those criteria, THEN THE Schema_Validator SHALL reject the LogicModel and report, in the Validation_Result, the JSON path of each missing or out-of-bounds field.
9. IF an Input `type` or a Flag `type` holds a value outside the corresponding enumeration in the LogicModel_Schema, THEN THE Schema_Validator SHALL reject the LogicModel and report, in the Validation_Result, the JSON path and the rejected value of each such `type`.
10. THE Schema_Validator SHALL measure the string lengths bounded in this requirement in Unicode code points, treating a string that contains only whitespace characters as having length 0.

### Requirement 3: Rules stored once as condition, action, and follow-up

**User Story:** As a clinician, I want each rule to appear once with its condition, action, and follow-up together, so that the form logic and the task logic cannot drift apart.

#### Acceptance Criteria

1. THE LogicModel_Schema SHALL represent each Rule as one entry in the LogicModel's `rules` list containing an `id` (a string of 1 to 64 characters that is not only whitespace), a Condition (`when`), an action (`then`), an optional Follow_Up (`followUp`), and an optional Source (`source`).
2. IF a LogicModel carries follow-up timing (`followUp`, `dueInDays`, or `openForDays`) anywhere other than in a Rule's Follow_Up, including on an Input, a Flag, a Condition, an action, or the LogicModel top level, THEN THE Schema_Validator SHALL reject the LogicModel and report the JSON path of each misplaced follow-up timing property.
3. THE LogicModel_Schema SHALL require each Follow_Up to contain both `dueInDays` and `openForDays`, each as an integer from 0 to 365 inclusive.
4. THE LogicModel_Schema SHALL require each Condition to take exactly one of two forms: an `all` list of 1 to 20 comparisons against Inputs, or `otherwise` with the value `true`.
5. THE LogicModel_Schema SHALL require each Source to contain a guideline `section` as a string of 1 to 200 characters that is not only whitespace, and a `page` as an integer from 1 to 10,000 inclusive.
6. IF two or more Rules in one LogicModel have the same `id` (exact, case-sensitive match), THEN THE Schema_Validator SHALL reject the LogicModel and report the duplicate `id`.
7. IF a Condition comparison references an Input `id` that the LogicModel's `inputs` do not declare, THEN THE Schema_Validator SHALL reject the LogicModel and report the Rule `id` and each undeclared Input `id`.
8. IF a Condition comparison value is not a valid value for the referenced Input's `type` (for an Input of `type` `yes_no`, any value other than `yes` or `no`; for an Input of `type` `integer`, any value that is not a JSON integer), THEN THE Schema_Validator SHALL reject the LogicModel and report the Rule `id` and the Input `id`.
9. THE LogicModel_Schema SHALL require each Rule's action (`then`) to contain exactly one `action` value as a string of 1 to 64 characters that is not only whitespace.
10. THE LogicModel_Schema SHALL require each comparison in an `all` list to contain one Input `id` (`input`) and exactly one comparison operator with one value, where the operator comes from an enumerated set of comparison operators that includes `eq`.
11. IF a Condition contains both `all` and `otherwise`, contains neither, has an `all` list with 0 or more than 20 comparisons, or has an `otherwise` value other than `true`, THEN THE Schema_Validator SHALL reject the LogicModel and report the Rule `id` and the JSON path of the Condition.

### Requirement 4: StructuredSpec schema and storage

**User Story:** As a program officer, I want my request turned into a structured, stored spec, so that drafting starts from a recorded, checkable request.

#### Acceptance Criteria

1. THE StructuredSpec_Schema SHALL require exactly one request kind, with a value of `guideline_upload`, `pathway_pick`, or `plain_language_edit`.
2. THE StructuredSpec_Schema SHALL require the `changeId` as a non-empty string of at most 128 characters, the pathway name as a string of 1 to 200 characters, the guideline name as a string of 1 to 300 characters, and the guideline version as a non-empty string of at most 50 characters.
3. IF a StructuredSpec with request kind `plain_language_edit` lacks the Base_Snapshot's snapshotHash, lacks the edit text, or has edit text that is empty or contains only whitespace, THEN THE Schema_Validator SHALL reject the StructuredSpec and report the JSON path of each missing or empty field.
4. THE StructuredSpec_Schema SHALL limit StructuredSpec content to the request kind, `changeId`, pathway name, guideline name and version, an optional Base_Snapshot snapshotHash of exactly 64 lowercase hexadecimal characters, and optional edit text of 1 to 4,000 characters.
5. WHEN a StructuredSpec that passes validation is submitted, THE Snapshot_Store SHALL write the StructuredSpec's Canonical_Form to the Artifact_Bucket with SSE-KMS encryption and then write a record to the Index_Table under the StructuredSpec's `changeId`, the record containing the request kind, the creation timestamp, and the S3 object version identifier.
6. WHEN a StructuredSpec is submitted whose Canonical_Form is byte-identical to a StructuredSpec already stored and indexed for the same `changeId`, THE Snapshot_Store SHALL return the existing record and create no additional object or record.
7. WHEN the Snapshot_Store stores a StructuredSpec whose Canonical_Form differs from every StructuredSpec already stored for the same `changeId`, THE Snapshot_Store SHALL leave every earlier StructuredSpec object and record for that `changeId` unchanged.
8. IF a submitted StructuredSpec fails validation, THEN THE Snapshot_Store SHALL reject the submission, return the Validation_Result, and write no object to the Artifact_Bucket and no record to the Index_Table.
9. IF a submitted StructuredSpec with request kind `plain_language_edit` carries a Base_Snapshot snapshotHash that identifies no stored Snapshot, THEN THE Snapshot_Store SHALL reject the submission, report the unmatched snapshotHash, and write no object or record.
10. IF the StructuredSpec object write to the Artifact_Bucket or the record write to the Index_Table fails, THEN THE Snapshot_Store SHALL return a storage error identifying the failed write and return no StructuredSpec record.
11. WHEN a StructuredSpec is resubmitted after a failed Index_Table record write, THE Snapshot_Store SHALL write the missing record without writing a second StructuredSpec object, leaving exactly one object and one record for that StructuredSpec under the `changeId`.

### Requirement 5: ChangePlan schema

**User Story:** As a program officer, I want my plain-language edit expressed as a structured change plan, so that code, not a model, applies the change.

#### Acceptance Criteria

1. THE ChangePlan_Schema SHALL require the `changeId` as a non-empty string of at most 128 characters and the snapshotHash of the Base_Snapshot the ChangePlan modifies as a 64-character lowercase hexadecimal string.
2. THE ChangePlan_Schema SHALL require an ordered list of at least 1 and at most 100 Change_Operations.
3. THE ChangePlan_Schema SHALL require each Change_Operation to state exactly one operation kind from `add`, `modify`, or `remove`, exactly one target element kind from Input, Rule, or Flag, and a non-empty target element `id`.
4. THE ChangePlan_Schema SHALL require each `add` and `modify` Change_Operation to carry exactly one complete new element of the Change_Operation's target element kind, containing every field that the LogicModel_Schema requires for that element kind.
5. WHEN the Schema_Validator validates a ChangePlan, THE Schema_Validator SHALL validate the new element in each `add` and `modify` Change_Operation against the LogicModel_Schema definition for that element kind (the element's own fields, field types, and enumerated values), and report each failure with a JSON path that includes the Change_Operation's zero-based position in the list.
6. THE ChangePlan_Schema SHALL limit ChangePlan content to the `changeId`, the Base_Snapshot snapshotHash, and the Change_Operations.
7. THE ChangePlan_Schema SHALL prohibit each `remove` Change_Operation from carrying a new element.
8. IF a ChangePlan lacks the `changeId`, the Base_Snapshot snapshotHash, or the Change_Operations list, or the list holds fewer than 1 or more than 100 Change_Operations, THEN THE Schema_Validator SHALL reject the ChangePlan and report each missing field or the out-of-bounds list length.
9. IF the new element in an `add` or `modify` Change_Operation has an `id` different from the Change_Operation's target element `id`, THEN THE Schema_Validator SHALL reject the ChangePlan and report the Change_Operation's zero-based position, the target element `id`, and the new element's `id`.

### Requirement 6: Validation of every model output and human edit

**User Story:** As an IT lead, I want every model output and human edit checked against the schema before anything uses it, so that malformed content cannot reach a gate, the compiler, or a clinician.

#### Acceptance Criteria

1. WHEN an agent produces a StructuredSpec, LogicModel, or ChangePlan, THE Schema_Validator SHALL validate the output against the corresponding StructuredSpec_Schema, LogicModel_Schema, or ChangePlan_Schema and return a Validation_Result before the output is passed to the Snapshot_Store, the Change_Plan_Applier, or any Consumer.
2. WHEN a human edit to a LogicModel is submitted, THE Schema_Validator SHALL validate the complete edited LogicModel, including every element the edit did not change, against the LogicModel_Schema with the same checks applied to agent output, including the duplicate-id, undeclared-Input, and Condition comparison value checks defined in Requirements 2 and 3.
3. THE Schema_Validator SHALL return, for a given document, a Validation_Result with the same pass or fail status, the same errors in the same order on every validation of that document, regardless of the document's Origin.
4. IF a document contains a property that the document's schema does not define, at any nesting level including inside Inputs, Rules, Conditions, Follow_Ups, Sources, Flags, and Change_Operations, THEN THE Schema_Validator SHALL reject the document and report the JSON path of each undefined property.
5. IF a document fails validation, THEN THE Schema_Validator SHALL return a Validation_Result with status fail that lists every error found in the document, not only the first, each with the JSON path of the failing element measured from the document root and a description of the failure.
6. THE Schema_Validator SHALL leave the validated document unmodified, converting no value to a different type, inserting no default value, and removing no property, so that the document's Canonical_Form is byte-identical before and after validation.
7. THE Schema_Validator SHALL load each schema from the single shared schema definition that every Vera component validates against, so that any two Vera components that validate the same document obtain identical Validation_Results.
8. WHEN validation of a document finds no errors, THE Schema_Validator SHALL return a Validation_Result with status pass and an empty error list.
9. IF an agent-produced StructuredSpec, LogicModel, or ChangePlan fails validation, THEN THE Snapshot_Service SHALL store no StructuredSpec or Snapshot from the output, pass the output to neither the Change_Plan_Applier nor any Consumer, and return the Validation_Result to the producing agent.
10. IF a human edit to a LogicModel fails validation, THEN THE Snapshot_Service SHALL create no Snapshot, leave the Base_Snapshot and the Base_Snapshot's Snapshot_Record unchanged, and return the Validation_Result to the Author.

### Requirement 7: Canonical serialization and parsing

**User Story:** As a developer, I want one canonical JSON form for every document, so that the same logic always produces the same bytes and the same hash.

**Status: not done yet (on hold, 2026-11-04).** `canonicalJson` in `packages/workflow-data/src/model.ts` covers criteria 2, 3, 6 and 7 for ordinary values. Still to do:
- Criterion 1: sort keys by Unicode code point, not UTF-16 code unit.
- Criterion 8: reject numbers that would need exponent notation, unsafe integers, and strings with lone surrogates.
- Criteria 4, 5, 9 and 10: no Snapshot_Parser exists yet. `snapshot-verifier.ts` uses `JSON.parse`, which accepts non-canonical bytes and duplicate keys, and silently replaces invalid UTF-8.
- Before turning on strict parsing, check that every stored snapshot object, and the test harness, writes canonical bytes.

#### Acceptance Criteria

1. THE Canonical_Serializer SHALL serialize a LogicModel, StructuredSpec, ChangePlan, or Hash_Inputs document into Canonical_Form, defined as UTF-8 bytes with no byte order mark, no whitespace outside string values, and the keys of every object, at every nesting level, written in strictly ascending Unicode code point order.
2. WHEN two documents differ only in object key order, insignificant whitespace, string escape form (for example `\u0041` versus `A`), or the notation of an equal number (for example `1.0`, `1e0`, and `1`), THE Canonical_Serializer SHALL produce identical Canonical_Form bytes for both documents.
3. THE Canonical_Serializer SHALL write array elements in their original order, without sorting, removing, or merging any element.
4. WHEN Canonical_Form bytes are supplied together with an expected document type of LogicModel, StructuredSpec, or ChangePlan, THE Snapshot_Parser SHALL parse the bytes and return the parsed document only after the Schema_Validator returns a passing Validation_Result for the document against the schema for the expected document type.
5. IF supplied bytes are empty, are not valid UTF-8, or are not well-formed JSON, THEN THE Snapshot_Parser SHALL return a parse error stating the zero-based byte offset of the first invalid byte and return no document.
6. FOR ALL LogicModels, StructuredSpecs, and ChangePlans that receive a passing Validation_Result, serializing with the Canonical_Serializer and then parsing with the Snapshot_Parser SHALL produce a document equal to the original, where equal means the same property names, string values identical character for character, numbers equal in value, and arrays holding the same elements in the same order (round-trip property).
7. FOR ALL LogicModels, StructuredSpecs, and ChangePlans that receive a passing Validation_Result, serializing, parsing, and serializing again SHALL produce bytes identical to the first serialization (idempotence property).
8. THE Canonical_Serializer SHALL write each integer as decimal digits with no leading zeros, plus sign, decimal point, or exponent, write each non-integer number in the shortest decimal form that parses back to the same value, and escape within strings only the quotation mark, the reverse solidus, and the control characters U+0000 to U+001F.
9. IF a document parsed by the Snapshot_Parser fails validation against the schema for the expected document type, THEN THE Snapshot_Parser SHALL return the failing Validation_Result and return no document.
10. IF supplied bytes are well-formed JSON but differ from the Canonical_Form of the document they encode, including bytes that repeat an object key within one object, THEN THE Snapshot_Parser SHALL return an error indicating the bytes are not in Canonical_Form, return no document, and perform no schema validation.

### Requirement 8: snapshotHash composition

**User Story:** As a clinician, I want my approval bound to a hash that changes whenever the change's meaning changes, so that nothing I did not see can ship under my approval.

#### Acceptance Criteria

1. THE Hash_Calculator SHALL compute the snapshotHash as the SHA-256 digest of the Canonical_Form bytes of the Hash_Inputs, encoded as a 64-character lowercase hexadecimal string.
2. THE Hash_Calculator SHALL compose the Hash_Inputs from exactly the seven Snapshot_Bundle parts (Schema_Version, Baseline, Full_Specification, Evidence_Versions, Prompt_Context_Refs, Golden_Case_Version, and Toolchain_Identity) and from no other data, so that the Author, Origin, Designation, and creation timestamp of a Snapshot do not affect the snapshotHash.
3. THE Hash_Calculator SHALL hash the Snapshot_Bundle only and never the snapshotHash itself, so that a snapshotHash cannot depend on its own value.
4. WHEN the Hash_Calculator receives Hash_Inputs whose Canonical_Form bytes are identical, including Hash_Inputs that differ only in object key order or insignificant whitespace, THE Hash_Calculator SHALL return the identical snapshotHash on every invocation, in every process, and on every host.
5. WHEN the Hash_Calculator receives two Hash_Inputs whose Canonical_Form bytes differ, including by one changed value, one added or removed property, or one reordered array element in any component, THE Hash_Calculator SHALL return a different snapshotHash for each of the two Hash_Inputs.
6. IF the Schema_Version, Baseline, Golden_Case_Version, or compiler version is absent or an empty string, the Full_Specification is not an object, the Evidence_Versions list is empty or has an entry that lacks or adds a property beyond `sourceId`, `version`, `sha256`, and `sourceS3Ref`, the `toolchainImageDigest` is not `sha256:` followed by 64 lowercase hexadecimal characters, or the Snapshot_Bundle has any property not listed in criterion 2, THEN THE Hash_Calculator SHALL return a validation error naming each failing part and produce no snapshotHash.
7. THE Snapshot_Store SHALL record in each Snapshot_Record the Evidence_Versions, Prompt_Context_Refs, Golden_Case_Version, and Toolchain_Identity used to compute the snapshotHash, together with the S3 reference of the stored Snapshot_Bundle object, from which the full Hash_Inputs, including the Full_Specification, can be read back.
8. THE Snapshot_Store SHALL compute the snapshotHash itself from the submitted Snapshot_Bundle and SHALL accept no snapshotHash supplied by the submitter.
9. WHEN a Snapshot is registered, THE Snapshot_Store SHALL first read the stored Snapshot_Bundle object at its recorded S3 version, check that its SHA-256 matches the recorded digest, and check that the snapshotHash recomputed from the stored object equals the snapshotHash of the submitted Snapshot_Bundle, and SHALL write no Snapshot_Record if any check fails.
10. IF the Hash_Calculator returns an error for a snapshot submission, THEN THE Snapshot_Store SHALL reject the submission, write no snapshot object and no Snapshot_Record, and return the Hash_Calculator's error.

*Change note (2026-11-04):* Requirement 8 was rewritten to match the implemented `snapshotBundleSchema` and `snapshotHash()` in `packages/workflow-data/src/model.ts`. The earlier five-component list became seven parts (adding Schema_Version and Prompt_Context_Refs), the Toolchain_Identity uses an image digest instead of an image tag, the carried-versus-computed hash check became "the store computes the hash", and the check that the Evidence_Versions guideline matches the LogicModel `guideline` field was removed because the bundle does not carry those names.

### Requirement 9: Append-only snapshot storage

**User Story:** As an auditor, I want every snapshot stored once and never overwritten, so that any past approval can be traced to the exact content approved.

#### Acceptance Criteria

1. WHEN a LogicModel that passes validation is submitted with the LogicModel's Hash_Inputs and no snapshot object exists for the LogicModel's snapshotHash, THE Snapshot_Store SHALL write the LogicModel's Canonical_Form bytes to the Artifact_Bucket under the `snapshots/` prefix as one new object with SSE-KMS encryption.
2. WHEN the Snapshot_Store has written a snapshot object, THE Snapshot_Store SHALL write a Snapshot_Record to the Index_Table under the Snapshot's `changeId` and return the written Snapshot_Record to the submitter.
3. THE Snapshot_Store SHALL record in each Snapshot_Record the snapshotId, snapshotHash, `changeId`, Designation, Author, Origin, creation timestamp (the UTC time the Snapshot_Record was written, to millisecond precision), S3 object version identifier of the snapshot object, the Baseline, Evidence_Versions, Golden_Case_Version, and Toolchain_Identity values used to compute the snapshotHash (the Full_Specification being the snapshot object itself), and a parent snapshotHash that equals the Base_Snapshot's snapshotHash for a Snapshot with a Base_Snapshot and is absent for a Snapshot without a Base_Snapshot.
4. WHEN a LogicModel is submitted for storage, THE Snapshot_Store SHALL validate the LogicModel with the Schema_Validator before writing any snapshot object or Snapshot_Record, regardless of any Validation_Result supplied with the submission.
5. IF a submission carries a snapshotId already recorded in any Snapshot_Record with a different snapshotHash, or a snapshotHash already stored with different Canonical_Form bytes, THEN THE Snapshot_Store SHALL reject the submission, return a conflict error naming the conflicting identifier (snapshotId or snapshotHash), and leave the stored snapshot object and Snapshot_Record unchanged.
6. WHEN a submission matches an existing Snapshot in snapshotHash, Canonical_Form bytes, and Designation, THE Snapshot_Store SHALL return the existing Snapshot_Record unchanged, including the original Author and creation timestamp, and create no additional snapshot object, object version, or Snapshot_Record.
7. IF the snapshot object write fails, THEN THE Snapshot_Store SHALL return a storage error identifying the snapshot object write as the failed write and write no Snapshot_Record.
8. WHEN a submission arrives whose snapshotHash and Canonical_Form bytes match a snapshot object already in the Artifact_Bucket for which no Snapshot_Record exists, THE Snapshot_Store SHALL write the missing Snapshot_Record with the existing snapshot object's S3 object version identifier and write no second snapshot object or object version.
9. IF a snapshot object exists in the Artifact_Bucket without a corresponding Snapshot_Record, THEN THE Snapshot_Service SHALL return a not-found error for every read of that snapshotHash and omit that Snapshot from every list result.
10. THE Snapshot_Service SHALL offer only create, read, list, and compare operations on stored Snapshots and Snapshot_Records, with no operation that updates, overwrites, or deletes a stored snapshot object or Snapshot_Record.
11. IF a snapshot write request comes from an identity other than the Pipeline_Orchestrator worker identity, THEN THE Snapshot_Store SHALL reject the request with an authorization error, write no snapshot object and no Snapshot_Record, and record the rejected identity and the request time in a log entry.
12. IF the Schema_Validator returns a failing Validation_Result for a LogicModel submitted for storage, THEN THE Snapshot_Store SHALL reject the submission, return the Validation_Result, and write no snapshot object and no Snapshot_Record.
13. IF the Snapshot_Record write fails after the snapshot object write succeeds, THEN THE Snapshot_Store SHALL return a storage error identifying the Snapshot_Record write as the failed write and keep the written snapshot object unchanged.
14. IF two or more submissions carrying the same snapshotHash or the same snapshotId are processed concurrently, THEN THE Snapshot_Store SHALL create exactly one snapshot object version and exactly one Snapshot_Record for that snapshotHash, return that Snapshot_Record to each other submission whose Canonical_Form bytes and Designation match, and reject each other submission whose Canonical_Form bytes or Designation differ.

### Requirement 10: Retrieval, integrity, and listing

**User Story:** As a reviewer or downstream component, I want to fetch any snapshot and know the content is intact, so that I can trust what I approve, compile, or test.

#### Acceptance Criteria

1. WHEN a Consumer requests a Snapshot by snapshotHash, THE Snapshot_Service SHALL do the following before returning any Snapshot content: read the snapshot object at the S3 object version identifier recorded in the Snapshot_Record, recompute the snapshotHash from that object's content and the recorded Hash_Inputs components, and compare the result with both the requested snapshotHash and the `snapshotHash` field of the stored LogicModel.
2. IF the stored bytes fail parsing by the Snapshot_Parser, or the recomputed snapshotHash differs from the requested snapshotHash or from the stored LogicModel's `snapshotHash` field, THEN THE Snapshot_Service SHALL return an integrity error identifying the requested snapshotHash, return no Snapshot content, and leave the snapshot object and the Snapshot_Record unchanged.
3. IF a requested snapshotHash has no Snapshot_Record, THEN THE Snapshot_Service SHALL return a not-found error identifying the requested snapshotHash and return no Snapshot content.
4. WHEN a Consumer requests the Snapshots for a `changeId`, THE Snapshot_Service SHALL return every Snapshot_Record for that `changeId` of both Designations, with no StructuredSpec index entries, ordered by creation timestamp from earliest to latest, with Snapshot_Records of equal creation timestamp ordered by snapshotHash in ascending lexicographic order, and with each Snapshot_Record containing the fields listed in Requirement 9.3.
5. WHEN a Consumer requests the Flags of a Snapshot by snapshotHash and the Snapshot passes the integrity check in criterion 1, THE Snapshot_Service SHALL return every Flag in the Snapshot in the Snapshot's stored array order, each with the Flag's `type`, `text`, and Source (Source absent for a Flag that carries none), and SHALL return an empty list for a Snapshot with no Flags.
6. WHEN an agent calls the `get-logic` operation with a snapshotHash, THE Snapshot_Service SHALL apply the same read-by-snapshotHash operation, integrity check, and errors defined in criteria 1 to 3, return LogicModel content byte-identical to the Canonical_Form returned to every other Consumer for that snapshotHash, and make no change to any snapshot object or Snapshot_Record.
7. THE Snapshot_Service SHALL keep every stored Snapshot and its Snapshot_Record retrievable by snapshotHash for the lifetime of the Vera deployment, regardless of the Snapshot's age, its Designation, or the existence of later Snapshots for the same `changeId` or derived from it.
8. IF a requested snapshotHash is not a 64-character lowercase hexadecimal string, THEN THE Snapshot_Service SHALL return an invalid-request error, distinct from the not-found error, identifying the supplied value, and return no Snapshot content.
9. IF a Snapshot_Record exists for a requested snapshotHash but the snapshot object version recorded in that Snapshot_Record cannot be read from the Artifact_Bucket, THEN THE Snapshot_Service SHALL return a storage error, distinct from the not-found error, identifying the requested snapshotHash, and return no Snapshot content.
10. IF no Snapshot_Record exists for a requested `changeId`, THEN THE Snapshot_Service SHALL return an empty list and no error.

### Requirement 11: New snapshots from drafts, human edits, and change plans

**User Story:** As a clinician, I want every edit, whether from AI or a person, to produce a new snapshot, so that nothing changes under an approval already given.

#### Acceptance Criteria

1. WHEN an agent-drafted LogicModel passes validation by the Schema_Validator, THE Snapshot_Service SHALL store the LogicModel as a new Snapshot with Origin `agent_draft`.
2. WHEN a human edit to a Base_Snapshot passes validation by the Schema_Validator, THE Snapshot_Service SHALL store the edited LogicModel as a new Snapshot with Origin `human_edit`.
3. WHEN the Change_Plan_Applier produces a LogicModel that passes validation by the Schema_Validator, THE Snapshot_Service SHALL store the LogicModel as a new Snapshot with Origin `change_plan`.
4. WHEN a new Snapshot derives from a Base_Snapshot, THE Snapshot_Store SHALL record the Base_Snapshot's snapshotHash as the parent snapshotHash in the new Snapshot_Record.
5. WHEN one or more new Snapshots derive from a Base_Snapshot, THE Snapshot_Store SHALL leave the Base_Snapshot's stored Canonical_Form bytes and S3 object version identifier unchanged and leave every field of the Base_Snapshot's Snapshot_Record unchanged.
6. THE Snapshot_Store SHALL record in each Snapshot_Record the Author supplied with the snapshot submission, without modification.
7. IF a snapshot submission lacks an Author or supplies an empty Author, THEN THE Snapshot_Store SHALL reject the submission with an error indicating the missing Author and create no snapshot object and no Snapshot_Record.
8. IF a snapshot submission specifies no Origin, or specifies an Origin other than `agent_draft`, `human_edit`, or `change_plan`, THEN THE Snapshot_Store SHALL reject the submission with an error indicating the missing or invalid Origin and create no snapshot object and no Snapshot_Record.
9. IF a snapshot submission with Origin `human_edit` or `change_plan` lacks a parent snapshotHash, THEN THE Snapshot_Store SHALL reject the submission with an error indicating the missing parent snapshotHash and create no snapshot object and no Snapshot_Record.
10. IF a snapshot submission carries a parent snapshotHash that identifies no stored Snapshot, THEN THE Snapshot_Store SHALL reject the submission with an error indicating the unknown parent snapshotHash and create no snapshot object and no Snapshot_Record.

### Requirement 12: Applying change plans

**User Story:** As a program officer, I want code to apply the change plan exactly, so that an edit means the same thing every time it is applied.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator requests application of a ChangePlan, THE Change_Plan_Applier SHALL read the Base_Snapshot through the Snapshot_Service read-by-snapshotHash operation and produce a new LogicModel by applying each Change_Operation in list order, with each Change_Operation acting on the LogicModel that results from the Change_Operations before it.
2. IF the ChangePlan's Base_Snapshot snapshotHash does not identify a stored Snapshot, or the Snapshot_Service returns an integrity error for that snapshotHash, THEN THE Change_Plan_Applier SHALL reject the ChangePlan, report the Base_Snapshot snapshotHash together with the error kind (not found or integrity), and produce no LogicModel.
3. IF a `modify` or `remove` Change_Operation targets an element `id` that is absent from the target element kind's list at the point that Change_Operation is applied, THEN THE Change_Plan_Applier SHALL reject the whole ChangePlan, report the zero-based list position and the target element `id` of the first failing Change_Operation, and produce no LogicModel.
4. IF an `add` Change_Operation targets an element `id` that is already present in the target element kind's list at the point that Change_Operation is applied, THEN THE Change_Plan_Applier SHALL reject the whole ChangePlan, report the zero-based list position and the target element `id` of the first failing Change_Operation, and produce no LogicModel.
5. IF the ChangePlan fails validation against the ChangePlan_Schema, or the LogicModel the Change_Plan_Applier produces fails validation against the LogicModel_Schema, THEN THE Change_Plan_Applier SHALL reject the ChangePlan, return the Validation_Result, and produce no LogicModel.
6. WHEN the same ChangePlan is applied to the same Base_Snapshot more than once with the same Baseline, Evidence_Versions, Golden_Case_Version, and Toolchain_Identity, THE Change_Plan_Applier SHALL produce LogicModels with identical Canonical_Form bytes each time.
7. THE Change_Plan_Applier SHALL copy the `pathway` and `guideline` fields, and every Input, Rule, and Flag that no Change_Operation targets, from the Base_Snapshot's LogicModel to the produced LogicModel with identical Canonical_Form.
8. THE Change_Plan_Applier SHALL assign the produced LogicModel a snapshotId that differs from the Base_Snapshot's snapshotId and from the snapshotId of every stored Snapshot whose LogicModel content, excluding `snapshotId` and `snapshotHash`, differs from the produced LogicModel's content.
9. IF the new element in an `add` or `modify` Change_Operation has an `id` different from that Change_Operation's target element `id`, THEN THE Change_Plan_Applier SHALL reject the whole ChangePlan, report the zero-based list position and the target element `id` of the first failing Change_Operation, and produce no LogicModel.
10. THE Change_Plan_Applier SHALL append each element added by an `add` Change_Operation to the end of the target element kind's list, keep each element replaced by a `modify` Change_Operation at the replaced element's list position, and preserve the relative order of the elements that remain after a `remove` Change_Operation.
11. THE Change_Plan_Applier SHALL set the produced LogicModel's `snapshotHash` to the snapshotHash that the Hash_Calculator computes using the produced LogicModel as the Full_Specification, plus the Baseline, Evidence_Versions, Golden_Case_Version, and Toolchain_Identity supplied with the application request.

### Requirement 13: Comparing snapshots

**User Story:** As a program officer, I want to see exactly what changed between two snapshots, so that I can check an edit before and after.

#### Acceptance Criteria

1. WHEN two snapshotHashes are supplied as a first and a second Snapshot, THE Logic_Differ SHALL compare the two Snapshots regardless of either Snapshot's Designation, reporting as added each Input, Rule, and Flag whose element kind and `id` appear only in the second Snapshot, and as removed each Input, Rule, and Flag whose element kind and `id` appear only in the first Snapshot, with each entry giving the element kind, the `id`, and the element's complete content.
2. WHEN two snapshotHashes are supplied and the `pathway` value, the `guideline` name, or the `guideline` version differs between the two Snapshots, THE Logic_Differ SHALL report each differing field with the field's value in the first Snapshot and the field's value in the second Snapshot.
3. THE Logic_Differ SHALL return an empty difference if and only if the Canonical_Form of the two LogicModels, with `snapshotId` and `snapshotHash` excluded, is byte-identical, including when both supplied snapshotHashes are the same.
4. FOR ALL pairs of Snapshots A and B, the additions in the difference from A to B SHALL equal the removals in the difference from B to A, the removals from A to B SHALL equal the additions from B to A, and each modification and each `pathway` or `guideline` change from A to B SHALL appear in the difference from B to A with the first-Snapshot and second-Snapshot values swapped (symmetry property).
5. WHEN the Logic_Differ compares a Base_Snapshot with the Snapshot that the Change_Plan_Applier produced by applying a ChangePlan to that Base_Snapshot, THE Logic_Differ SHALL report only Inputs, Rules, and Flags whose element kind and `id` match a Change_Operation in that ChangePlan, and SHALL report no change to the `pathway` or `guideline` fields.
6. WHEN the Logic_Differ compares two Snapshots, THE Logic_Differ SHALL make no change to either Snapshot, either Snapshot_Record, or any other stored data, and SHALL create no new Snapshot.
7. WHEN two snapshotHashes are supplied and an Input, Rule, or Flag with the same element kind and `id` appears in both Snapshots with at least one differing property value, THE Logic_Differ SHALL report the element as modified, giving the element kind, the `id`, the element's complete content in the first Snapshot and in the second Snapshot, and the JSON path of each property whose value differs.
8. WHEN two snapshotHashes are supplied and the Inputs, Rules, or Flags present in both Snapshots appear in a different relative order in the `inputs`, `rules`, or `flags` list, THE Logic_Differ SHALL report an order change for each affected list, giving the `id`s of the elements present in both Snapshots in the first Snapshot's order and in the second Snapshot's order.
9. IF either supplied snapshotHash is not 64 lowercase hexadecimal characters, has no Snapshot_Record, or fails the snapshotHash integrity check of Requirement 10, THEN THE Logic_Differ SHALL return an error that identifies the failing snapshotHash and the failure kind (malformed, not found, or integrity failure), and SHALL return no difference.

### Requirement 14: Preview and release designation

**User Story:** As an IT lead, I want preview snapshots kept apart from release snapshots, so that a before/after comparison can never be deployed.

#### Acceptance Criteria

1. WHEN the Snapshot_Store creates a Snapshot_Record, THE Snapshot_Store SHALL record in the Snapshot_Record exactly one Designation, with the value `release` or `preview`, equal to the Designation specified in the snapshot submission.
2. IF a snapshot submission specifies no Designation, or specifies a Designation value other than exactly `release` or `preview`, THEN THE Snapshot_Store SHALL reject the submission, return an error indicating the missing or invalid Designation, and write no snapshot object and no Snapshot_Record.
3. IF a request attempts to change the Designation of a stored Snapshot, THEN THE Snapshot_Service SHALL reject the request, return an error indicating that a Designation cannot change after creation, and leave the Snapshot_Record and the snapshot object unchanged.
4. WHEN a Consumer reads a Snapshot by snapshotHash or lists the Snapshot_Records for a `changeId`, THE Snapshot_Service SHALL return, with each Snapshot or Snapshot_Record returned, the Designation recorded in the Snapshot_Record at creation.
5. WHEN a Consumer asks whether the Snapshot identified by a snapshotHash is deployable, THE Snapshot_Service SHALL answer deployable if the Snapshot_Record records Designation `release`, and not deployable if the Snapshot_Record records Designation `preview`.
6. IF a submission has the same snapshotHash as a stored Snapshot but a different Designation, THEN THE Snapshot_Store SHALL reject the submission, report both the stored Designation and the submitted Designation, and leave the stored Snapshot and Snapshot_Record unchanged, with no additional snapshot object or Snapshot_Record written.
7. IF a Consumer asks whether a Snapshot is deployable and the supplied snapshotHash has no Snapshot_Record, THEN THE Snapshot_Service SHALL return a not-found error and give no deployable answer.
8. IF a Consumer asks whether a Snapshot is deployable and the Snapshot_Service cannot read the Snapshot_Record from the Index_Table, THEN THE Snapshot_Service SHALL return an error indicating that the Designation could not be read and give no deployable answer.

### Requirement 15: Pathway logic only, synthetic data only

**User Story:** As a health ministry, I want snapshots to hold only pathway logic, so that no patient data, credentials, or compiled configuration end up in stored snapshots or in prompts built from them.

#### Acceptance Criteria

1. THE LogicModel_Schema SHALL limit LogicModel content to the top-level fields `snapshotId`, `snapshotHash`, `pathway`, `guideline`, `inputs`, `rules`, and `flags`, with the `guideline` field, each Input, each Rule, each Condition, each Follow_Up, each Source, and each Flag limited to the properties that the LogicModel_Schema defines for that element.
2. IF a LogicModel, StructuredSpec, or ChangePlan submitted for storage contains a property, at any nesting depth, that the corresponding schema does not define, THEN THE Snapshot_Store SHALL reject the submission, return the Validation_Result listing the JSON path of each undefined property, and write no object to the Artifact_Bucket and no record to the Index_Table.
3. THE Snapshot_Store SHALL write StructuredSpec, LogicModel, and ChangePlan documents only to the Artifact_Bucket, and index entries for those documents only to the Index_Table.
4. THE Snapshot_Store SHALL limit each Snapshot_Record to the fields listed in Requirement 9.3: the snapshotId, snapshotHash, `changeId`, Designation, Author, Origin, creation timestamp, S3 object version identifier of the snapshot object, the Baseline, Evidence_Versions, Golden_Case_Version, and Toolchain_Identity values used to compute the snapshotHash, and the parent snapshotHash (absent for a Snapshot without a Base_Snapshot).
5. WHEN an agent calls the `get-logic` operation, THE Snapshot_Service SHALL return only the LogicModel fields listed in criterion 1 and the Snapshot's Designation, and no other Snapshot_Record field.
6. THE Snapshot_Service SHALL write no StructuredSpec, LogicModel, or ChangePlan field value to any log entry other than the document's `changeId`, snapshotId, and snapshotHash.

## Open Questions

These are gaps or tensions in the Solution Design that affect this spec. The requirements above follow the design literally where it is explicit and take the narrowest reading where it is not.

1. **Compiler fixes versus approval reuse.** §6 and Decisions Log #7 say a compiler bug with unchanged logic rebuilds the same snapshotHash and keeps the clinician's approval. §10 puts compiler/toolchain identity inside the hash. If fixing the bug changes the compiler version, the hash changes and the clinician must re-approve. Requirement 8 follows §10, so any Toolchain_Identity change produces a new hash. Under that reading, approval reuse applies only to retries with an unchanged toolchain, such as a crashed container. Confirm which reading is intended.
2. **Baseline is undefined.** Candidates are the Base_Snapshot for edits and the reference configuration (`cht-core/config/default`) for a new pathway.
3. **Designation is not a Hash_Input.** A preview and a release of identical logic would share a snapshotHash. Requirement 14.6 rejects that collision, which blocks "preview an edit, then release the same edit". Adding Designation to the Hash_Inputs would remove the collision but extends §10's list.
4. **ChangePlan structure.** The design names `ChangePlan` without fields. Requirement 5 assumes add, modify, and remove operations addressed by element id.
5. **Condition grammar and input types.** §10 shows only `all` with `eq`, plus `otherwise`. The example pathway (age in months, breaths per minute) needs numeric thresholds. The comparison operators and input types should be fixed when the schema is locked (Day 1 AM, §19).
6. **Open versus resolved ambiguity.** §11 blocks `content_review` while an ambiguity is open, but the Flag shape has no resolved state. Either resolving a Flag produces a new Snapshot without that Flag, or Flags gain a status field.
7. **StructuredSpec fields.** The design does not list StructuredSpec fields. Requirement 4 sets the minimum needed to start drafting and editing.
