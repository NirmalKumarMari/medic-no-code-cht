# Requirements Document

## Introduction

This spec covers pipeline state 4 of the Vera Solution Design (§6): the deterministic logic checks and golden cases that run on every Snapshot before content approval. The Logic_Checker is code and never a model. It runs five checks: completeness, exclusivity, reachability, catch-all, and golden cases (§16). The ~12 golden cases are worked examples from the guideline. The team writes them, Medic confirms them in the clinician role, and they are stored as a versioned set in the `golden-cases/` directory. The Golden_Case_Version feeds the snapshotHash (§10).

The spec also defines the Rule_Evaluator. This deterministic evaluator computes a pathway outcome from a LogicModel and a set of Input values. The golden-case check uses it, and so does the build-test-sandbox spec when it needs the expected outcome of each synthetic patient. Expected outcomes therefore always come from the approved logic (design rule 6).

AI drafts and hand edits get identical checks (design rule 3). A failing check produces a failed overall result, which blocks content approval. Open ambiguity Flags are reported so that a person resolves them (design rule 7). The checks are on the "never cut" list (§19).

### Dependencies

| Spec | What this spec uses or provides |
|---|---|
| logic-model-snapshots | Uses: LogicModel_Schema, Snapshot_Service read by snapshotHash, Integrity check, Hash_Inputs, canonical serialization rules. Provides: Golden_Case_Version as a Hash_Inputs component. |
| pipeline-orchestrator | Invokes a Logic_Checker run at state 4; consumes the overall result; owns the `checked` transition and the rule that `content_review` cannot be exited while an ambiguity is open. |
| review-ui-approvals | Displays the Check_Report to the approver; records content approvals in the Decision_Log. |
| build-test-sandbox | Requests expected Outcomes and the coverage set from the Expected_Outcome_Service for synthetic-patient tests. |
| authoring-agents | Produce the Snapshots and Flags that are checked; receive no access to golden cases through this spec. |
| cht-config-compiler, cht-deployer | No direct interface; downstream of a passing check run. |
| platform-infrastructure | Provides the Artifact_Bucket and the compute and IAM roles that run the Logic_Checker. |

## Glossary

Terms reused from the logic-model-snapshots spec keep the meaning defined there.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **LogicModel**, **Snapshot**, **snapshotHash**, **Hash_Inputs**, **Input**, **Rule**, **Condition**, **Comparison**, **Comparison operator**, **Action**, **Follow_Up**, **Flag**, **Source**, **Origin**, **Integrity check**, **Canonical_Form**, **JSON path**, **changeId**, **Artifact_Bucket**: As defined in the logic-model-snapshots spec.
- **Golden_Case_Version**: The version identifier of one Golden_Case_Set, defined by this spec and hashed into the snapshotHash.
- **Snapshot_Service**: The logic-model-snapshots component that stores and returns Snapshots by snapshotHash.
- **Pipeline_Orchestrator**: The Step Functions state machine and its workers, defined in the pipeline-orchestrator spec.
- **Decision_Log**: The append-only log of human decisions (§6), in which content approvals are recorded by the review-ui-approvals and pipeline-orchestrator specs.
- **Medic_Clinician**: A person from Medic acting in the clinician role.
- **Logic_Checker**: The deterministic code component that runs the Check_Suite on one Snapshot.
- **Check_Suite**: The five checks run on every Snapshot: the completeness check, the exclusivity check, the reachability check, the catch-all check, and the golden-case check.
- **Run**: One execution of the Check_Suite on one Snapshot.
- **Catch_All_Rule**: A Rule whose Condition is `otherwise: true`.
- **Non-catch-all Rule**: A Rule whose Condition is an `all` list of Comparisons.
- **Input_Combination**: An assignment of one value to each Input of a LogicModel.
- **Satisfies**: An Input_Combination satisfies a Non-catch-all Rule when every Comparison in the Rule's `all` list is true for that Input_Combination. An Input_Combination satisfies a Catch_All_Rule when the Input_Combination satisfies no Non-catch-all Rule.
- **Value_Class**: A set of values of one Input within which every Comparison on that Input has the same truth value, together with one representative value from the set.
- **Input_Space**: The set of every Input_Combination formed by assigning one Value_Class representative to each Input.
- **Input_Space_Limit**: The configured maximum number of Input_Combinations in an Input_Space.
- **Outcome**: The result of evaluating one Input_Combination: the satisfied Rule's id, the Rule's Action, and the Rule's Follow_Up or the absence of one.
- **Rule_Evaluator**: The deterministic component that computes the Outcome of an Input_Combination against a LogicModel.
- **Counterexample**: An Input_Combination that demonstrates why a check failed.
- **Witness**: An Input_Combination that satisfies a given Rule.
- **Fall_Through_Combination**: An Input_Combination that satisfies only the Catch_All_Rule.
- **Golden_Case**: One worked example from the guideline: a case id, an Input_Combination, an expected Action, an expected Follow_Up or the absence of one, and the Source of the worked example.
- **Golden_Case_Set**: The versioned collection of Golden_Cases for one pathway.
- **Golden_Case_Schema**: The schema that every Golden_Case_Set must satisfy.
- **Golden_Case_Directory**: The `golden-cases/` directory that holds every Golden_Case_Set.
- **Golden_Case_Store**: The component that stores, versions, parses, and returns Golden_Case_Sets.
- **Golden_Case_Confirmation**: A record, stored separately from the Golden_Case_Set, stating that a Medic_Clinician confirmed one Golden_Case_Version.
- **Check_Report**: The output of one Run, made of Check_Results and Run_Metadata.
- **Check_Results**: The deterministic part of a Check_Report: the snapshotHash, the Golden_Case_Version, the Logic_Checker version, the Rule_Evaluator version, each check's result and findings, the Flags listing, and the overall result.
- **Run_Metadata**: The non-deterministic part of a Check_Report: the changeId and the Run start and end times.
- **Overall result**: The single pass or fail value of a Run that the Pipeline_Orchestrator uses as the state 4 gate.
- **Expected_Outcome_Service**: The operation that returns expected Outcomes and the coverage set for an approved Snapshot to the build-test-sandbox.
- **Logic_Checker configuration**: The settings the Logic_Checker reads at the start of a Run, including the Input_Space_Limit and the maximum Run duration.
- **Maximum Run duration**: The configured longest time one Run may take before the Logic_Checker ends it (Requirement 1.10).
- **Comparison on an Input**: A Comparison, in any Rule, that references that Input's id (Requirement 2.1).
- **Error result**: A Rule_Evaluator result that holds no Outcome and states why no Outcome was produced (Requirement 6).
- **Coverage set**: The Rule ids and Witnesses, one per Rule that has a Witness, that the Expected_Outcome_Service returns from the most recent passing Check_Report for an approved snapshotHash (Requirement 7.6).
- **Check_Report location**: The Artifact_Bucket location of one stored Check_Report, which contains the Snapshot's snapshotHash and is unique to the Run (Requirement 10.9).

