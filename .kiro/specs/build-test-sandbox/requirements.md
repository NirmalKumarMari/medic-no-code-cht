# Requirements Document

## Introduction

The build-test-sandbox implements Pipeline_State 7 (Build_Test) of Vera (Solution Design §6, §13, §15, §16, design rule 6). For each build of an Approved snapshotHash, the Pipeline_Orchestrator's Build_Test worker starts one fresh, isolated container from the pinned `medicmobile/cht-app-ide` image. Inside the container, Vera converts the compiled CHT_Project with `cht-conf`, compiles the app settings, and runs synthetic-patient tests with `cht-conf-test-harness`. The tests cover every Rule. Their expected outcomes come only from the approved logic through the Expected_Outcome_Service. The sandbox writes a write-once Test_Report and Build_Record, then destroys the container.

This spec depends on:
- **logic-model-snapshots**: Snapshots, snapshotHash, Toolchain_Identity, Snapshot_Service.
- **logic-checks-golden-cases**: Expected_Outcome_Service, expected Outcomes, the coverage set.
- **pipeline-orchestrator**: the Build_Test Pipeline_State, the Worker_API, worker-call retries, and the Tooling_Retry decision.
- **cht-config-compiler**: the CHT_Project and the Compile_Manifest under the Build_Prefix.
- **review-ui-approvals**: shows the Test_Report at Deploy_Approval.
- **cht-deployer**: deploys a passed Build_Record. The sandbox never deploys.
- **platform-infrastructure**: the services EC2 instance, the image on the host, IAM roles, the Artifact_Bucket, and CloudWatch.

## Glossary

Terms reused from earlier specs keep the meaning defined there.

