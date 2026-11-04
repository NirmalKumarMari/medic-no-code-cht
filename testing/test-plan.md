# Vera test plan

Status key: **NOW** = can run today · **PREP** = set up now, run later · **WAIT** = needs someone else's part first

## Test 2: Drafting agent reads each guideline correctly (NOW, needs AWS access)

1. In the repo root, make a `testing/` folder and copy in `golden-cases/`, `sample-pdfs/` and `sample-patients/`. Copy `test-2-drafting/run-drafting-on-samples.ts` into `scripts/`.
2. `npm install`
3. Get AWS credentials for the team sandbox (us-west-2) into your terminal (`aws configure` or `aws sso login`). Check that Bedrock model access is enabled for Claude Haiku in the console.
4. `npx tsx scripts/run-drafting-on-samples.ts`
5. Grade each output:
   ```bash
   for f in testing/drafting-outputs/*.json; do node testing/golden-cases/check-golden-cases.mjs "$f"; done
   ```

**Pass:**
- `1b`, `2-format-A`, `3-format-B` and `4-format-C` each get 16/16.
- `5-format-D` (vague) has ambiguity/gap flags and does NOT invent numbers.
- Every rule has a `source` (page citation).

**If something fails:** open the JSON and find the rule the failing case points to. That usually means a prompt fix for the Drafting agent owner. Rerun with `VERA_MODEL_TIER=sonnet` to compare models.

**Known limits:**
- The agent takes text, not a PDF. These runs use pre-extracted text from `sample-pdfs/text/`. ADR-016 says Claude reads the PDF directly; nobody has built that step yet.
- The action names in the answer key (`refer_urgently`, `home_care_advice`) must match what the agent outputs. If it picks `follow_up` or `treat_at_home`, that's a finding.

## Test 3: Test box works (PREP, do now)

Goal: Medic's own build and test tools run green on Medic's own sample, before any of our code is involved.

1. Install Docker Desktop on the Mac (or use the team's EC2 box).
2. `git clone --depth 1 https://github.com/medic/cht-core.git` and look at `config/default/` (Medic's reference app with real tests in `test/`).
3. Open `config/default/package.json` and find its test script.
4. Run the build and tests inside Medic's pinned image `medicmobile/cht-app-ide` (pick one version tag and write it down). Alternative: install Node, `cht-conf` and Python on the box.
5. Order matters: `cht --no-check convert-app-forms compile-app-settings` first, then the tests. The test tool needs a `harness.defaults.json`.

**Pass:** Medic's sample tests (e.g. `test/forms/pregnancy.spec.js`) run green. Write down the exact commands; that's the recipe for the build/test container.

## Test 4: Fake patients through the built form (PREP now, WAIT for compiler)

1. **Now:** agree with the compiler owner on the form name, field names (= input ids), and the order of questions on each page. The test tool fills forms by page and position, not by name.
2. **Now:** write the test file that loops over `patients.json`. For each patient: load the form, fill it, check `result.errors` is empty, check the outcome matches `expected.action`, and if it refers, check the follow-up task appears.
3. **When the compiler outputs files:** compile, then run the test.

**Pass:**
- 3,456/3,456 match.
- Zero form errors.
- Every rule reached.

## Test 5: Golden-case check shows on the Review screen (PREP, with the UI owner)

Wire `check-golden-cases.mjs` logic (the shared `evaluate.mjs`) into the UI's checks, so the clinician sees "16/16 golden cases pass" before Approve, and Approve is blocked on any failure.

## Test 6: End-to-end checklist (WAIT for the pipeline)

| # | Do this | Pass if |
|---|---|---|
| 6.1 | Upload `1b` excerpt and run the whole pipeline | Reaches the clinician approval screen; every rule shows its source |
| 6.2 | Upload `5-format-D` (vague) | Approve is blocked until flags are resolved |
| 6.3 | Clinician rejects with a note | New version created, goes back to logic checks, AI not re-run |
| 6.4 | Author tries to approve their own change | Refused |
| 6.5 | Same person tries to approve both content and deploy | Refused |
| 6.6 | Change one rule after approval | New version, new approval required |
| 6.7 | Restart the orchestrator while waiting for approval | Approval still pending afterwards |
| 6.8 | Force a build tooling failure (rules unchanged) | Rebuilds without asking the clinician again |
| 6.9 | Roll back to previous approved version | Old version redeployed |
| 6.10 | Time the full run, PDF to approved tested build | Write the time down for the demo |

## Test 7: Works in real CHT (WAIT for deploy + CHT test server)

1. Deploy the approved build to the CHT test server.
2. Log in as a **health worker** (not admin: tasks only show for place-restricted users).
3. Register a test baby, open the danger signs form, enter 61 breaths per minute.
4. **Pass:**
   - The form says refer.
   - Entering 60 breaths says routine care.
   - The follow-up task appears if the rules include one.

## Set up in the meantime

- [ ] Get AWS sandbox credentials and check Bedrock Claude access (needed for test 2)
- [ ] Run test 3 (test box) now
- [ ] Agree field names and question order with the compiler owner (needed for test 4)
- [ ] Ask who's running the CHT test server (needed for test 7). For a local one, CHT has Docker setup docs
- [ ] Put `testing/` into the repo via a pull request so the team uses the same data
- [ ] Write the 2-minute demo script around the best moments: 16/16 on four formats, the vague PDF getting flagged, and the "60 vs 61" edge case