## Requirements

### Requirement 1: Logic Check Runs

**User Story:** As a clinician reviewer, I want every Snapshot checked by the same deterministic code before I see it, so that I only review logic with no missing branches, overlaps, or unreachable parts.

#### Acceptance Criteria

1. WHEN the Pipeline_Orchestrator requests a Run for a snapshotHash and a changeId, THE Logic_Checker SHALL read the Snapshot identified by that snapshotHash from the Snapshot_Service before running any check in the Check_Suite.
2. IF the Snapshot_Service returns no Snapshot, reports an Integrity check failure, or returns an error for the requested snapshotHash, THEN THE Logic_Checker SHALL end the Run without running any check, with a failed Overall result and an error that names the snapshotHash and states which of these three causes occurred.
3. WHEN the Logic_Checker has read a Snapshot that passes the Integrity check, THE Logic_Checker SHALL run all five checks of the Check_Suite and record exactly one pass or fail result for each check, including when an earlier check in the Run has failed.
4. THE Logic_Checker SHALL apply the same five checks and the same Logic_Checker configuration to every Snapshot regardless of the Snapshot's Origin, with no check skipped, added, or configured differently on the basis of Origin.
5. THE Logic_Checker SHALL compute every check result from only the Snapshot, the Golden_Case_Set identified by the Snapshot's Golden_Case_Version, and the Logic_Checker configuration, without invoking any model and without reading the changeId, the current time, or any random source.
6. IF a check stops with an error before producing a pass or fail result, THEN THE Logic_Checker SHALL record that check as failed with an error that names the check and describes the cause.
7. IF a check stops with an error before producing a pass or fail result, THEN THE Logic_Checker SHALL continue with the remaining checks of the Check_Suite.
8. FOR ALL pairs of Snapshots with identical LogicModel content and identical Golden_Case_Version but different Origin, Runs with the same Logic_Checker version and the same Logic_Checker configuration SHALL produce Check_Results in Canonical_Form that are byte-identical apart from the snapshotHash field (Origin-independence property).
9. IF a Run request from the Pipeline_Orchestrator lacks a snapshotHash or a changeId, or holds an empty value for either, THEN THE Logic_Checker SHALL reject the request without starting a Run and return to the Pipeline_Orchestrator an error naming each missing or empty field.
10. IF a Run has not finished when its elapsed time reaches the maximum Run duration set in the Logic_Checker configuration, THEN THE Logic_Checker SHALL end the Run with a failed Overall result and record each check without a result as failed with an error stating the maximum Run duration.