- **Vera**, **Snapshot**, **snapshotHash**, **Snapshot_Service**, **Toolchain_Identity**, **changeId**, **Artifact_Bucket**: As defined in the logic-model-snapshots spec.
- **Rule**, **Rule_Evaluator**, **Outcome**, **Action**, **Follow_Up**, **Input_Combination**, **Witness**, **Coverage set**, **Expected_Outcome_Service**: As defined in the logic-checks-golden-cases spec.
- **Pipeline_Orchestrator**, **Pipeline_State**, **Worker_API**, **Worker_Call_Id**, **Worker_Call_Timeout**, **Approved snapshotHash**, **Build_Record**, **Build_Failure_Category** (`infrastructure` or `build_or_test`), **Tooling_Retry**, **Deploy_Approval**: As defined in the pipeline-orchestrator spec.
- **CHT_Project**, **App_Form**, **Assessment_Form**, **Follow_Up_Form**, **Matching Rule**, **Rule_Result_Field**, **Compile_Manifest**, **Build_Prefix**: As defined in the cht-config-compiler spec.
- **Sandbox_Runner**: The Build_Test worker on the services EC2 instance that receives Build_Test_Requests, prepares inputs, starts and destroys Build_Containers, and writes Test_Reports and Build_Records.
- **Build_Test_Request**: A request from the Build_Test Pipeline_State, sent through the Worker_API, holding a changeId, a snapshotHash, the Compile_Manifest location, the Compile_Manifest SHA-256 digest, and a Worker_Call_Id.
- **Build_Test_Result**: The Sandbox_Runner's response to one Build_Test_Request: `passed`, `failed` (with one Build_Failure_Category), or `rejected` (refused before any Build started).
- **Build**: The processing of one accepted Build_Test_Request: input verification, at most one Build_Container run, and record writing.
- **Build_Id**: The unique identifier the Sandbox_Runner assigns to one Build.
- **Build_Run_Prefix**: The Artifact_Bucket key prefix `builds/{snapshotHash}/test-runs/{Build_Id}/` for one Build.
- **Sandbox_Image**: The `medicmobile/cht-app-ide` container image for platform `linux/amd64`, identified by the release tag named in the Snapshot's Toolchain_Identity, with Chromium and every build and test dependency installed.
- **Build_Container**: One container started from the Sandbox_Image for one Build.
- **Input_Mount**: The read-only directory holding the verified CHT_Project files of one Build.
- **Test_Mount**: The read-only directory holding the generated Harness_Tests and Synthetic_Patients of one Build.
- **Scratch_Directory**: The empty, writable directory given to one Build_Container for the working project and outputs.
- **Build_Step**: One of three steps run in this order inside the Build_Container: the Convert_Step (`cht --no-check convert-app-forms`), the Compile_Step (`cht --no-check compile-app-settings`), and the Harness_Step (`mocha` with `cht-conf-test-harness`).
- **Build_Artifact**: A file that the Convert_Step or the Compile_Step writes: one converted XForm per App_Form and the compiled app settings file.
- **Synthetic_Patient**: A test contact built only from the Input_Combination of one Witness and the fixed synthetic contact fields in the Sandbox_Configuration.
- **Harness_Test**: One `mocha` test, generated for one Rule id in the coverage set, that uses `setNow`, `fillForm`, `flush`, and `getTasks` on one Synthetic_Patient and compares the results with that Rule's expected Outcome.
- **Harness_Clock_Start**: The fixed timestamp in the Sandbox_Configuration to which every Harness_Test sets the harness clock with `setNow`.
- **Expected_Due_Date**: For an expected Outcome with a Follow_Up, the calendar date `dueInDays` calendar days after the Harness_Clock_Start date, which is the Assessment_Form report date in a Harness_Test.
- **Expected_Open_Window**: The days from the Expected_Due_Date through the calendar date `openForDays` calendar days after it, both included, matching the open window that the cht-config-compiler generates from the same Follow_Up.
- **Test_Report**: The report of one Build: each Build_Step's exit status and times, each Harness_Test's result and failed assertions, and the list of every Rule id of the Snapshot with its Harness_Test result.
- **Build_Error**: One entry in the error list of a failed Build, holding the Build_Step name or `setup`, an error code, and a description.
- **Build_Record_Schema**: The JSON schema that every serialized Build_Record must satisfy.
- **Sandbox_Configuration**: The settings the Sandbox_Runner reads at process start: the Run_Timebox, the Harness_Test_Timeout, the Harness_Clock_Start, the synthetic contact fields, the container environment allowlist, and the CloudWatch log group name.
- **Run_Timebox**: The longest time one Build_Container may run, 600 seconds by default.
- **Harness_Test_Timeout**: The longest time one Harness_Test may run, 30 seconds by default.
- **Dependency_Timeout**: The 30 seconds the Sandbox_Runner waits for a response from the Artifact_Bucket, the Snapshot_Service, or the Expected_Outcome_Service on one request.

## Requirements

### Requirement 1: Build_Test requests and results

**User Story:** As the Pipeline_Orchestrator, I want one well-defined result for each Build_Test_Request, so that the Build_Test Pipeline_State can gate the change and retry safely.

#### Acceptance Criteria

