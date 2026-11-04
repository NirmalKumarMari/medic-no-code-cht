# Requirements Document

## Introduction

This spec makes sure a clinician always sees when a Snapshot contains a Rule that was rejected before. When a Snapshot is rejected at Content_Approval, the Decision_Recorder stores one Rejected_Rule_Record for each distinct Rule_Fingerprint in that Snapshot, in the Approvals table. A Rule_Fingerprint ignores the Rule's id, Source and position. Before content review, the Rejected_Rule_Check compares every Rule of the new Snapshot with the Rejected_Rule_Records for the same Tenant and Pathway. Each match becomes a high-severity, advisory History_Flag shown to the reviewer. A History_Flag never blocks approval: the clinician sees it and decides.

Everything in this spec is deterministic code reading data stored in the database. No model or agent takes part. This spec replaces the former decision-memory-history-check spec: AgentCore Memory, the Memory_Writer, memory rebuild, the History_Check_Agent, the `decision-log-read` and `decision-memory-read` tools, and similarity flags are removed.

Implementation: `packages/workflow-data/src/fingerprints.ts` (Fingerprint_Calculator) and `packages/workflow-data/src/repository.ts` (`recordDecision`, `checkRuleHistory`, `recordValidation`, `openApprovalWait`).

### Change log

| Date | Change |
|---|---|
| 2026-11-04 | Rewritten to match the implementation. A matching Rule is now an advisory high-severity History_Flag that never blocks approval, instead of a failing check that keeps the Snapshot from the clinician. A Content_Rejection records every distinct Rule of the rejected Snapshot, instead of only Rules the clinician marks; Rejected_Rule_Ids are removed. Rejected_Rule_Records are materialized items in the Approvals table read with strongly consistent queries, instead of a secondary index with a visibility timeout. The check also runs again when content review opens (former Open Question 4). Conditions' `all`/`any` lists are sorted before fingerprinting (former Open Question 5). |

### Dependencies

| Spec | What this spec uses or provides |
|---|---|
| logic-model-snapshots | Uses: Snapshot, Rule, Condition, Action, Follow_Up, Snapshot_Bundle, canonical JSON, and the snapshot registration that verifies the stored Snapshot_Bundle. |
| logic-checks-golden-cases | Must refuse to pass validation for a Snapshot that requires a clinician and has no Rules, so the Rejected_Rule_Check cannot be skipped. The Rejected_Rule_Check is not part of the Overall result. |
| pipeline-orchestrator | Supplies the Tenant, the trusted workflow identity, and the History_Flag identifiers to acknowledge at Deploy_Approval. The Decision_Recorder writes the Rejected_Rule_Records defined here. |
| review-ui-approvals | Must show every History_Flag on the Content_Approval_Screen, marked high severity, with the past decision it refers to, and let the reviewer approve or reject regardless. Must show History_Flags at Deploy_Approval and collect an acknowledgment for each. |
| authoring-agents | No interface. No agent or Gateway_Tool gets access to Rejected_Rule_Records. |
| platform-infrastructure | Provides: the Approvals table and the Access_Policy. |

## Glossary

Terms marked *(lms)*, *(aa)*, *(lcgc)*, *(po)*, or *(rua)* keep the meaning defined in the logic-model-snapshots, authoring-agents, logic-checks-golden-cases, pipeline-orchestrator, or review-ui-approvals spec.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **Snapshot**, **snapshotHash**, **snapshotId**, **Rule**, **Condition**, **Action**, **Follow_Up**, **Source**, **Snapshot_Bundle**, **changeId**: *(lms)*.
- **Tenant**, **Workload_Identity**, **Agent_Gateway**, **Gateway_Tool**: *(aa)*.
- **Decision_Recorder**, **Approvals table**, **Approval_Decision**, **Content_Approval**, **Deploy_Approval**, **Pipeline_Orchestrator**: *(po)*.
- **Review_API**, **Content_Approval_Screen**, **Role_Group**: *(rua)*.
- **Pathway**: The `pathwayId` of the change that a Snapshot belongs to. A revision cannot change it.
- **Fingerprint_Input**: The object `{ version: "rule-v1", when, then, followUp }` built from one Rule, where `when` is the Rule's Condition with every `all` and `any` list sorted by the canonical JSON of its elements at every depth, `then` is the Rule's Action unchanged, and `followUp` is present only when the Rule has a Follow_Up. The Rule id, the Source, and the Rule's position are excluded.
- **Rule_Fingerprint**: The SHA-256 digest, as 64 lowercase hexadecimal characters, of the canonical JSON of one Rule's Fingerprint_Input.
- **Fingerprint_Calculator**: Deterministic code that computes Rule_Fingerprints (`fingerprintRules`).
- **Content_Rejection**: An Approval_Decision at Content_Approval with decision `reject`, made by a caller the gate allows: a `clinician` when the change requires a clinician, otherwise a `program_reviewer` or a `clinician`.
- **Rejection note**: The note of a Content_Rejection. It must not be empty or only whitespace.
- **Rejected_Rule_Record**: An append-only Approvals table item recording that one Rule_Fingerprint was in a Snapshot rejected at Content_Approval.
- **History_Key**: The partition key of a Rejected_Rule_Record: `HISTORY#{Tenant}#{Pathway}#{Rule_Fingerprint}`.
- **Rejected_Rule_Check**: The deterministic lookup defined in Requirement 4 (`checkRuleHistory`).
- **History_Flag**: The advisory finding the Rejected_Rule_Check reports for one matching Rule.
- **Access_Policy**: The IAM policies, provisioned by platform-infrastructure, that govern access to Rejected_Rule_Records.

