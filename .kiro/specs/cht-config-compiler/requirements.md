# Requirements Document

## Introduction

The cht-config-compiler is the deterministic step that turns one content-approved Snapshot into a standard `cht-conf` project (Solution Design §12, §6 state 6). It is plain code: no model, no generative step, and no network access beyond reading its inputs and writing its output (§3 rules 1, 9). The approver view, the logic checks, and the compiler all read the same LogicModel (§3 rule 5, §10). One structured Rule produces both the XLSForm logic and the `tasks.js` logic, so the two can never drift apart (§12).

The compiler runs in the Compile Pipeline_State, after Content_Approval and before Build_Test. Its output is written once to the Artifact_Bucket, keyed by snapshotHash, with a Compile_Manifest that downstream steps verify.

Dependencies (referenced, not specified here):
- **logic-model-snapshots**: LogicModel schema, Snapshot_Service, Integrity check, Hash_Inputs, Toolchain_Identity, Designation.
- **logic-checks-golden-cases**: rule-evaluation semantics and golden cases used to judge compiled output. Expected test outcomes come from the approved logic, never from the compiler (§3 rule 6).
- **pipeline-orchestrator**: Compile Pipeline_State, Worker_API, Approvals table, Build_Failure_Category handling, Tooling_Retry.
- **build-test-sandbox**: runs `cht-conf` and the test harness on the compiled project (§13).
- **cht-deployer**: uploads a tested build (§13).
- **review-ui-approvals**: Config_Diff, which compares the compiled output of two Snapshots.
- **platform-infrastructure**: Artifact_Bucket, IAM roles, services host.

## Glossary

Terms reused from earlier specs keep the meaning defined there.

- **Vera**, **LogicModel**, **Snapshot**, **Snapshot_Record**, **snapshotHash**, **Snapshot_Service**, **Integrity check**, **Hash_Inputs**, **Toolchain_Identity**, **Designation**, **Input**, **Input-type enumeration**, **Rule**, **Condition**, **Comparison**, **Comparison operator**, **Action**, **Follow_Up**, **Source**, **changeId**, **JSON path**, **Artifact_Bucket**: As defined in the logic-model-snapshots spec.
- **Pipeline_Orchestrator**, **Pipeline_State**, **Worker_API**, **Worker_Call_Id**, **Content_Approval**, **Approvals table**, **Approved snapshotHash**, **Build_Failure_Category** (`infrastructure` or `build_or_test`), **Tooling_Retry**, **Decision_Log**: As defined in the pipeline-orchestrator spec.
- **AgentCore Gateway**: The tool gateway through which agents call tools, as defined in the authoring-agents spec.
- **Config_Compiler**: The deterministic compiler specified here, exposed to the Pipeline_Orchestrator as the `compile-config` operation.
- **Compiler_Version**: The version identifier of the Config_Compiler code, recorded as the compiler version in Toolchain_Identity.
- **Compile_Request**: A request from the Compile Pipeline_State, sent through the Worker_API with a Worker_Call_Id, naming one changeId and one snapshotHash.
- **Compile_Result**: The Config_Compiler's response to one Compile_Request: `succeeded`, with the Compile_Manifest location and SHA-256 digest, or `failed`, with the snapshotHash, one Build_Failure_Category, and a list of errors.
- **Compile_Error**: One entry in a failed Compile_Result, holding an error code, a description, and, for an error raised by a LogicModel element, that element's JSON path.
- **CHT_Project**: The standard `cht-conf` project the Config_Compiler produces: two App_Forms, one Form_Properties_File beside each App_Form, one Tasks_File, and one Translations_File.
- **App_Form**: One XLSForm workbook (`.xlsx`) in the CHT_Project: the Assessment_Form or the Follow_Up_Form.
- **Assessment_Form**: The App_Form that asks the Inputs and shows the Action of the Matching Rule, for example `sick_child_assessment.xlsx`.
- **Follow_Up_Form**: The App_Form a health worker completes for a follow-up task, for example `sick_child_follow_up.xlsx`.
- **Form ID**: The identifier by which `cht-conf` and the Tasks_File name one App_Form.
- **Form_Properties_File**: The `properties.json` file that `cht-conf` reads beside one App_Form.
- **Tasks_File**: The single `tasks.js` file of the CHT_Project.
- **Translations_File**: The translations file of the CHT_Project that holds the text keys used by the Tasks_File and the Form_Properties_Files.
- **Form_Logic**: The XLSForm `relevance`, `calculate`, and `constraint` expressions in the App_Forms.
- **Task_Logic**: The `appliesIf` and `resolvedIf` logic, due date, and open window of each task definition in the Tasks_File.
- **Matching Rule**: For one Input_Combination, the Rule whose id the Rule_Evaluator returns in its Outcome: the single satisfied Non-catch-all Rule, or the Catch_All_Rule when no Non-catch-all Rule is satisfied.
- **Rule_Result_Field**: The Assessment_Form `calculate` field generated for one Rule that records whether that Rule is the Matching Rule.
- **Due_Date_Field**: The Assessment_Form `calculate` field generated for one Rule with a Follow_Up that records the follow-up due date.
- **Unsupported_Construct**: A LogicModel element that the Compiler_Version has no fixed mapping for: an Input `type`, Comparison operator, or Action value outside the Compiler_Version's supported sets, or an Input `id` that is not a valid XLSForm field name.
- **Form_Reference_Check**: The check that every Form ID referenced by the Tasks_File matches one App_Form in the same CHT_Project (§12).
- **Compile_Manifest**: The file written last under a build's prefix that lists every CHT_Project file with its SHA-256 digest and records the build's provenance.
- **Build_Prefix**: The Artifact_Bucket key prefix `builds/{snapshotHash}/` for one snapshotHash.
- **Non-catch-all Rule**, **Catch_All_Rule**, **Input_Combination**, **Rule_Evaluator**, **Outcome**: As defined in the logic-checks-golden-cases spec.
- **Dependency_Timeout**: The 30 seconds the Config_Compiler waits for a response from the Approvals table, the Snapshot_Service, or the Artifact_Bucket on one call (Requirement 8.4).