1. WHEN the Build_Test Pipeline_State sends a Build_Test_Request through the Worker_API, THE Sandbox_Runner SHALL return exactly one Build_Test_Result for that Build_Test_Request, holding each changeId, snapshotHash, and Worker_Call_Id that the request carries.
2. IF a Build_Test_Request lacks or holds an empty changeId, snapshotHash, Compile_Manifest location, Compile_Manifest digest, or Worker_Call_Id, holds a snapshotHash or Compile_Manifest digest other than 64 lowercase hexadecimal characters, or holds a Worker_Call_Id that a recorded or running Build holds with a different changeId, snapshotHash, or Compile_Manifest digest, THEN THE Sandbox_Runner SHALL return a `rejected` Build_Test_Result naming each missing or invalid field without assigning a Build_Id or starting a Build_Container.
3. IF the Expected_Outcome_Service rejects the requested snapshotHash because it has no content approval, THEN THE Sandbox_Runner SHALL return a `rejected` Build_Test_Result with error code `snapshot_not_approved` without assigning a Build_Id or starting a Build_Container.
4. WHEN a Build_Test_Request carries a Worker_Call_Id, changeId, snapshotHash, and Compile_Manifest digest that match an existing Build_Record, THE Sandbox_Runner SHALL return the Build_Test_Result recorded in that Build_Record without starting a Build or writing any object to the Artifact_Bucket.
5. WHILE a Build is running for a Worker_Call_Id, WHEN another Build_Test_Request with the same Worker_Call_Id, changeId, snapshotHash, and Compile_Manifest digest arrives, THE Sandbox_Runner SHALL start no second Build and return the running Build's Build_Test_Result to that request when the running Build ends.
6. WHEN the Sandbox_Runner process starts, THE Sandbox_Runner SHALL destroy every Build_Container, Scratch_Directory, Input_Mount, and Test_Mount left by an earlier Sandbox_Runner process before accepting any Build_Test_Request.
7. THE Sandbox_Runner SHALL return each Build_Test_Result within 900 seconds (the Worker_Call_Timeout), measured from receipt of the Build_Test_Request to sending of the Build_Test_Result.
8. WHEN a Build ends with overall result `passed`, THE Sandbox_Runner SHALL return a `passed` Build_Test_Result holding the Build_Id, the Build_Record location, and the SHA-256 digest of the Build_Record object as written to the Artifact_Bucket.
9. WHEN a Build ends as failed, THE Sandbox_Runner SHALL return a `failed` Build_Test_Result holding the Build_Id, exactly one Build_Failure_Category, at least one Build_Error, and the Build_Record location and SHA-256 digest, omitting the location and digest only for a Build whose Build_Record write did not complete.
10. IF the Expected_Outcome_Service returns any error other than a no-content-approval rejection when the Sandbox_Runner checks whether the requested snapshotHash is approved, THEN THE Sandbox_Runner SHALL assign a Build_Id and end that Build as failed with Build_Failure_Category `infrastructure` before any Build_Container starts.

### Requirement 2: Verified, read-only inputs

**User Story:** As a national IT lead, I want the sandbox to test exactly the files the compiler produced for the approved snapshot, so that the test report applies to what will be deployed.

#### Acceptance Criteria

1. WHEN a Build starts, THE Sandbox_Runner SHALL read the Compile_Manifest from the Compile_Manifest location in the Artifact_Bucket and verify that the SHA-256 digest of the bytes read equals the Compile_Manifest digest in the Build_Test_Request.
2. WHEN the Compile_Manifest digest check in criterion 1 passes, THE Sandbox_Runner SHALL verify that the Compile_Manifest location lies under the Build_Prefix of the requested snapshotHash and that the Compile_Manifest records a snapshotHash equal to the requested snapshotHash as an exact, case-sensitive string.
3. WHEN the checks in criteria 1, 2, and 8 pass, THE Sandbox_Runner SHALL read every file listed in the Compile_Manifest from the Artifact_Bucket key formed by the Build_Prefix of the requested snapshotHash followed by that file's listed relative path, and verify that the SHA-256 digest of the bytes read equals the digest the Compile_Manifest lists for that file.
4. IF a check in criteria 1, 2, 3, or 8 fails, or the Compile_Manifest or a listed file does not exist in the Artifact_Bucket, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `infrastructure` and one Build_Error with Build_Step `setup` per failing check, naming the Compile_Manifest or the relative path of each failing file, before writing any file to the Input_Mount or starting any Build_Container.
5. WHEN every check in criteria 1, 2, 3, and 8 passes, THE Sandbox_Runner SHALL place in the Input_Mount exactly the files listed in the Compile_Manifest, at their listed relative paths and with the bytes whose digests it verified in criterion 3, and no other file, including the Compile_Manifest and any object under a Build_Run_Prefix.
6. THE Sandbox_Runner SHALL mount the Input_Mount and the Test_Mount read-only in the Build_Container.
7. THE Sandbox_Runner SHALL mount a Scratch_Directory that holds no file or directory when the Build_Container starts as the only writable mount of the Build_Container.
8. WHEN the Compile_Manifest digest check in criterion 1 passes, THE Sandbox_Runner SHALL verify that the Compile_Manifest lists at least one file and that every listed relative path is non-empty, does not start with `/`, contains no `..` path segment, and appears only once in the Compile_Manifest.
9. IF the Artifact_Bucket gives no response within the Dependency_Timeout to a read of the Compile_Manifest or of a listed file, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `infrastructure` before writing any file to the Input_Mount or starting any Build_Container.