### Requirement 2: Input Space

**User Story:** As a clinician reviewer, I want the checks to cover every distinct combination of answers, so that a pass means the whole pathway was examined rather than a sample.

#### Acceptance Criteria

1. THE Logic_Checker SHALL partition the values valid for each Input's type into Value_Classes, so that every valid value belongs to exactly one Value_Class, using only the Input's type and every Comparison in any Rule that references the Input's id (a Comparison on that Input).
2. THE Logic_Checker SHALL derive exactly two Value_Classes for each `yes_no` Input, one holding only `yes` with representative `yes` and one holding only `no` with representative `no`, including when no Comparison on that Input exists.
3. THE Logic_Checker SHALL derive the Value_Classes of an `integer` Input as the maximal contiguous ranges of the unbounded integer domain within which every Comparison on that Input has a constant truth value, giving a single Value_Class that covers every integer when no Comparison on that Input exists.
4. FOR ALL pairs of values in the same Value_Class, every Comparison on the Value_Class's Input SHALL evaluate to the same truth value under the Rule_Evaluator (partition soundness property).
5. THE Logic_Checker SHALL form the Input_Space from every assignment of one Value_Class representative to each Input of the LogicModel, so that the Input_Space holds exactly one Input_Combination for each distinct choice of one Value_Class per Input.
6. IF an Input's type has no Value_Class derivation defined in criteria 2 and 3, or a Comparison on that Input uses a Comparison operator that the Rule_Evaluator does not implement for that type, THEN THE Logic_Checker SHALL fail the completeness, exclusivity, and reachability checks with an error naming each such Input id with its type and each such Comparison operator with its Rule id.
7. IF the Input_Space size, computed as the product of the Value_Class counts of all Inputs, is greater than the Input_Space_Limit, THEN THE Logic_Checker SHALL fail the completeness, exclusivity, and reachability checks with an error stating the Input_Space size and the Input_Space_Limit.
8. THE Logic_Checker SHALL use as the representative of each `integer` Value_Class the smallest integer in the Value_Class, or the largest integer when the Value_Class has no lower bound, or 0 when the Value_Class has neither a lower nor an upper bound.
9. THE Logic_Checker SHALL use as the Input_Space_Limit the integer from 1 to 1,000,000 set in the Logic_Checker configuration, or 100,000 when the configuration sets no Input_Space_Limit.
10. WHEN the Logic_Checker has derived the Value_Classes of every Input, THE Logic_Checker SHALL record in the Check_Results each Input id with its Value_Classes in ascending order of representative (`no` before `yes`), each Value_Class's integer range or member value and its representative, the Input_Space size, and the Input_Space_Limit.

### Requirement 3: Completeness and Catch-All Checks

**User Story:** As a clinician reviewer, I want to know that every patient presentation leads to an outcome, and which presentations fall through to the default, so that no patient is left without advice.

#### Acceptance Criteria

1. WHEN the catch-all check runs on a LogicModel that contains exactly one Catch_All_Rule, THE Logic_Checker SHALL pass the catch-all check and record that Catch_All_Rule's id in the catch-all check findings.
2. IF the LogicModel contains no Catch_All_Rule, THEN THE Logic_Checker SHALL fail the catch-all check with a finding stating that no Catch_All_Rule exists, even when every Input_Combination in the Input_Space satisfies at least one Non-catch-all Rule.
3. IF the LogicModel contains two or more Catch_All_Rules, THEN THE Logic_Checker SHALL fail the catch-all check and record the id of every Catch_All_Rule in the catch-all check findings.
4. THE Logic_Checker SHALL determine, for the completeness check, whether each Input_Combination in the Input_Space satisfies each Rule of the LogicModel, including each Catch_All_Rule.
5. IF an Input_Combination in the Input_Space satisfies no Rule, THEN THE Logic_Checker SHALL fail the completeness check and record that Input_Combination, holding one Value_Class representative for every Input of the LogicModel, as a Counterexample.
6. THE Logic_Checker SHALL record every Fall_Through_Combination and the Fall_Through_Combination count, which is zero when no Fall_Through_Combination exists, as informational completeness check findings that leave the completeness check result unchanged.
7. FOR ALL Counterexamples recorded by the completeness check, evaluating the Counterexample against the LogicModel with the Rule_Evaluator SHALL return the error stating that no Rule matched (completeness soundness property).
8. WHEN every Input_Combination in the Input_Space satisfies at least one Rule, THE Logic_Checker SHALL pass the completeness check.
9. IF the Input_Space holds more Input_Combinations than the Input_Space_Limit, THEN THE Logic_Checker SHALL still run the catch-all check and compute its result from the Conditions of the LogicModel's Rules alone.
10. FOR ALL Fall_Through_Combinations recorded for a LogicModel with exactly one Catch_All_Rule, evaluating the Fall_Through_Combination against the LogicModel with the Rule_Evaluator SHALL return the Outcome of that Catch_All_Rule (fall-through soundness property).

