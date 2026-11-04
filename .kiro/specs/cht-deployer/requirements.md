# Requirements Document

## Introduction

The CHT_Deployer is Vera's separate deployer step (Solution Design §13, Decisions Log #5). It uploads the exact Build_Artifacts of a tested, approved release Snapshot to the CHT_Test_Instance with a pinned `cht-conf`, checks that the instance now serves the built app settings (§16), and records the outcome in a write-once Deploy_Record. It runs under its own IAM role, the only role that can read the CHT test instance login, and reads that login only after the matching approval or rollback request is recorded (§3 rules 2, 8, 10; §11; §15). Rollback redeploys a prior tested, approved release Snapshot through the same role and the same verification (§11).

The Pipeline_Orchestrator calls the CHT_Deployer from the Deploy Pipeline_State after the Deploy_Approval Parked_Token is consumed with an `approve` decision, or after a Rollback_Request is recorded.

Dependencies, referenced and not specified here:
- **logic-model-snapshots**: Snapshot, snapshotHash, Designation, Artifact_Bucket.
- **pipeline-orchestrator**: State_Machine, Worker_API, Worker_Call_Id, Lifecycle_State transitions T12, T14, and T15, retries up to the Deploy_Retry_Limit, and Escalations.
- **build-test-sandbox**: Build_Record, Build_Id, Build_Artifact, Compile_Manifest.
- **review-ui-approvals**: Deploy_Approval decisions, Rollback_Requests, and separation-of-duties checks.
- **platform-infrastructure**: the CHT_Login_Secret, the CHT_Test_Instance, the Deployer_Role, VPC networking, and Session Manager access.

## Glossary

Terms reused from earlier specs keep the meaning defined there.

- **Vera**: The no-code CHT configuration system described in the Solution Design.
- **Snapshot**, **snapshotHash**, **Designation**, **Snapshot_Service**, **Artifact_Bucket**: As defined in the logic-model-snapshots spec. Designation is `release` or `preview`.
- **Pipeline_Orchestrator**, **Decision_Log**: As defined in the logic-checks-golden-cases spec and refined in the pipeline-orchestrator spec.
- **State_Machine**, **Pipeline_State**, **Worker_API**, **Worker_Call_Id**, **Lifecycle_State**, **Approvals table**, **Approval_Gate**, **Content_Approval**, **Deploy_Approval**, **Approved snapshotHash**, **Parked_Token**, **Rollback_Request**, **Deploy_Retry_Limit**: As defined in the pipeline-orchestrator spec.
- **Build_Record**, **Build_Id**, **Build_Artifact**, **Compile_Manifest**: As defined in the build-test-sandbox spec.
- **CHT_Deployer**: The deployer worker that the State_Machine calls through the Worker_API to upload and verify one Release_Target.
- **Deployer_Role**: The IAM role, provisioned by platform-infrastructure, under which the CHT_Deployer runs.
- **CHT_Login_Secret**: The Secrets Manager secret holding the CHT_Test_Instance login.
- **CHT_Test_Instance**: The CHT test instance on EC2, reachable only inside the VPC and through Session Manager.
- **Pinned_CHT_Conf**: The one `cht-conf` release whose version is fixed in the CHT_Deployer's configuration and installed in the CHT_Deployer's runtime.
- **Upload_Actions**: The `cht-conf` actions `upload-app-settings`, `upload-app-forms`, and `upload-custom-translations`.
- **`deploy`**, **`verify-deploy`**: The names of the CHT_Deployer's upload step (Requirement 3) and Deploy_Verification step (Requirement 4), both listed as never-available agent tools in the authoring-agents spec.
- **Deploy_Request**: A Worker_API call to the CHT_Deployer carrying a Worker_Call_Id, a request type (`deploy` or `rollback`), the Release_Target, and, for `rollback`, the Rollback_Request identifier and the changeId of the change being rolled back.
- **Release_Target**: The changeId, snapshotHash, and Build_Id whose Build_Artifacts one Deploy_Request uploads.
- **Precondition_Check**: One of the checks in Requirements 2.2 through 2.8, 3.5, and 5.2 that a Deploy_Request passes before the CHT_Deployer reads the CHT_Login_Secret.
- **Refusal**: The end of a Deploy_Request before the CHT_Login_Secret is read, with Deploy_Failure_Category `refused` and the name of the failed Precondition_Check.
- **App_Settings_Artifact**: The Build_Artifact holding the compiled app settings (`app_settings.json`) produced by `cht --no-check compile-app-settings`.
- **Served_App_Settings**: The app settings document the CHT_Test_Instance returns when the CHT_Deployer reads its settings after upload.
- **Server_Managed_Fields**: The fields that the CHT_Test_Instance adds or changes when storing app settings, listed in the design.
- **Canonical_Digest**: The digest of an app settings document after removing the Server_Managed_Fields, sorting object keys, and removing insignificant whitespace.
- **Deploy_Verification**: The deterministic comparison of the Canonical_Digest of the Served_App_Settings with the Canonical_Digest of the verified App_Settings_Artifact.
- **Deploy_Failure_Category**: `refused` (a Precondition_Check failed), `upload` (the Pinned_CHT_Conf exited with a non-zero status), or `verification` (the Deploy_Verification did not match).
- **Deploy_Record**: The write-once record of one Deploy_Request, keyed by Worker_Call_Id.
- **Deploy_Result**: The final answer to one Deploy_Request: result `deployed` or `failed`, the Deploy_Failure_Category for `failed`, the failed Precondition_Check name for a Refusal, and the Deploy_Record location.
- **Retryable error**: A response to a Deploy_Request that reports a temporary failure, stores no Deploy_Record, and lets the Pipeline_Orchestrator retry the same Worker_Call_Id.
- **Upload_Timeout**: The 600 seconds the CHT_Deployer lets the Pinned_CHT_Conf run before stopping it (Requirement 3.8).