### Requirement 3: One fresh, timeboxed container per Build

**User Story:** As a national IT lead, I want every build to run in a new container from the pinned image that is destroyed afterwards, so that no state carries between snapshots.

#### Acceptance Criteria

1. THE Sandbox_Runner SHALL create a new Build_Container for each Build, start that Build_Container at most once, and run no other Build in it.
2. THE Sandbox_Runner SHALL start each Build_Container from the Sandbox_Image whose release tag is the one named in the Toolchain_Identity of the Snapshot that the Snapshot_Service returns for the requested snapshotHash.
3. IF the Toolchain_Identity names no Sandbox_Image release tag, or the host holds no Sandbox_Image with the named release tag for platform `linux/amd64`, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `infrastructure` before any Build_Container starts and without pulling an image from a registry.
4. WHEN a Build_Container exits, THE Sandbox_Runner SHALL copy the recorded Build_Step exit statuses and times, the Harness_Test results, and the Build_Artifacts that are present in the Scratch_Directory to a location outside the Scratch_Directory.
5. WHEN a Build_Container has run for the Run_Timebox, measured from the moment the Build_Container starts, THE Sandbox_Runner SHALL stop that Build_Container so that it exits within 10 seconds.
6. WHEN the Sandbox_Runner process starts with a Sandbox_Configuration that sets no Run_Timebox, THE Sandbox_Runner SHALL use a Run_Timebox of 600 seconds.
7. IF the Sandbox_Configuration sets a Run_Timebox that is not a whole number of seconds from 1 to 899, THEN THE Sandbox_Runner SHALL log a configuration error naming the Run_Timebox and exit without accepting any Build_Test_Request.
8. THE Sandbox_Runner SHALL send the standard output and standard error of each Build_Container to one CloudWatch Logs stream, in the log group named in the Sandbox_Configuration, whose name contains the changeId and the Build_Id.
9. WHEN the copy out of a Build_Container's Scratch_Directory ends, whether or not the copy succeeded, THE Sandbox_Runner SHALL destroy the Build_Container, its Scratch_Directory, its Input_Mount, and its Test_Mount before returning the Build_Test_Result.
10. IF a Build ends before its Build_Container starts, THEN THE Sandbox_Runner SHALL delete every Input_Mount, Test_Mount, Scratch_Directory, and created Build_Container of that Build before returning the Build_Test_Result.

### Requirement 4: Container isolation

**User Story:** As a security reviewer, I want the container that runs build and test tooling to have no network, no credentials, and minimal privileges, so that untrusted tooling cannot reach real systems.

#### Acceptance Criteria

1. THE Sandbox_Runner SHALL start each Build_Container with the loopback interface as its only network interface.
2. THE Sandbox_Runner SHALL ensure that every connection attempt from a Build_Container to the instance metadata endpoint at `169.254.169.254` fails.
3. THE Sandbox_Runner SHALL run every process in each Build_Container with a user ID other than 0.
4. THE Sandbox_Runner SHALL start each Build_Container with every Linux capability dropped except `SYS_ADMIN`.
5. THE Sandbox_Runner SHALL start each Build_Container in non-privileged mode.
6. THE Sandbox_Runner SHALL mount no host directory, file, or socket into a Build_Container other than the Input_Mount, the Test_Mount, and the Scratch_Directory.
7. THE Sandbox_Runner SHALL set no environment variable in a Build_Container other than those the Sandbox_Image defines and those whose names are in the Sandbox_Configuration environment allowlist.
8. THE Sandbox_Runner SHALL run under an IAM role that grants no Secrets Manager action and grants Artifact_Bucket write access only to keys under a Build_Run_Prefix or under `reports/{snapshotHash}/build-test/` for any snapshotHash.
9. IF the settings of a created Build_Container, read by the Sandbox_Runner before that Build_Container starts, differ from criteria 1 and 3 to 7 of this requirement or from criteria 6 and 7 of Requirement 2, THEN THE Sandbox_Runner SHALL destroy the Build_Container without starting it and end the Build as failed with Build_Failure_Category `infrastructure` and a `setup` Build_Error for each differing setting.
10. THE Sandbox_Runner SHALL place no AWS access key ID, secret access key, or session token in any environment variable or mounted file of a Build_Container.
11. WHERE the Sandbox_Configuration sets no environment allowlist, THE Sandbox_Runner SHALL set no environment variable in a Build_Container other than those the Sandbox_Image defines.