### Requirement 4: Exclusivity Check

**User Story:** As a clinician reviewer, I want overlapping conditions caught before review, so that no patient can match two different instructions.

#### Acceptance Criteria

1. WHILE the Input_Space holds no more Input_Combinations than the Input_Space_Limit, THE Logic_Checker SHALL test every Input_Combination in the Input_Space against every Non-catch-all Rule for the exclusivity check.
2. IF an Input_Combination in the Input_Space satisfies two or more Non-catch-all Rules, THEN THE Logic_Checker SHALL fail the exclusivity check.
3. WHEN the exclusivity check fails, THE Logic_Checker SHALL record exactly once each unordered pair of Non-catch-all Rule ids that at least one Input_Combination satisfies together, including every pair among three or more Non-catch-all Rules satisfied by the same Input_Combination, with at least one Counterexample that satisfies both Rules of the pair.
4. THE Logic_Checker SHALL fail the exclusivity check for overlapping Non-catch-all Rules even when the overlapping Rules have equal Actions and equal Follow_Ups, with two absent Follow_Ups counted as equal.
5. FOR ALL Counterexamples recorded by the exclusivity check, THE Rule_Evaluator SHALL return an error whose listed satisfied Rule ids include both Rule ids of the recorded pair (exclusivity soundness property).
6. WHEN the exclusivity check has tested every Input_Combination in the Input_Space and found none that satisfies two or more Non-catch-all Rules, THE Logic_Checker SHALL pass the exclusivity check with no recorded pairs, including when the LogicModel has zero or one Non-catch-all Rule.
7. IF a Comparison in a Non-catch-all Rule references an Input id absent from the LogicModel's `inputs` or uses a Comparison operator that the Logic_Checker does not implement, THEN THE Logic_Checker SHALL fail the exclusivity check with an error naming the Rule id and either the absent Input id or the unimplemented Comparison operator.
8. FOR ALL pairs of Non-catch-all Rules that at least one Input_Combination in the Input_Space satisfies together, THE Logic_Checker SHALL record that pair in the exclusivity check findings (exclusivity completeness property).

### Requirement 5: Reachability Check

**User Story:** As a clinician reviewer, I want every question used and every rule able to fire, so that the pathway contains no dead questions or dead instructions.

#### Acceptance Criteria

1. IF an Input in the LogicModel's `inputs` appears in no Comparison of any Rule, with Comparisons in Rules recorded as unreachable counted as appearances, THEN THE Logic_Checker SHALL fail the reachability check and record one finding marking that Input id as unused for each such Input.
2. IF a Non-catch-all Rule is satisfied by no Input_Combination in the Input_Space, including a Non-catch-all Rule that holds a Comparison referencing an Input id absent from the LogicModel's `inputs`, THEN THE Logic_Checker SHALL fail the reachability check and record one finding marking that Rule id as unreachable for each such Rule.
3. IF a Comparison references an Input id absent from the LogicModel's `inputs`, THEN THE Logic_Checker SHALL fail the reachability check and record one finding holding the Rule id and the absent Input id for each such Comparison.
4. THE Logic_Checker SHALL record, whether the reachability check passes or fails, exactly one Witness labelled with the Rule id for each Rule (each Catch_All_Rule included) that at least one Input_Combination in the Input_Space satisfies.
5. THE Logic_Checker SHALL record a Fall_Through_Combination as the Witness of each Catch_All_Rule that has a Witness.
6. IF every Input_Combination in the Input_Space satisfies at least one Non-catch-all Rule, THEN THE Logic_Checker SHALL record each Catch_All_Rule id as unreachable in an informational note.
7. THE Logic_Checker SHALL compute the reachability check result without regard to whether a Catch_All_Rule is unreachable.
8. FOR ALL Witnesses recorded by the reachability check, each Witness SHALL be a member of the Input_Space that satisfies the Rule whose id the Witness is labelled with (Witness validity property).
9. WHEN every Input in the LogicModel's `inputs` appears in at least one Comparison, every Non-catch-all Rule is satisfied by at least one Input_Combination in the Input_Space, and every Comparison references an Input id present in the LogicModel's `inputs`, THE Logic_Checker SHALL pass the reachability check.
10. IF the Input_Space holds more Input_Combinations than the Input_Space_Limit, THEN THE Logic_Checker SHALL still record the unused-Input findings and the absent-Input findings for that Run.
11. IF the Input_Space holds more Input_Combinations than the Input_Space_Limit, THEN THE Logic_Checker SHALL record no Witness and no unreachable Rule id for that Run.