## Requirements

### Requirement 1: Compile only the content-approved Snapshot

**User Story:** As a clinician, I want only the exact Snapshot I approved to be compiled, so that the configuration health workers receive matches the logic I reviewed.

#### Acceptance Criteria

1. WHEN the Config_Compiler receives a Compile_Request, THE Config_Compiler SHALL check, before reading the Snapshot or writing any object to the Artifact_Bucket, that the Compile_Request's snapshotHash is an exact, case-sensitive match of the full Approved snapshotHash that the Approvals table records for the Compile_Request's changeId at the time of the Approvals table read.
2. IF the Compile_Request's snapshotHash is not an exact match of the Approved snapshotHash, or the Approvals table records no Approved snapshotHash for the changeId, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `not_approved` and Build_Failure_Category `build_or_test` without reading the Snapshot or writing any object to the Artifact_Bucket.
3. WHEN the approval check in criterion 1 passes, THE Config_Compiler SHALL read the Snapshot for the Approved snapshotHash, and no other Snapshot, through the Snapshot_Service with the Integrity check.
4. IF the Snapshot_Service reports an Integrity check failure, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `integrity_failed` and Build_Failure_Category `build_or_test` without generating any CHT_Project file or writing any object to the Artifact_Bucket.
5. THE Config_Compiler SHALL derive every Form_Logic expression and every Task_Logic definition in the CHT_Project only from the LogicModel that the Snapshot_Service returns for the Approved snapshotHash, with no pathway logic taken from any other Snapshot, from any earlier output under any Build_Prefix, or from the Compile_Request.
6. IF the Integrity check passes and the Snapshot's Toolchain_Identity records no compiler version or records a compiler version that is not an exact match of the Compiler_Version, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `toolchain_mismatch` and Build_Failure_Category `infrastructure` without generating any CHT_Project file or writing any object to the Artifact_Bucket.
7. IF the Snapshot_Service reports that no Snapshot exists for the Approved snapshotHash, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `snapshot_not_found` and Build_Failure_Category `build_or_test` without writing any object to the Artifact_Bucket.