### Requirement 5: Build steps

**User Story:** As a national IT lead, I want the compiled project converted and compiled with standard `cht-conf` commands, so that only configuration that builds with `cht-conf` can pass.

#### Acceptance Criteria

1. WHEN a Build_Container starts, THE Build_Container SHALL copy every file of the Input_Mount, at its relative path, into a working project directory in the Scratch_Directory before running any Build_Step.
2. WHEN the copy in criterion 1 completes with every Input_Mount file present in the working project directory, THE Build_Container SHALL run the Convert_Step in the working project directory.
3. WHEN the Convert_Step exits with status 0, THE Build_Container SHALL run the Compile_Step in the working project directory.
4. WHEN the Compile_Step exits with status 0, THE Build_Container SHALL run the Harness_Step over every Harness_Test in the Test_Mount, continuing with each remaining Harness_Test after any Harness_Test fails.
5. IF a Build_Step exits with a non-zero status, THEN THE Build_Container SHALL skip every later Build_Step and record each skipped Build_Step as `skipped` in the Scratch_Directory.
6. WHEN a Build_Step exits, THE Build_Container SHALL record that Build_Step's exit status and its UTC start and end times, to millisecond precision, in the Scratch_Directory.
7. WHEN a Harness_Test ends, THE Harness_Step SHALL write to the Scratch_Directory one result for that Harness_Test holding its Rule id, `pass` or `fail`, and each failed assertion.
8. WHEN a Build_Container exits after a Compile_Step that exited with status 0, THE Sandbox_Runner SHALL compute the SHA-256 digest of each Build_Artifact copied out of the Scratch_Directory.
9. IF a Harness_Test runs longer than the Harness_Test_Timeout, THEN THE Harness_Step SHALL stop that Harness_Test, record its result as `fail` with a failed assertion indicating the timeout, and continue with the next Harness_Test.
10. IF the copy in criterion 1 fails or leaves an Input_Mount file absent from the working project directory, THEN THE Build_Container SHALL run no Build_Step and record in the Scratch_Directory a `setup` error naming each file that was not copied.

### Requirement 6: Synthetic-patient tests from the approved logic

**User Story:** As a clinician, I want every rule tested with synthetic patients against outcomes computed from the logic I approved, so that the built forms and tasks do what I approved and no model judges a test.

#### Acceptance Criteria