### Requirement 6: Rule Evaluator

**User Story:** As a developer of the checks and the test harness, I want one deterministic evaluator that computes a pathway outcome from the logic, so that golden cases and synthetic patients are judged by the same code and never by a model.

#### Acceptance Criteria

1. WHEN given a LogicModel and an Input_Combination that satisfies exactly one Non-catch-all Rule, THE Rule_Evaluator SHALL return the Outcome of that Non-catch-all Rule, holding the Rule id, the Rule's Action, and either the Rule's Follow_Up `dueInDays` and `openForDays` values or an explicit indication that the Rule has no Follow_Up.
2. WHEN given a LogicModel that contains exactly one Catch_All_Rule and an Input_Combination that satisfies no Non-catch-all Rule, THE Rule_Evaluator SHALL return the Outcome of that Catch_All_Rule, holding the same fields as the Outcome in criterion 1.
3. IF the Input_Combination satisfies two or more Non-catch-all Rules, THEN THE Rule_Evaluator SHALL return an error result that holds no Outcome and lists every satisfied Non-catch-all Rule id, sorted in ascending Unicode code-point order.
4. IF the Input_Combination satisfies no Non-catch-all Rule and the LogicModel contains no Catch_All_Rule, THEN THE Rule_Evaluator SHALL return an error result that holds no Outcome and states that no Rule matched.
5. IF the Input_Combination lacks a value for one or more Inputs referenced by any Comparison in the LogicModel, THEN THE Rule_Evaluator SHALL return an error result that holds no Outcome and names every such Input id, sorted in ascending Unicode code-point order.
6. IF the Input_Combination holds a value that is invalid for the `type` of the Input it is assigned to, where only `yes` and `no` are valid for `yes_no`, only JSON integers are valid for `integer`, and only the values the LogicModel_Schema allows are valid for any other Input type, THEN THE Rule_Evaluator SHALL return an error result that holds no Outcome and names every such Input id together with its value, sorted by Input id in ascending Unicode code-point order.
7. IF any Comparison in the LogicModel uses a Comparison operator that the Rule_Evaluator does not implement, THEN THE Rule_Evaluator SHALL return an error result that holds no Outcome and names each such Comparison operator with the id of every Rule that uses it, whether or not the Input_Combination would satisfy that Rule.
8. THE Rule_Evaluator SHALL compute every Outcome and every error result from the LogicModel and the Input_Combination alone, reading no system clock, random source, environment variable, file, network service, Golden_Case_Set, or model.
9. FOR ALL LogicModels and Input_Combinations, evaluating the same pair twice, in the same process or in separate processes, SHALL return results that are byte-identical in Canonical_Form, including error results (determinism property).
10. FOR ALL LogicModels and Input_Combinations, reordering the LogicModel's Rules, the LogicModel's Inputs, the Comparisons within any `all` list, or the entries of the Input_Combination SHALL leave the Rule_Evaluator's result byte-identical in Canonical_Form (order-independence property).
11. IF the Input_Combination satisfies no Non-catch-all Rule and the LogicModel contains two or more Catch_All_Rules, THEN THE Rule_Evaluator SHALL return an error result that holds no Outcome and lists every Catch_All_Rule id, sorted in ascending Unicode code-point order.
12. IF the Input_Combination holds a value for one or more Input ids that the LogicModel's `inputs` do not declare under exact, case-sensitive comparison, THEN THE Rule_Evaluator SHALL return an error result that holds no Outcome and names every such Input id, sorted in ascending Unicode code-point order.
13. IF one or more of the conditions in criteria 5, 6, 7, and 12 hold for one evaluation, THEN THE Rule_Evaluator SHALL return one error result that reports every condition that holds, in the order of criteria 5, 6, 7, and 12, in place of any Outcome or error result from criteria 1, 2, 3, 4, and 11.

### Requirement 7: Expected Outcomes for Synthetic-Patient Tests

**User Story:** As an IT lead, I want synthetic-patient expected outcomes computed from the approved Snapshot by the same evaluator, so that the test report shows whether the built form behaves as the approved logic predicts.

#### Acceptance Criteria