### Requirement 2: Produce a standard cht-conf project

**User Story:** As a national IT lead, I want the output to be ordinary CHT configuration, so that it builds with `cht-conf` and can be inspected and reversed like any other CHT project.

#### Acceptance Criteria

1. WHEN the Config_Compiler compiles a Snapshot, THE Config_Compiler SHALL produce one CHT_Project that contains exactly six files: one Assessment_Form, one Follow_Up_Form whose Form ID differs from the Assessment_Form's Form ID, one Form_Properties_File for each App_Form, one Tasks_File, and one Translations_File.
2. THE Config_Compiler SHALL place both App_Forms and both Form_Properties_Files in the `forms/app/` directory, the Tasks_File in the CHT_Project root directory, and the Translations_File in the `translations/` directory, with each Form_Properties_File named with the Form ID of the App_Form it describes.
3. THE Config_Compiler SHALL write each CHT_Project file in a format that the `cht-conf` version in the `medicmobile/cht-app-ide` image tag named in the Snapshot's Toolchain_Identity processes without reporting an error for that file.
4. WHEN the Config_Compiler compiles the Inputs of a LogicModel, THE Config_Compiler SHALL add exactly one Assessment_Form question per Input, in the order of the LogicModel `inputs` list, with the Input `id` as the question name and the Input `label` as the question label.
5. THE Config_Compiler SHALL map every Input of one `type` to the same XLSForm question type, using the XLSForm `integer` type for Input `type` `integer`, an XLSForm `select_one` question with exactly two choices, yes and no, for Input `type` `yes_no`, and the single XLSForm question type that the Compiler_Version fixes for each other supported Input `type`.
6. THE Config_Compiler SHALL write to the Translations_File exactly one entry with non-empty text for each distinct text key that the Tasks_File or a Form_Properties_File references, and no entry for any other key.
7. WHEN the Config_Compiler compiles two Snapshots whose LogicModel `pathway` values are identical under case-sensitive comparison, THE Config_Compiler SHALL give each App_Form the same Form ID and each CHT_Project file the same relative path in both CHT_Projects, regardless of differences in their Inputs, Rules, Flags, `snapshotId`, or `guideline`.
8. THE Config_Compiler SHALL generate the Tasks_File only from the fixed task templates of the Compiler_Version, with each template slot filled by a LogicModel value, a Form ID, a text key, or the name of a Rule_Result_Field or Due_Date_Field, written as a JavaScript string or number literal.
9. WHEN the Config_Compiler writes a LogicModel string value into a CHT_Project file, THE Config_Compiler SHALL encode the value so that `cht-conf` and the CHT app read it as literal text identical character-for-character to the LogicModel value, including values that contain quotation marks, backslashes, line breaks, angle brackets, the characters `*`, `_`, or `#`, the sequence `${`, or a leading `=`.
10. WHEN the Config_Compiler compiles a LogicModel in which no Rule has a Follow_Up, THE Config_Compiler SHALL produce the Follow_Up_Form and a Tasks_File that contains zero task definitions.
11. IF an Input `id` equals the name of a Rule_Result_Field, a Due_Date_Field, or any other field that the Compiler_Version generates in the Assessment_Form, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `unsupported_construct`, Build_Failure_Category `build_or_test`, and a Compile_Error holding that Input's JSON path.

### Requirement 3: Generate form logic and task logic from one Rule

**User Story:** As a clinician, I want each rule I approved to drive both the form and the follow-up task, so that the form and the task list can never disagree.

#### Acceptance Criteria