1. WHEN a Build starts, THE Sandbox_Runner SHALL request the coverage set and the expected Outcome of each Witness in it for the requested snapshotHash from the Expected_Outcome_Service before any Build_Container starts.
2. WHEN the Expected_Outcome_Service returns the coverage set and the expected Outcomes, THE Sandbox_Runner SHALL generate exactly one Harness_Test per Rule id in the coverage set, taking the expected Rule id, Action, and Follow_Up or absence of a Follow_Up only from the expected Outcome of that Rule id's Witness.
3. THE Sandbox_Runner SHALL build the Synthetic_Patient of each Harness_Test only from the Input_Combination of the Witness for that Harness_Test's Rule id and the synthetic contact fields in the Sandbox_Configuration.
4. THE Sandbox_Runner SHALL generate byte-identical Harness_Tests and Synthetic_Patients in every Build that uses the same coverage set, expected Outcomes, and Sandbox_Configuration.
5. WHEN a Harness_Test runs, THE Harness_Test SHALL set the harness clock to the Harness_Clock_Start with `setNow`, fill the Assessment_Form for its Synthetic_Patient with `fillForm` using exactly the Input values of that Synthetic_Patient's Witness, and assert that `result.errors` is empty.
6. WHEN a Harness_Test has filled the Assessment_Form, THE Harness_Test SHALL assert that the submitted report records as true the Rule_Result_Field of the expected Outcome's Rule id and as false every other Rule_Result_Field, and that the Assessment_Form shows the expected Outcome's Action as its only displayed Action.
7. WHEN a Harness_Test runs for an expected Outcome with a Follow_Up, THE Harness_Test SHALL assert that `getTasks`, after `flush` advances the harness clock to the Expected_Due_Date, returns exactly one task for the Synthetic_Patient that opens the Follow_Up_Form and is due on the Expected_Due_Date.
8. WHEN a Harness_Test runs for an expected Outcome with a Follow_Up, THE Harness_Test SHALL assert that `getTasks` returns no Follow_Up_Form task with the harness clock on the calendar day before the Expected_Due_Date, setting the harness clock back with `setNow` when `dueInDays` is 0.
9. WHEN a Harness_Test runs for an expected Outcome with a Follow_Up, THE Harness_Test SHALL assert that `getTasks` returns no Follow_Up_Form task with the harness clock on the calendar day after the last day of the Expected_Open_Window.
10. WHEN a Harness_Test runs for an expected Outcome with a Follow_Up, THE Harness_Test SHALL assert that `getTasks` returns exactly one Follow_Up_Form task due on the Expected_Due_Date with the harness clock on the last day of the Expected_Open_Window.
11. WHEN a Harness_Test runs for an expected Outcome without a Follow_Up, THE Harness_Test SHALL assert that `getTasks` returns no task for the Synthetic_Patient with the harness clock on the Assessment_Form report date and on each distinct Expected_Due_Date computed from the expected Outcomes with a Follow_Up in the Expected_Outcome_Service response.
12. FOR ALL orders in which the Harness_Tests of a Build run, each Harness_Test SHALL give the same pass or fail result and the same failed assertions as when it runs alone (test-independence property).

### Requirement 7: Test_Report and Build_Record

**User Story:** As a national IT lead, I want a write-once test report and build record for every build, so that deploy approval and rollback rest on a fixed, auditable result.

#### Acceptance Criteria

1. WHEN a Build ends as passed or failed, THE Sandbox_Runner SHALL write the Test_Report to `reports/{snapshotHash}/build-test/{Build_Id}/test-report.json` in the Artifact_Bucket, including for a Build that ended before any Build_Container started.
2. THE Test_Report SHALL list every Rule id of the Snapshot exactly once with that Rule's Harness_Test result as `passed`, `failed`, or `not_run`, using `not_run` for a Rule id that has no Harness_Test result.
3. WHEN a Build_Container exits, THE Sandbox_Runner SHALL write each Build_Artifact present in the Scratch_Directory to `{Build_Run_Prefix}artifacts/` in the Artifact_Bucket at its path relative to the working project directory.
4. WHEN a Build ends as passed or failed, THE Sandbox_Runner SHALL write the Build_Record to `{Build_Run_Prefix}build-record.json` only after every write of the Test_Report and of each Build_Artifact of that Build has finished.
5. THE Build_Record SHALL hold the changeId, snapshotHash, Worker_Call_Id, Build_Id, Sandbox_Image tag, Toolchain_Identity, Compile_Manifest digest, Build_Artifact paths and SHA-256 digests, the per-Rule Harness_Test results recorded in the Test_Report, the Test_Report location and SHA-256 digest, overall result, Build_Failure_Category and Build_Errors when failed, CloudWatch Logs stream name, and Build start and end times.
6. THE Sandbox_Runner SHALL set the overall result to `passed` for a Build in which the Convert_Step, the Compile_Step, and the Harness_Step each exited with status 0, every Rule id of the Snapshot has a passing Harness_Test, and no Build_Error was recorded, and to `failed` for every other Build.
7. IF an object already exists at a location the Sandbox_Runner is about to write for a Build, THEN THE Sandbox_Runner SHALL leave the existing object unchanged and end the Build as failed with Build_Failure_Category `infrastructure` and a Build_Error naming that location.
8. THE Sandbox_Runner SHALL serialize each Build_Record as JSON that validates against the Build_Record_Schema.
9. FOR ALL valid Build_Records, serializing then parsing then serializing SHALL produce byte-identical JSON (round-trip property).
10. THE Test_Report SHALL hold each Build_Step's exit status, start time, and end time, marking a Build_Step that never started as `not_run` and a Build_Step that started without recording an exit status as `incomplete`.
11. IF the Artifact_Bucket returns an error for a write of the Test_Report or a Build_Artifact, THEN THE Sandbox_Runner SHALL write the Build_Record with overall result `failed`, Build_Failure_Category `infrastructure`, and no location or digest for any object that was not written.