1. WHEN the build-test-sandbox requests expected Outcomes for a snapshotHash and a list of Input_Combinations, THE Expected_Outcome_Service SHALL return one result per Input_Combination, in the order of the request list, holding the Outcome that the Rule_Evaluator computes for that Input_Combination against the LogicModel of the Snapshot that the Snapshot_Service returns for that snapshotHash.
2. IF the Decision_Log holds no content approval for the snapshotHash of an expected-Outcome request or a coverage-set request, THEN THE Expected_Outcome_Service SHALL reject the request with an error naming the snapshotHash and return no Outcomes and no Witnesses.
3. FOR ALL snapshotHashes with a content approval in the Decision_Log and all Input_Combinations, THE Expected_Outcome_Service SHALL return a result identical to the result that the Rule_Evaluator used by the Logic_Checker for the golden-case check returns for the same LogicModel and Input_Combination (evaluator-equivalence property).
4. WHEN the Expected_Outcome_Service returns expected Outcomes, THE Expected_Outcome_Service SHALL include in the response the snapshotHash and the version of the Rule_Evaluator that computed the Outcomes.
5. IF the Rule_Evaluator returns an error for an Input_Combination, THEN THE Expected_Outcome_Service SHALL return that error in place of an Outcome at that Input_Combination's position and still return results for every other Input_Combination in the request.
6. WHEN the build-test-sandbox requests the coverage set for a snapshotHash with a content approval in the Decision_Log, THE Expected_Outcome_Service SHALL return, sorted by Rule id, the Rule id and the Witness of every Rule that has a Witness recorded in the most recently stored passing Check_Report for that snapshotHash, together with that Check_Report's Rule_Evaluator version.
7. IF the Snapshot_Service returns no Snapshot or reports an Integrity check failure for the snapshotHash of an expected-Outcome request, THEN THE Expected_Outcome_Service SHALL reject the request with an error naming the snapshotHash and return no Outcomes.
8. IF an Input_Combination in an expected-Outcome request assigns a value to an Input id absent from the LogicModel's `inputs`, THEN THE Expected_Outcome_Service SHALL return an error naming that Input id in place of an Outcome at that Input_Combination's position and still return results for every other Input_Combination in the request.
9. IF the Artifact_Bucket holds no Check_Report with a passing Overall result for the snapshotHash of a coverage-set request, THEN THE Expected_Outcome_Service SHALL reject the request with an error naming the snapshotHash and return no Witnesses.

### Requirement 8: Golden Case Sets

**User Story:** As a program officer, I want about 12 worked examples from the guideline, written by the team, confirmed by Medic, and stored as a versioned set, so that every draft is tested against the guideline's own examples.

#### Acceptance Criteria

1. THE Golden_Case_Store SHALL store every Golden_Case_Version of every Golden_Case_Set as a separate entry in the Golden_Case_Directory.
2. THE Golden_Case_Store SHALL store with each Golden_Case_Version the pathway, the guideline name and version, the Golden_Case_Version, the authoring team member's identity, and the Golden_Cases.
3. THE Golden_Case_Schema SHALL require a pathway, a guideline name and version, an authoring team member, and 1 to 100 Golden_Cases, each Golden_Case holding a case id of 1 to 64 characters that is unique within the Golden_Case_Set, an Input_Combination with at least one Input value, an expected Action, either an expected Follow_Up or an explicit statement that no Follow_Up is expected, and a Source.
4. IF a submitted Golden_Case_Set fails the Golden_Case_Schema, THEN THE Golden_Case_Store SHALL reject the Golden_Case_Set with an error listing every failing JSON path, not only the first, assign no Golden_Case_Version, and leave the Golden_Case_Directory unchanged.
5. WHEN the Golden_Case_Store stores a Golden_Case_Set whose canonical serialization, excluding the Golden_Case_Version, differs from that of the most recently stored Golden_Case_Version for the same pathway, THE Golden_Case_Store SHALL assign the Golden_Case_Set a new Golden_Case_Version that differs from every Golden_Case_Version previously assigned for any pathway.
6. IF a request would modify or delete a stored Golden_Case_Version, THEN THE Golden_Case_Store SHALL reject the request with an error naming the Golden_Case_Version and leave the stored bytes of that Golden_Case_Version unchanged.
7. WHEN a Medic_Clinician confirms a stored Golden_Case_Version, THE Golden_Case_Store SHALL record, separately from the Golden_Case_Set, a Golden_Case_Confirmation holding the Medic_Clinician's identity, the confirmation time in UTC, and the confirmed Golden_Case_Version, applying to that Golden_Case_Version only and leaving the Golden_Case_Set's stored bytes and Golden_Case_Version unchanged.
8. WHEN a component requests the current Golden_Case_Version for a pathway, THE Golden_Case_Store SHALL return the Golden_Case_Version most recently stored for that pathway, whether or not that Golden_Case_Version has a Golden_Case_Confirmation.
9. FOR ALL valid Golden_Case_Sets, serializing with the canonical serialization rules, parsing the resulting bytes, and serializing again SHALL produce identical bytes (round-trip property).
10. WHEN a submitted Golden_Case_Set's canonical serialization, excluding the Golden_Case_Version, is byte-identical to that of the most recently stored Golden_Case_Version for the same pathway, THE Golden_Case_Store SHALL return the existing Golden_Case_Version and store no new entry in the Golden_Case_Directory.
11. IF a component requests the current Golden_Case_Version for a pathway that has no stored Golden_Case_Set, THEN THE Golden_Case_Store SHALL return an error naming the pathway in place of a Golden_Case_Version.
12. IF a confirmation names a Golden_Case_Version that the Golden_Case_Store does not hold, THEN THE Golden_Case_Store SHALL reject the confirmation with an error naming the Golden_Case_Version and record no Golden_Case_Confirmation.