## Requirements

### Requirement 1: Rule fingerprints

**User Story:** As a clinician, I want a rejected rule recognized by its clinical content, so that renaming, re-citing or moving the rule does not hide it from me.

#### Acceptance Criteria

1. THE Fingerprint_Calculator SHALL compute each Rule_Fingerprint as the SHA-256 digest of the canonical JSON of the Rule's Fingerprint_Input.
2. THE Fingerprint_Calculator SHALL return equal Rule_Fingerprints for two Rules that differ only in Rule id, Source, position, object key order, or the order of elements in a Condition's `all` or `any` lists.
3. THE Fingerprint_Calculator SHALL return different Rule_Fingerprints for two Rules whose Condition, Action, or Follow_Up differ in any other way, including the order of any list inside the Action.
4. THE Fingerprint_Calculator SHALL give a Rule without a Follow_Up a different Rule_Fingerprint from the same Rule with any Follow_Up.
5. THE Fingerprint_Calculator SHALL compute each Rule_Fingerprint from the Rule alone, with no model call and no read of stored data, and return the same result on every invocation.
6. IF a Rule lacks `when` or `then`, two Rules in one Snapshot share an id, a Rule id is not a valid identifier, or a Snapshot has more than 80 Rules, THEN THE Fingerprint_Calculator SHALL return an error and produce no Rule_Fingerprints.
7. WHEN a Snapshot is registered, THE Snapshot_Store SHALL compute the Rule_Fingerprints of all its Rules and store them with the Snapshot's record.

### Requirement 2: Recording rejected rules at Content_Approval

**User Story:** As a clinician, I want the rules of a snapshot I reject to be remembered, so that whoever reviews a later snapshot is told when one of them comes back.

#### Acceptance Criteria

1. WHEN the Decision_Recorder records a Content_Rejection, THE Decision_Recorder SHALL store exactly one Rejected_Rule_Record for each distinct Rule_Fingerprint stored with the rejected Snapshot.
2. THE Decision_Recorder SHALL store each Rejected_Rule_Record under its History_Key with sort key `{Decision time}#{decisionId}`, holding the Tenant, Pathway, Rule_Fingerprint, source changeId, snapshotHash, snapshotId, decisionId, decision key, decision `reject`, gate `content`, Rejection note, and Decision time.
3. WHEN the Decision_Recorder records an Approval_Decision that is not a Content_Rejection, including an `approve` at either gate and a `reject` at Deploy_Approval, THE Decision_Recorder SHALL store no Rejected_Rule_Record for it.
4. THE Decision_Recorder SHALL store the Content_Rejection and all of its Rejected_Rule_Records in one atomic transaction, so that either all of them are stored or none of them is.
5. IF a Content_Rejection has an empty Rejection note, THEN THE Decision_Recorder SHALL refuse it and store no Approval_Decision and no Rejected_Rule_Record.
6. IF two reviewers decide the same Content_Approval concurrently, THEN THE Decision_Recorder SHALL commit at most one decision, and SHALL leave no Rejected_Rule_Record unless the committed decision is a Content_Rejection.

### Requirement 3: Append-only storage of Rejected_Rule_Records

**User Story:** As an auditor, I want rejected-rule records written once and never changed, so that a recorded rejection cannot be lost, duplicated, or altered.

#### Acceptance Criteria

1. THE Decision_Recorder SHALL create each Rejected_Rule_Record only when no item with the same History_Key and sort key exists in the Approvals table.
2. WHEN the same Content_Rejection is submitted again with the same idempotency key and content, THE Decision_Recorder SHALL return the original decision and leave exactly one Rejected_Rule_Record per distinct Rule_Fingerprint.
3. THE Decision_Recorder SHALL provide no operation that updates or deletes a Rejected_Rule_Record.