1. WHEN the Config_Compiler compiles a Non-catch-all Rule, THE Config_Compiler SHALL add exactly one Rule_Result_Field for that Rule to the Assessment_Form that is true exactly when every Input referenced by a Comparison in the LogicModel has an entered value and every Comparison in that Rule's `all` list is true for the entered Input values.
2. WHEN the Config_Compiler compiles a Rule, THE Config_Compiler SHALL add exactly one Assessment_Form note for that Rule whose label is the text the Compiler_Version fixes for the Rule's Action value and whose `relevance` expression is true exactly when that Rule's Rule_Result_Field is true and references no field other than that Rule_Result_Field.
3. THE Config_Compiler SHALL build every Form_Logic expression only from LogicModel Input and Rule values filled into the fixed expression templates of the Compiler_Version.
4. WHEN the Config_Compiler compiles a Rule that has a Follow_Up, THE Config_Compiler SHALL add exactly one task definition for that Rule to the Tasks_File.
5. THE Config_Compiler SHALL make the number of task definitions in the Tasks_File equal to the number of Rules that have a Follow_Up, including zero when no Rule has a Follow_Up.
6. WHEN the Config_Compiler generates a task's `appliesIf`, THE Config_Compiler SHALL make `appliesIf` true for a report exactly when the report is an Assessment_Form report that records that Rule's Rule_Result_Field as true.
7. WHEN the Config_Compiler generates a task's `resolvedIf`, THE Config_Compiler SHALL make `resolvedIf` true exactly when the contact of the source Assessment_Form report has a Follow_Up_Form report dated on or after the source Assessment_Form report date and on or before the last day the task is open under Requirement 4, criterion 3.
8. WHEN the Config_Compiler generates a task's action, THE Config_Compiler SHALL set the action to open the Follow_Up_Form by the Follow_Up_Form's Form ID.
9. WHEN the Config_Compiler compiles a Catch_All_Rule, THE Config_Compiler SHALL add exactly one Rule_Result_Field for that Rule to the Assessment_Form that is true exactly when every Input referenced by a Comparison in the LogicModel has an entered value and no Non-catch-all Rule's Rule_Result_Field is true.
10. FOR ALL Input_Combinations for which the Rule_Evaluator returns an Outcome, an Assessment_Form report submitted with that Input_Combination SHALL record as true the Rule_Result_Field of the Rule whose id the Outcome holds and as false every other Rule_Result_Field (form-evaluator agreement property).

### Requirement 4: Split follow-up timing deterministically

**User Story:** As a program officer, I want "follow up in N days, keep open M more" stored once and split by the compiler, so that nobody has to keep a form calculation and a task in step by hand.

#### Acceptance Criteria

1. WHEN the Config_Compiler compiles a Rule that has a Follow_Up, THE Config_Compiler SHALL add to the Assessment_Form one Due_Date_Field for that Rule whose value is the calendar date that falls the Rule's `dueInDays` calendar days after the Assessment_Form report date, which is the calendar date on which the Assessment_Form report is submitted.
2. WHEN the Config_Compiler generates the task for a Rule with a Follow_Up, THE Config_Compiler SHALL set the task's due date to the date held in that same Rule's Due_Date_Field in the source Assessment_Form report.
3. WHEN the Config_Compiler generates the task for a Rule with a Follow_Up, THE Config_Compiler SHALL set the task's open window to start on the due date and end on the calendar day that falls the Rule's `openForDays` calendar days after the due date, with both days included.
4. THE Config_Compiler SHALL write each Rule's `dueInDays` in exactly one place in the CHT_Project, that Rule's Due_Date_Field `calculate` expression, and each Rule's `openForDays` in exactly one place, that Rule's task definition in the Tasks_File.
5. WHEN the Config_Compiler compiles a Rule whose Follow_Up has `dueInDays` equal to 0, THE Config_Compiler SHALL generate that Rule's task so that its open window starts on the Assessment_Form report date.
6. WHEN the Config_Compiler compiles a Rule whose Follow_Up has `openForDays` equal to 0, THE Config_Compiler SHALL generate that Rule's task so that its open window contains only the due date.