## Requirements

### Requirement 1: Isolated Deployer Step and Secret Access

**User Story:** As a national IT lead, I want deployment credentials held only by a separate deployer that never runs build tooling, so that a compromised build or agent cannot reach the CHT test instance.

#### Acceptance Criteria

1. THE CHT_Deployer SHALL run under the Deployer_Role, which no other component or agent container uses, in a process outside the build-test-sandbox container and outside every agent container.
2. THE Deployer_Role SHALL be the only IAM role permitted to read the CHT_Login_Secret value, with the services EC2 instance role, the Pipeline_Orchestrator's role, the build-test-sandbox container's role, and every agent container's identity each denied that read.
3. THE CHT_Deployer SHALL accept a Deploy_Request only when the Deploy_Request arrives through the Worker_API from the Deploy Pipeline_State of the State_Machine.
4. IF a Deploy_Request arrives other than through the Worker_API or from a caller other than the Deploy Pipeline_State of the State_Machine, THEN THE CHT_Deployer SHALL reject the Deploy_Request with an error indicating that the caller is not authorized, without running any Precondition_Check, reading the CHT_Login_Secret, or storing a Deploy_Record.
5. THE CHT_Deployer SHALL start the Pinned_CHT_Conf installed in the CHT_Deployer's runtime as its only child process, executing no program, script, or package supplied in a Build_Artifact.
6. THE CHT_Deployer SHALL read the CHT_Login_Secret only after every Precondition_Check for the Deploy_Request has passed.
7. THE CHT_Deployer SHALL include the CHT_Login_Secret value in no network request other than a request to the CHT_Test_Instance address of Requirement 1.9.
8. THE CHT_Deployer SHALL replace the CHT_Login_Secret value and the password it holds, each in raw and URL-encoded form, with a fixed redaction marker in every log line, error text, captured Pinned_CHT_Conf output, Deploy_Record, and Deploy_Result that the CHT_Deployer writes or returns.
9. THE CHT_Deployer SHALL connect to the CHT_Test_Instance only at the private VPC address fixed in the CHT_Deployer's configuration, never at an address taken from a Deploy_Request or a Build_Artifact.
10. THE CHT_Deployer SHALL hold the CHT_Login_Secret value only in memory and only until the Deploy_Request that read it ends, writing the value to no file and passing it in no process command-line argument.
11. IF the CHT_Deployer's read of the CHT_Login_Secret fails or returns an empty value, THEN THE CHT_Deployer SHALL return a retryable error without starting the Pinned_CHT_Conf or storing a Deploy_Record.