### Requirement 9: Golden-Case Check

**User Story:** As a clinician reviewer, I want each draft's logic run against the confirmed worked examples, so that I know the logic matches the guideline before I approve it.

#### Acceptance Criteria

1. WHEN a Run starts, THE Logic_Checker SHALL load from the Golden_Case_Store the Golden_Case_Set whose Golden_Case_Version equals the Golden_Case_Version recorded in the Snapshot's Hash_Inputs, even when the Golden_Case_Store holds a later Golden_Case_Version for the same pathway.
2. IF the Golden_Case_Store holds no Golden_Case_Set for the recorded Golden_Case_Version, or returns an error in place of a Golden_Case_Set, THEN THE Logic_Checker SHALL fail the golden-case check with an error naming the Golden_Case_Version.
3. IF the loaded Golden_Case_Set's pathway is not an exact, case-sensitive match of the LogicModel's `pathway`, THEN THE Logic_Checker SHALL fail the golden-case check without evaluating any Golden_Case and with an error naming both pathways.
4. WHEN the Golden_Case_Set loads and its pathway exactly matches the LogicModel's `pathway`, THE Logic_Checker SHALL evaluate the Input_Combination of every Golden_Case in the Golden_Case_Set against the LogicModel with the Rule_Evaluator exactly once, continuing to the remaining Golden_Cases after any Golden_Case fails.
5. WHEN the Rule_Evaluator returns an Outcome for a Golden_Case that assigns values only to Input ids in the LogicModel's `inputs`, and the Outcome's Action and Follow_Up match the Golden_Case's expected Action and expected Follow_Up, THE Logic_Checker SHALL pass that Golden_Case, where two values match when they are byte-identical under the canonical serialization rules or when both Follow_Ups are absent.
6. IF the Outcome's Action or Follow_Up does not match the Golden_Case's expected Action or expected Follow_Up, including when exactly one of the two Follow_Ups is absent, THEN THE Logic_Checker SHALL fail that Golden_Case and record its case id, the expected Action, the expected Follow_Up or its absence, and the Outcome's Rule id, Action, and Follow_Up or its absence.
7. IF the Rule_Evaluator returns an error in place of an Outcome for a Golden_Case, THEN THE Logic_Checker SHALL fail that Golden_Case and record its case id and the Rule_Evaluator error.
8. IF a Golden_Case assigns a value to one or more Input ids absent from the LogicModel's `inputs`, THEN THE Logic_Checker SHALL fail that Golden_Case regardless of its Outcome and record its case id and every such Input id.
9. IF one or more Golden_Cases fail, THEN THE Logic_Checker SHALL fail the golden-case check.
10. WHEN the golden-case check finishes, THE Logic_Checker SHALL record in the golden-case check findings the Golden_Case_Version, the number of Golden_Cases in the loaded Golden_Case_Set (zero when no Golden_Case_Set loaded), the number of passing Golden_Cases, the number of failing Golden_Cases, and either the Medic_Clinician identity and confirmation time of each Golden_Case_Confirmation for that Golden_Case_Version or a statement that no Golden_Case_Confirmation exists.
11. WHEN every Golden_Case in the loaded Golden_Case_Set passes, THE Logic_Checker SHALL pass the golden-case check.
12. THE Logic_Checker SHALL compute the same golden-case check result whether or not a Golden_Case_Confirmation exists for the Golden_Case_Version.

### Requirement 10: Check Report and Gate Result

**User Story:** As a clinician reviewer, and as the Pipeline_Orchestrator, I want one stored report per Run with a single overall result, so that a failing check blocks content approval and the reviewer can see exactly what failed.

#### Acceptance Criteria