### Requirement 5: Check form references before the build is valid

**User Story:** As a national IT lead, I want every form a task points to confirmed to exist, so that a broken task never reaches build, test, or deploy.

#### Acceptance Criteria

1. WHEN the Config_Compiler has generated all CHT_Project files for a Compile_Request, THE Config_Compiler SHALL run the Form_Reference_Check once on those generated files before writing any file under the Build_Prefix for the Compile_Request's snapshotHash.
2. THE Form_Reference_Check SHALL confirm that every Form ID referenced by a task definition in the Tasks_File, in the report form its `appliesIf` reads, the report form its `resolvedIf` reads, or the form its action opens, equals the Form ID of one of the two App_Forms in the same CHT_Project as an exact, case-sensitive string.
3. IF the Form_Reference_Check finds one or more referenced Form IDs with no matching App_Form, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `form_reference_missing` and Build_Failure_Category `build_or_test`.
4. IF the Form_Reference_Check finds one or more referenced Form IDs with no matching App_Form, THEN THE Config_Compiler SHALL include in the failed Compile_Result one Compile_Error with error code `form_reference_missing` for each distinct pair of unmatched Form ID and Rule, holding the unmatched Form ID and the JSON path of the Rule whose task definition references it.
5. WHEN the Form_Reference_Check passes, THE Config_Compiler SHALL record in the Compile_Manifest that the Form_Reference_Check passed, together with each distinct Form ID the check confirmed.
6. IF the Form_Reference_Check fails, THEN THE Config_Compiler SHALL write no file under the Build_Prefix for the Compile_Request's snapshotHash.
7. IF the Tasks_File contains no task definition, THEN THE Form_Reference_Check SHALL pass with an empty list of confirmed Form IDs.

### Requirement 6: Compile deterministically with no model

**User Story:** As a clinician, I want the same approved logic to always produce the same configuration, so that a rebuild under my existing approval delivers exactly what I approved.

#### Acceptance Criteria

1. WHEN the Config_Compiler compiles the same LogicModel with the same Compiler_Version more than once, THE Config_Compiler SHALL produce the same set of relative file paths with byte-identical content for every CHT_Project file, including when the compiles run on different hosts, on different dates, or under different time zone and locale settings.
2. THE Config_Compiler SHALL derive the content of every CHT_Project file only from the LogicModel and the Compiler_Version, with no value taken from the compile's date or time, the host, environment variables, a random source, the Compile_Request's Worker_Call_Id or changeId, or objects already in the Artifact_Bucket.
3. THE Config_Compiler SHALL write every date or time value that a CHT_Project file format holds, including each App_Form's workbook created and modified dates and its `.xlsx` archive entry dates, as the single fixed value defined by the Compiler_Version.
4. THE Config_Compiler SHALL generate the CHT_Project with no call to a language model or other generative model, either directly or through the AgentCore Gateway.
5. WHILE the Config_Compiler runs a compile, THE Config_Compiler SHALL limit outbound network calls to the Approvals table read for the Compile_Request's changeId, the Snapshot_Service read for the Approved snapshotHash, and Artifact_Bucket reads and writes under the Build_Prefix.
6. THE Config_Compiler SHALL publish its Compiler_Version in the format that Toolchain_Identity records for the compiler version, with a new Compiler_Version value for every change to the Config_Compiler code, any library it bundles, its fixed task templates, or its fixed output values.
7. THE Config_Compiler SHALL write every sequence whose order a CHT_Project file format leaves free, including App_Form rows, `.xlsx` archive entries, Form_Properties_File keys, Translations_File entries, and Tasks_File task definitions, in an order computed only from LogicModel list order and sort rules fixed by the Compiler_Version.
8. WHEN the Config_Compiler compiles the same Snapshot more than once with the same Compiler_Version, THE Config_Compiler SHALL produce a byte-identical Compile_Manifest on every compile, with no compile date or time, host identity, or Worker_Call_Id in the Compile_Manifest.