### Requirement 2: Release-Only Preconditions

**User Story:** As a clinician, I want only the exact snapshot I approved, built and tested as a release, to reach the CHT test instance, so that a preview, failed, or altered build never ships.

#### Acceptance Criteria

1. WHEN a Deploy_Request of type `deploy` arrives from the State_Machine, THE CHT_Deployer SHALL run the Precondition_Checks of Requirements 2.2 through 2.8 and then 3.5 against the Release_Target in that order, running no later Precondition_Check after the first Precondition_Check that issues a Refusal.
2. IF the Approvals table holds no `approve` entry at Deploy_Approval whose changeId, snapshotHash, and Build_Id are each an exact, case-sensitive match of the Release_Target's changeId, snapshotHash, and Build_Id, THEN THE CHT_Deployer SHALL issue a Refusal.
3. IF the Approvals table records no Approved snapshotHash for the Release_Target's changeId, or the recorded Approved snapshotHash is not an exact, case-sensitive match of the Release_Target's full snapshotHash, THEN THE CHT_Deployer SHALL issue a Refusal.
4. IF the Snapshot_Service reports that no Snapshot exists for the Release_Target's snapshotHash, reports that the Snapshot fails its read-time integrity check, or returns a Snapshot whose Designation is any value other than `release`, THEN THE CHT_Deployer SHALL issue a Refusal.
5. IF the Artifact_Bucket holds no Build_Record for the Release_Target's Build_Id, or the Build_Record's overall result is any value other than `passed`, THEN THE CHT_Deployer SHALL issue a Refusal.
6. IF the Build_Record names a changeId or snapshotHash other than the Release_Target's, or the Compile_Manifest that the Build_Record names is absent from the Artifact_Bucket or names a snapshotHash other than the Release_Target's snapshotHash, THEN THE CHT_Deployer SHALL issue a Refusal.
7. IF the Build_Record lists no App_Settings_Artifact, or any Build_Artifact listed in the Build_Record is absent from the Artifact_Bucket, THEN THE CHT_Deployer SHALL issue a Refusal.
8. IF the Build_Record records no SHA-256 digest for a listed Build_Artifact, or the SHA-256 digest that the CHT_Deployer computes over the downloaded bytes of any Build_Artifact differs from the digest the Build_Record records for that Build_Artifact, THEN THE CHT_Deployer SHALL issue a Refusal.
9. IF, during a Precondition_Check, the Approvals table, the Snapshot_Service, or the Artifact_Bucket returns an error other than a not-found or integrity-check-failure response, or returns no response within 30 seconds of the read request, THEN THE CHT_Deployer SHALL return a retryable error without running any later Precondition_Check, storing a Deploy_Record, or reading the CHT_Login_Secret.
10. IF a Deploy_Request lacks or holds an empty Worker_Call_Id, changeId, snapshotHash, or Build_Id, holds a request type other than `deploy` or `rollback`, or holds a snapshotHash other than 64 lowercase hexadecimal characters, THEN THE CHT_Deployer SHALL reject the Deploy_Request with an error naming each missing or invalid field, before any Precondition_Check and without storing a Deploy_Record or reading the CHT_Login_Secret.

### Requirement 3: Upload of the Tested Artifacts

**User Story:** As a national IT lead, I want the deployer to upload the tested files byte for byte, so that what runs on the instance is what passed the synthetic-patient tests.

#### Acceptance Criteria