1. WHEN a Run ends, including a Run ended early by an error, THE Logic_Checker SHALL produce exactly one Check_Report made of Check_Results and Run_Metadata, with the Run_Metadata holding the changeId from the Run request and the Run start and end times in UTC.
2. THE Logic_Checker SHALL record in the Check_Results, for each of the five checks in the Check_Suite, the check name, the pass or fail result, the offending Rule ids, the offending Input ids, the Counterexamples, the check-specific findings required by Requirements 3, 4, 5, and 9, and any error, using an empty list where a check has no entries of a kind.
3. WHEN a Run ends with a pass result recorded for each of the five checks in the Check_Suite, THE Logic_Checker SHALL set the Overall result to pass.
4. IF any of the five checks in the Check_Suite has a fail result or has no recorded result, THEN THE Logic_Checker SHALL set the Overall result to fail.
5. THE Logic_Checker SHALL list every Flag of the LogicModel in the Check_Results, grouped by Flag type in ascending order of the type value and kept in LogicModel order within each group, together with the count of `ambiguity` Flags, recorded as 0 when the LogicModel holds no `ambiguity` Flag.
6. THE Logic_Checker SHALL compute the Overall result from the five check results alone, leaving it unchanged by the number or type of Flags and leaving the Flag-based `content_review` exit rule to the Pipeline_Orchestrator.
7. THE Logic_Checker SHALL sort every list in the Check_Results except the Flags listing in ascending case-sensitive order of element id (check name, Rule id, Input id, or Golden_Case case id) where entries carry one, and then in ascending order of Input_Combination, comparing values Input by Input in ascending Input id order with integer values in numeric order and other values in string order.
8. FOR ALL Runs on the same Snapshot with the same Golden_Case_Version, the same Logic_Checker version, and the same Logic_Checker configuration, THE Logic_Checker SHALL produce byte-identical Check_Results in Canonical_Form (determinism property).
9. WHEN a Run ends, THE Logic_Checker SHALL store the Check_Report in the Artifact_Bucket, whether the Overall result is pass or fail, at a location that contains the Snapshot's snapshotHash and is unique to the Run, leaving every earlier Check_Report for that snapshotHash unchanged.
10. WHEN the Check_Report is stored, THE Logic_Checker SHALL return to the Pipeline_Orchestrator the Overall result recorded in the stored Check_Report, the snapshotHash, and the Check_Report location.
11. IF storing the Check_Report fails, THEN THE Logic_Checker SHALL return to the Pipeline_Orchestrator a failed Overall result, the snapshotHash, and an error describing the storage failure, with no Check_Report location, regardless of the five check results.
12. FOR ALL valid Check_Reports, serializing then parsing SHALL produce a Check_Report whose Check_Results and Run_Metadata equal the original's field by field (round-trip property).
13. IF a Run ends before a check in the Check_Suite has recorded a result, THEN THE Logic_Checker SHALL record that check as failed in the Check_Results with an error stating why the Run ended.
14. IF the Logic_Checker cannot read the Snapshot for the requested snapshotHash, THEN THE Logic_Checker SHALL record the requested snapshotHash in the Check_Results and record the Golden_Case_Version and the Flags listing as unavailable.

## Open Questions

1. **Integer ranges.** The LogicModel_Schema has no minimum or maximum for `integer` Inputs, so Value_Classes are unbounded and Counterexamples can include values such as negative ages. Should the schema (logic-model-snapshots) add per-Input ranges?
2. **Unreachable catch-all.** Requirements 5.6 and 5.7 treat a Catch_All_Rule that can never fire as informational, because failing it would conflict with the catch-all check when the other Rules are already exhaustive. Confirm this choice.
3. **Unconfirmed golden cases.** Should a Golden_Case_Set without a Golden_Case_Confirmation fail the golden-case check, or only be reported (current draft)? Should "current" in Requirement 8.8 mean the latest confirmed version? Should a minimum of 12 Golden_Cases be enforced?
4. **Golden_Case_Directory location.** Is `golden-cases/` a repository directory, an Artifact_Bucket prefix, or both? Who may write to it?
5. **Limits and timing.** The design gives no numbers. Requirement 2.9 assumes a default Input_Space_Limit of 100,000, configurable from 1 to 1,000,000. What should the maximum Run duration be?
6. **Checker version in the hash.** Toolchain_Identity holds only the compiler version and image tag. Should the Logic_Checker and Rule_Evaluator versions join it, so that a checker change forces a new snapshotHash?
7. **Locked enumerations.** Value_Class derivation and Rule_Evaluator semantics depend on the final Input-type and Comparison-operator enumerations (logic-model-snapshots Open Question 5).
8. **Origin-independence test.** Requirement 1.8 compares Snapshots with identical LogicModel content and different Origin. Origin is not a Hash_Input in logic-model-snapshots, so two such Snapshots share one snapshotHash and only one of them can be stored. The property is therefore tested on in-memory Snapshots passed to the Logic_Checker, not on two stored Snapshots.