### Requirement 7: Store output once with a Compile_Manifest

**User Story:** As a national IT lead, I want each build stored once under its snapshotHash with file digests, so that the tested, diffed, and deployed files are provably the same files.

#### Acceptance Criteria

1. WHEN the Form_Reference_Check passes, THE Config_Compiler SHALL write each CHT_Project file to the Artifact_Bucket at the key formed by the Build_Prefix of the Approved snapshotHash followed by that file's relative path in the CHT_Project.
2. WHEN the Config_Compiler writes a CHT_Project file or the Compile_Manifest to a key that already holds an object byte-identical to that file, THE Config_Compiler SHALL keep the existing object and create no new object version at that key.
3. IF the key of a CHT_Project file or of the Compile_Manifest already holds an object whose bytes differ from the file being written, THEN THE Config_Compiler SHALL keep the existing object, write no Compile_Manifest, and return a failed Compile_Result with error code `output_mismatch`, Build_Failure_Category `infrastructure`, and the relative path of the mismatched file.
4. WHEN every CHT_Project file is stored under the Build_Prefix with content byte-identical to the generated file, THE Config_Compiler SHALL write the Compile_Manifest at the one key under the Build_Prefix that the Compiler_Version fixes for every snapshotHash.
5. THE Config_Compiler SHALL list in the Compile_Manifest exactly one entry for each CHT_Project file, and no other entry, holding the file's path relative to the Build_Prefix and the SHA-256 digest of the file's bytes as stored in the Artifact_Bucket.
6. THE Config_Compiler SHALL record in the Compile_Manifest the Approved snapshotHash, the Snapshot's Toolchain_Identity, the Snapshot's Designation, and the passed Form_Reference_Check result.
7. WHEN the Compile_Manifest is stored at its key with content byte-identical to the generated Compile_Manifest, THE Config_Compiler SHALL return a succeeded Compile_Result holding the Compile_Manifest's Artifact_Bucket key and the SHA-256 digest of the Compile_Manifest's stored bytes.
8. IF an Artifact_Bucket read or write under the Build_Prefix fails during a compile, THEN THE Config_Compiler SHALL write no Compile_Manifest and return a failed Compile_Result with error code `dependency_unavailable`, Build_Failure_Category `infrastructure`, and a description naming the Artifact_Bucket.

### Requirement 8: Report failures with a Build_Failure_Category

**User Story:** As a pipeline operator, I want every compile failure classed as logic or infrastructure, so that the Pipeline_Orchestrator retries tooling faults under the existing approval and sends logic faults to a person.

#### Acceptance Criteria

1. WHEN the Config_Compiler has confirmed that the compiler version in the Snapshot's Toolchain_Identity equals the Compiler_Version, THE Config_Compiler SHALL check every Input, Comparison, and Action in the LogicModel for Unsupported_Constructs before writing any file to the Artifact_Bucket.
2. IF the LogicModel contains one or more Unsupported_Constructs, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `unsupported_construct` and Build_Failure_Category `build_or_test`.
3. IF the LogicModel contains one or more Unsupported_Constructs, THEN THE Config_Compiler SHALL include in the failed Compile_Result exactly one Compile_Error with error code `unsupported_construct` and the element's JSON path for every Unsupported_Construct in the LogicModel, not only the first one found.
4. IF the Approvals table, the Snapshot_Service, or the Artifact_Bucket returns an error other than an Integrity check failure, or gives no response within the Dependency_Timeout of a call, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `dependency_unavailable` and Build_Failure_Category `infrastructure`.
5. IF a compile stops with an error not covered by another error code in this spec, THEN THE Config_Compiler SHALL return a failed Compile_Result with error code `internal_error` and Build_Failure_Category `infrastructure`.
6. THE Config_Compiler SHALL include in each failed Compile_Result the snapshotHash named in the Compile_Request, exactly one Build_Failure_Category, and at least one Compile_Error holding an error code and a description.
7. IF a compile fails, THEN THE Config_Compiler SHALL leave the Compile_Manifest key under the Build_Prefix exactly as it was before that compile started.
8. WHEN the Pipeline_Orchestrator retries a Compile_Request with the same Worker_Call_Id, THE Config_Compiler SHALL return a Compile_Result from a new compile of the changeId and snapshotHash named in the first attempt's Compile_Request.
9. IF a compile step fails, THEN THE Config_Compiler SHALL return the failed Compile_Result for that step without running any later step, where the steps run in the order approval check, Snapshot_Service read with Integrity check, toolchain check, Unsupported_Construct check, CHT_Project generation, Form_Reference_Check, and Artifact_Bucket writes.
10. WHEN the Config_Compiler returns a Compile_Error with error code `dependency_unavailable`, THE Config_Compiler SHALL name in that Compile_Error's description the dependency that failed: the Approvals table, the Snapshot_Service, or the Artifact_Bucket.