### Requirement 8: Failure classification

**User Story:** As the Pipeline_Orchestrator, I want each failed build labelled `build_or_test` or `infrastructure`, so that I can choose between a Tooling_Retry under the existing approval and an Escalation.

#### Acceptance Criteria

1. IF the coverage set lacks a Witness for a Rule id of the Snapshot, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `build_or_test`, naming each Rule id that lacks a Witness, before any Build_Container starts.
2. IF the Convert_Step or the Compile_Step exits with a non-zero status, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `build_or_test`.
3. IF a Compile_Step that exited with status 0 leaves in the Scratch_Directory no converted XForm for an App_Form of the CHT_Project or no compiled app settings file, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `build_or_test`, naming each missing Build_Artifact.
4. IF a Harness_Test fails an assertion or runs longer than the Harness_Test_Timeout, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `build_or_test`.
5. IF the container runtime returns an error when the Sandbox_Runner creates or starts the Build_Container, or the Build_Container is terminated by a signal that the Sandbox_Runner did not send, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `infrastructure`.
6. IF the Sandbox_Runner stops a Build_Container because it has run for the Run_Timebox, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `infrastructure`.
7. IF the Artifact_Bucket, the Snapshot_Service, or the Expected_Outcome_Service returns an error or gives no response within the Dependency_Timeout of a request during a Build, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `infrastructure`.
8. WHEN a Build fails, THE Sandbox_Runner SHALL record one Build_Error per failure cause in the Build_Test_Result and, when written, the Build_Record, each holding the name of the failing Build_Step (or `setup` for a failure outside the Build_Steps), an error code, and a description.
9. WHEN a Build fails, THE Sandbox_Runner SHALL return the failed Build_Test_Result to the Pipeline_Orchestrator without starting another Build_Container for that Build_Test_Request.
10. IF the Compile_Step exited with status 0 and the Build_Container exited without being terminated by a signal, but the Harness_Step results hold no result for a Rule id in the coverage set, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `build_or_test`, naming each Rule id without a result.
11. IF one Build has both a `build_or_test` failure cause and an `infrastructure` failure cause, THEN THE Sandbox_Runner SHALL end the Build as failed with Build_Failure_Category `infrastructure`.

## Open Questions

1. **Open window source**: Resolved. The cht-config-compiler spec (Requirement 4) derives the due date and open window from the Follow_Up's `dueInDays` and `openForDays`, so the Expected_Due_Date and Expected_Open_Window trace to the approved logic (rule 6). How many days before the due date a task first appears is still open in that spec.
2. **Image pinning**: Should Toolchain_Identity pin the Sandbox_Image by digest as well as by release tag?
3. **`rejected` result**: The pipeline-orchestrator spec must handle a third Build_Test_Result type for malformed or unapproved requests. Should it map to an Escalation instead?
4. **Timeouts and classification**: Confirm the Run_Timebox (600 s, `infrastructure` when exceeded) and the Harness_Test_Timeout (30 s, `build_or_test` when exceeded).
5. **Task resolution**: Should Harness_Tests also complete the Follow_Up_Form and assert that the task resolves (`resolvedIf`)?