1. WHEN every Precondition_Check for a Deploy_Request passes, THE CHT_Deployer SHALL start the Pinned_CHT_Conf exactly once for that Deploy_Request, in the working directory of Requirement 3.4, to run the Upload_Actions against the CHT_Test_Instance.
2. THE CHT_Deployer SHALL name exactly the three Upload_Actions, and no compile, convert, or other `cht-conf` action, when it invokes the Pinned_CHT_Conf.
3. THE CHT_Deployer SHALL give the Pinned_CHT_Conf only files whose bytes equal the Build_Artifact bytes whose digests passed Requirement 2.8, with no file recompiled, reconverted, or otherwise modified.
4. THE CHT_Deployer SHALL place exactly the verified Build_Artifacts, each at the relative path recorded for it in the Build_Record, in a working directory that holds no file or directory when the Deploy_Request starts, before the Pinned_CHT_Conf starts.
5. IF the installed `cht-conf` reports no version, or reports a version that does not exactly match the Pinned_CHT_Conf version in the CHT_Deployer's configuration, THEN THE CHT_Deployer SHALL issue a Refusal.
6. IF the Pinned_CHT_Conf exits with a non-zero status, THEN THE CHT_Deployer SHALL end the Deploy_Request with Deploy_Failure_Category `upload` without running the Deploy_Verification.
7. WHEN a Deploy_Request ends with a Deploy_Result or a retryable error, THE CHT_Deployer SHALL delete the working directory and every file in it before returning that Deploy_Result or retryable error.
8. IF the Pinned_CHT_Conf has not exited 600 seconds after it started, THEN THE CHT_Deployer SHALL stop the Pinned_CHT_Conf and end the Deploy_Request with Deploy_Failure_Category `upload` without running the Deploy_Verification.
9. IF the CHT_Deployer cannot create the empty working directory or cannot write a verified Build_Artifact into it, THEN THE CHT_Deployer SHALL return a retryable error without reading the CHT_Login_Secret or starting the Pinned_CHT_Conf.

### Requirement 4: Deployment Verification

**User Story:** As a national IT lead, I want a deterministic check that the instance serves the built app settings, so that a deploy is reported as done only when the instance matches the tested build.

#### Acceptance Criteria

1. WHEN the Pinned_CHT_Conf exits with status 0, THE CHT_Deployer SHALL run the Deploy_Verification.
2. WHEN the Deploy_Verification starts, THE CHT_Deployer SHALL read the Served_App_Settings from the CHT_Test_Instance exactly once, after the Pinned_CHT_Conf has exited, waiting at most 30 seconds for the response.
3. THE Deploy_Verification SHALL compute the Canonical_Digest of the Served_App_Settings and of the App_Settings_Artifact bytes whose digest passed Requirement 2.8 using one Server_Managed_Fields list and one digest function for both documents.
4. WHEN the Deploy_Verification finds the two Canonical_Digests equal, THE CHT_Deployer SHALL end the Deploy_Request with result `deployed`.
5. IF the two Canonical_Digests differ, THEN THE CHT_Deployer SHALL end the Deploy_Request with result `failed` and Deploy_Failure_Category `verification` without running the Upload_Actions again.
6. IF the read of Requirement 4.2 cannot reach the CHT_Test_Instance, receives an error response, receives no response within 30 seconds, or receives a body that does not parse as a JSON object, THEN THE CHT_Deployer SHALL end the Deploy_Request with result `failed` and Deploy_Failure_Category `verification`.
7. THE Deploy_Verification SHALL compute equal Canonical_Digests for any two app settings documents that differ only in object key order, in whitespace outside string values, or in the presence or values of Server_Managed_Fields.
8. THE Deploy_Verification SHALL compute different Canonical_Digests for any two app settings documents that differ in any key, value, value type, or array element order outside the Server_Managed_Fields.
9. THE Deploy_Verification SHALL produce a byte-identical canonical form when canonicalizing an app settings document that is already in canonical form (idempotence).
10. THE Deploy_Verification SHALL send no request that creates, changes, or deletes data on the CHT_Test_Instance.
11. IF the App_Settings_Artifact does not parse as a JSON object, THEN THE CHT_Deployer SHALL end the Deploy_Request with result `failed` and Deploy_Failure_Category `verification`.