### Requirement 4: Rejected_Rule_Check

**User Story:** As a clinician, I want to be told when a snapshot contains a rule that was rejected before, so that I can decide with that knowledge.

#### Acceptance Criteria

1. WHEN validation is recorded for a Snapshot, and again WHEN the Pipeline_Orchestrator opens Content_Approval for it, THE Rejected_Rule_Check SHALL run on that Snapshot and store the resulting History_Flags on the change.
2. THE Rejected_Rule_Check SHALL, for each Rule_Fingerprint stored with the Snapshot, read with a strongly consistent query the most recent Rejected_Rule_Record under the History_Key for the change's Tenant and Pathway.
3. THE Rejected_Rule_Check SHALL read no Rejected_Rule_Record of another Tenant or another Pathway.
4. IF a Rejected_Rule_Record read by the Rejected_Rule_Check does not carry the expected Tenant, Pathway, Rule_Fingerprint, decision `reject`, and gate `content`, THEN THE Rejected_Rule_Check SHALL return an integrity error.
5. WHEN a Rule of the Snapshot matches a Rejected_Rule_Record, THE Rejected_Rule_Check SHALL return one History_Flag holding: an identifier derived from the Rule id, source changeId, and decisionId; type `previously_rejected_rule`; severity `high`; `advisory: true`; the Rule id; the Rule_Fingerprint; the source changeId, decisionId, rejected snapshotHash, and rejected snapshotId; the first 320 characters of the Rejection note; and the Decision time.
6. WHEN no Rule of the Snapshot matches, THE Rejected_Rule_Check SHALL return no History_Flags.
7. THE Rejected_Rule_Check SHALL use no model call and no agent call.
8. IF a change requires a clinician and its Snapshot has no Rules, THEN validation SHALL fail, so that the Rejected_Rule_Check is never skipped on a clinical Snapshot.

### Requirement 5: Advisory flags and the human decision

**User Story:** As a clinician, I want rejected-rule matches shown to me without being decided for me, so that I stay in control of what I approve.

#### Acceptance Criteria

1. THE Pipeline_Orchestrator SHALL open Content_Approval for a Snapshot with any number of History_Flags, including zero; History_Flags SHALL NOT block or fail the check, the gate, or the decision.
2. THE Review_API SHALL show every History_Flag stored on the change at Content_Approval, marked as high severity.
3. WHEN a reviewer decides at Content_Approval, THE Decision_Recorder SHALL store the History_Flags shown with the change in the Approval_Decision, so that the decision record shows what the reviewer was told.
4. WHEN the Pipeline_Orchestrator opens Deploy_Approval with History_Flag identifiers, THE Decision_Recorder SHALL refuse an `approve` that does not acknowledge each of them, and SHALL record the acknowledged identifiers in the Approval_Decision.
5. THE Decision_Recorder SHALL accept a `reject` at Deploy_Approval whatever History_Flags it acknowledges.

### Requirement 6: Access to Rejected_Rule_Records

**User Story:** As a security reviewer, I want only the Decision_Recorder to write rejected-rule records and no agent to touch them, so that no automated author can erase or hide a clinician's rejection.

**Status: not yet implemented.** No component roles exist yet (see platform-infrastructure Requirement 7).

#### Acceptance Criteria

1. THE Access_Policy SHALL grant permission to create Rejected_Rule_Records only to the Decision_Recorder's IAM role.
2. THE Access_Policy SHALL grant the Rejected_Rule_Check's IAM role permission to query Rejected_Rule_Records and no permission to create, update, or delete items in the Approvals table.
3. THE Access_Policy SHALL grant no IAM role permission to update or delete a Rejected_Rule_Record.
4. THE Access_Policy SHALL grant no Workload_Identity permission to read or write Rejected_Rule_Records.
5. THE Agent_Gateway SHALL register no Gateway_Tool whose backing permissions read or write Rejected_Rule_Records.

## Open Questions

1. **Matching scope.** Matching is limited to the same Tenant and Pathway. Should a Rule rejected in one Pathway also be flagged in the Tenant's other Pathways?
2. **Whole-snapshot recording.** A Content_Rejection records every Rule of the rejected Snapshot, including Rules the clinician had no objection to, so later Snapshots can carry flags for acceptable Rules. Should the Review_UI let the clinician mark which Rules they reject, so only those are recorded?
3. **Wording-only rejections.** A `program_reviewer` rejection of wording-only content also records its Rules. Should only clinician rejections create Rejected_Rule_Records?