### Requirement 9: Restrict callers and write access

**User Story:** As a security reviewer, I want the compiler callable only by the orchestrator and able to write only build output, so that no agent can compile configuration and the compiler cannot alter approvals, Snapshots, or the Decision_Log.

#### Acceptance Criteria

1. THE Config_Compiler SHALL accept a Compile_Request only when the Compile_Request arrives through the Worker_API from the Compile Pipeline_State of the Pipeline_Orchestrator.
2. IF a Compile_Request arrives other than through the Worker_API, or from any caller other than the Compile Pipeline_State of the Pipeline_Orchestrator, THEN THE Config_Compiler SHALL reject the Compile_Request before reading the Approvals table, reading through the Snapshot_Service, or writing any object to the Artifact_Bucket.
3. IF the Config_Compiler rejects a Compile_Request because of the Compile_Request's caller or arrival path, THEN THE Config_Compiler SHALL return an error indicating that the caller is not authorized instead of a Compile_Result.
4. THE Config_Compiler SHALL register the `compile-config` operation on the Worker_API and register no Config_Compiler operation as a tool on AgentCore Gateway.
5. THE Config_Compiler SHALL run under an IAM role that no other component or agent uses, whose write permissions cover only creating objects under the Artifact_Bucket `builds/` prefix.
6. THE Config_Compiler SHALL limit the read permissions of its IAM role to the Snapshot objects, the Snapshot_Records, the Approvals table, and the Artifact_Bucket `builds/` prefix.
7. THE Config_Compiler SHALL hold no permission in its IAM role to delete any object or object version, including objects under the Artifact_Bucket `builds/` prefix.

## Open Questions

1. **Rule-evaluation order.** Resolved: the compiler follows the Rule_Evaluator semantics of logic-checks-golden-cases, where at most one Non-catch-all Rule matches (enforced by the exclusivity check) and the Catch_All_Rule applies otherwise. Requirement 3.10 tests that the compiled form agrees with the Rule_Evaluator.
2. **Task timing details.** The LogicModel has no value for how many days before the due date a task appears (`cht-conf` `start`). Is the due date anchored to the Assessment_Form report date, and does `openForDays` map to the task window end?
3. **Constraints.** The LogicModel has no value ranges, so `constraint` expressions can only come from Input types. Is that intended, or does the schema need range fields?
4. **Naming and languages.** How are Form IDs and file names (for example `sick_child_assessment`) derived from the `pathway`, and which languages does the Translations_File cover?
5. **Preview Snapshots.** §11 mentions preview builds for before/after comparisons, but this spec compiles approved Snapshots only. Does Config_Diff need compiles of unapproved preview Snapshots?
6. **Failure categories.** This spec maps `not_approved` and Integrity check failures to `build_or_test` (no automatic Tooling_Retry), and `toolchain_mismatch` and `output_mismatch` to `infrastructure`. Confirm with the pipeline-orchestrator spec.