### Requirement 5: Rollback

**User Story:** As a national IT lead, I want to redeploy a prior tested, approved release snapshot through the same controls, so that every change is reversible.

#### Acceptance Criteria

1. WHEN a Deploy_Request of type `rollback` arrives from the State_Machine, THE CHT_Deployer SHALL run the Precondition_Check of Requirement 5.2 first and then the Precondition_Checks of Requirements 2.2 through 2.8 and 3.5 against the Release_Target.
2. IF a `rollback` Deploy_Request carries no Rollback_Request identifier or no changeId of the change being rolled back, or the Decision_Log holds no Rollback_Request with that identifier naming both that changeId and the Release_Target's snapshotHash, THEN THE CHT_Deployer SHALL issue a Refusal.
3. WHEN every Precondition_Check of a `rollback` Deploy_Request passes, THE CHT_Deployer SHALL run the Upload_Actions of Requirement 3 under the Deployer_Role on the Build_Artifacts listed in the Build_Record for the Release_Target's Build_Id, without producing a new build of the target Snapshot.
4. WHEN the Pinned_CHT_Conf exits with status 0 for a `rollback` Deploy_Request, THE CHT_Deployer SHALL run the Deploy_Verification of Requirement 4 against the App_Settings_Artifact of the Release_Target's Build_Id.
5. THE CHT_Deployer SHALL record the Rollback_Request identifier and the changeId of the change being rolled back, or an empty value for either one the Deploy_Request omits, in every Deploy_Record of a `rollback` Deploy_Request, including a Deploy_Record that ends in a Refusal.
6. IF the Decision_Log cannot be read during the Precondition_Check of Requirement 5.2, THEN THE CHT_Deployer SHALL return a retryable error without issuing a Refusal and without reading the CHT_Login_Secret.

### Requirement 6: Deploy_Record and Result Reporting

**User Story:** As an auditor, I want one write-once record of every deploy and rollback attempt, so that each upload can be traced to its approval, build, and verification.

#### Acceptance Criteria

1. WHEN a Deploy_Request ends with result `deployed` or `failed`, THE CHT_Deployer SHALL store exactly one Deploy_Record for the Deploy_Request's Worker_Call_Id before returning the Deploy_Result.
2. THE CHT_Deployer SHALL store each Deploy_Record in the Artifact_Bucket as one object keyed by Worker_Call_Id that the CHT_Deployer cannot overwrite or delete after it is stored.
3. IF the Artifact_Bucket already holds a Deploy_Record for the Worker_Call_Id when the CHT_Deployer stores a Deploy_Record, THEN THE CHT_Deployer SHALL keep the existing Deploy_Record unchanged and return the Deploy_Result held in the existing Deploy_Record.
4. THE Deploy_Record SHALL hold the Worker_Call_Id, the request type, the Release_Target, the Pinned_CHT_Conf version, the recorded and computed digest of each Build_Artifact, the name and pass or fail outcome of each Precondition_Check run, the failed Precondition_Check name for a Refusal, the Pinned_CHT_Conf exit status, both Canonical_Digests, the result, the Deploy_Failure_Category for result `failed`, UTC ISO 8601 timestamps with at least second precision for the Deploy_Request's arrival and for the Deploy_Result's determination, and a not-run marker in place of each value whose step did not run.
5. WHEN the Deploy_Record is stored, THE CHT_Deployer SHALL return to the Pipeline_Orchestrator through the Worker_API a Deploy_Result whose result, Deploy_Failure_Category, and failed Precondition_Check name equal the values in the stored Deploy_Record.
6. FOR ALL Deploy_Records, THE CHT_Deployer SHALL parse a serialized Deploy_Record into a Deploy_Record in which every field listed in Requirement 6.4, including each not-run marker, equals the original (round-trip property).
7. IF a Deploy_Request ends with a retryable error or with a rejection under Requirement 1.4, THEN THE CHT_Deployer SHALL store no Deploy_Record for the Deploy_Request's Worker_Call_Id.
8. IF the Artifact_Bucket fails to store the Deploy_Record for a reason other than an existing Deploy_Record for the Worker_Call_Id, THEN THE CHT_Deployer SHALL return a retryable error to the Pipeline_Orchestrator through the Worker_API instead of the Deploy_Result.

### Requirement 7: Idempotent Retries

**User Story:** As a pipeline operator, I want retried worker calls to return the original outcome, so that a retry never causes a second upload or a conflicting record.

#### Acceptance Criteria

1. WHEN a Deploy_Request arrives with a Worker_Call_Id that already has a Deploy_Record whose request type, Release_Target, and Rollback_Request identifier match the Deploy_Request's, THE CHT_Deployer SHALL return the Deploy_Result held in that Deploy_Record.
2. IF a Deploy_Request's Worker_Call_Id already has a Deploy_Record, THEN THE CHT_Deployer SHALL end the Deploy_Request without running any Precondition_Check, Upload_Action, or Deploy_Verification and without reading the CHT_Login_Secret.
3. WHILE a Deploy_Request for one Worker_Call_Id is in progress, from its acceptance until the CHT_Deployer stores its Deploy_Record, returns a retryable error for it, or stops, THE CHT_Deployer SHALL answer any other Deploy_Request with the same Worker_Call_Id with a retryable error before any Precondition_Check.
4. IF the CHT_Deployer stops (process exit or host restart) or returns a retryable error before storing the Deploy_Record for a Worker_Call_Id, THEN THE CHT_Deployer SHALL process the next Deploy_Request with that Worker_Call_Id as a new Deploy_Request, starting from the first Precondition_Check.
5. FOR ALL sequences of two or more Deploy_Requests with the same Worker_Call_Id, request type, Release_Target, and Rollback_Request identifier, THE CHT_Deployer SHALL store exactly one Deploy_Record and return Deploy_Results equal in result, Deploy_Failure_Category, failed Precondition_Check name, and Deploy_Record location (idempotence).
6. IF a Deploy_Request arrives with a Worker_Call_Id that already has a Deploy_Record whose request type, Release_Target, or Rollback_Request identifier differs from the Deploy_Request's, THEN THE CHT_Deployer SHALL reject the Deploy_Request with a non-retryable error indicating a Worker_Call_Id conflict and leave the existing Deploy_Record unchanged.
7. IF the Artifact_Bucket cannot be read when the CHT_Deployer checks whether a Deploy_Record exists for the Deploy_Request's Worker_Call_Id, THEN THE CHT_Deployer SHALL return a retryable error before any Precondition_Check.

## Open Questions

1. Does the CHT_Test_Instance return app settings exactly as uploaded, or merged with defaults and server fields? The answer fixes the Server_Managed_Fields list.
2. §16 marks the deployment check as a stretch goal, while this spec requires a matching Deploy_Verification for `deployed`. Is that acceptable, and should forms and translations be verified as well as app settings?
3. Is a recorded Rollback_Request plus the target's original Deploy_Approval enough to authorize a rollback, or does rollback need a fresh `it_deploy` approval? Must the target have a prior `deployed` Deploy_Record?
4. Must the Pinned_CHT_Conf version equal the `cht-conf` version inside the pinned `medicmobile/cht-app-ide` build image?
5. How does the CHT_Deployer obtain Deployer_Role credentials on the shared services EC2 instance, separate from the instance role and agent workload identities?
6. Should concurrent Deploy_Requests from different changes to the single CHT_Test_Instance be serialized by the CHT_Deployer or by the Pipeline_Orchestrator?
7. Which Artifact_Bucket prefix holds Deploy_Records? §14 lists no `deploys/` prefix.
