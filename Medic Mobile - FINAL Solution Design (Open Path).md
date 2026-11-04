# Medic Mobile — FINAL Solution Design (Open Path)

**Status:** Canonical design. Build the code and IaC against this document.
**Supersedes:** [[Medic Mobile - Solution Design (AgentCore + Bedrock)]] (earlier draft, now superseded — see its header note).
**Synthesized from:** This doc, the Vision/Technical Environment source docs, and four team design docs reviewed and reconciled on 2026-11-03 — "Design Doc_ Team Vera," "design doc yash," "vera-design-doc," and "CHT NoCode Architecture - Jonathan H." Where those docs disagreed, the resolution is recorded in the Decisions Log below.
**Revised 2026-11-04:** a cost/over-engineering review (see [[architecture-decisions]] ADR-010 through ADR-013) cut two agents, simplified a third, and replaced the vector-search Knowledge Base with prompt-stuffing. That review's reasoning is **not** repeated in full here — read the ADR file for the "why." This doc reflects the result.
**Track:** Open path. **Example pathway (illustrative only, not yet finalized):** child cough and fast breathing. Final guideline/pathway choice is still open — see §20.

---

## Decisions Log

| # | Decision | Why |
|---|---|---|
| 1 | **Track: Open path.** No cht-ui-builder integration. | Three of four team docs leaned Open path or left it open; only one committed to Reference path. Lower risk than modifying an unfamiliar codebase with known gaps (no approve action, inverted task conditions) under a 2-day deadline. |
| 2 | **Orchestrator: AWS Step Functions**, not a custom EC2-hosted workflow engine. | Managed, built-in task-token approval waits, visual execution history for the demo, far less custom code to write and debug in 2 days. Matches the most detailed of the four team docs; reconfirms the earlier decision this session. |
| 3 | **Agent hosting: plain EC2 containers**, not AgentCore Runtime. **Supersedes the earlier draft's choice of AgentCore Runtime.** AgentCore Gateway, Policy (Cedar), Identity, and Observability still wrap the agents regardless. | Majority of the team docs converged here; avoids standing up and learning Runtime's deployment model for only two lightweight agents in a 2-day build. Also removes the AgentCore-orchestration-lock-in tension flagged earlier — with Runtime out of the picture, the agents (built with a portable framework, e.g. Strands Agents) have no AWS-proprietary hosting dependency at all. |
| 4 | ~~Knowledge Base: full Bedrock Knowledge Base with S3 Vectors, kept in scope.~~ **Superseded by #11.** | — |
| 5 | **Build/test sandbox: EC2, no network at all**, with upload as a **separate deployer step/role** that only reads CHT credentials after deploy approval. | Adopted from the Open-path team doc's design: splitting "build and test" (fully offline, no credentials) from "deploy" (a distinct role, credentials only after the second human approval) is a stronger least-privilege/blast-radius boundary than one container doing both. |
| 6 | ~~Model tiering with model-diversity on cross-check.~~ **Superseded by #12 — Cross-Check cut entirely, not just given a different model.** | — |
| 7 | **Build/test failure handling splits two ways**: (a) the meaning must change → new `snapshotHash`, back to content approval, clinician re-approves; (b) a compiler/infra bug with unchanged logic → rebuild/rerun the *same* hash, the existing approval stays valid. | Adopted from the Open-path team doc. Avoids re-bothering a clinician for a pure tooling retry while still forcing re-approval whenever meaning actually changes — a meaningfully better reliability design than treating every build failure the same way. |
| 8 | ~~Decision memory / history check (Should-have). AgentCore Memory holds plain-language summaries for agents to learn from.~~ **Superseded by #13 — kept the deterministic half only, dropped the AI-learning half.** | — |
| 9 | **EC2, not EKS/ECS**, for the demo deployment. | Reconfirmed from earlier this session — single-instance, 2-day build; no multi-tenant bin-packing need yet. One team doc used ECS; not adopted, to keep setup surface minimal. |
| 10 | ~~Vector store: Amazon S3 Vectors, not OpenSearch Serverless.~~ **Moot — superseded by #11; there is no vector store in the MVP at all.** | — |
| 11 | **No Knowledge Base, no vector store.** Guideline text and a short, curated CHT-conventions primer are stuffed directly into the Drafting and Change Planner prompts, with caching. | A full RAG pipeline is sized for "search across many documents" — a problem that doesn't exist at this scope (one guideline, one pathway). Prompt-stuffing gives the same grounding benefit with no ingestion pipeline, no embeddings, no vector-store cost floor, and no risk of retrieval missing the one passage that matters. A real Knowledge Base is a Phase 2 concern per Medic's own vision doc, not an MVP one. See [[architecture-decisions]] ADR-011. |
| 12 | **Cross-Check Agent cut from the pipeline entirely**, not deferred. | Doubles the cost of every drafting call, forever, to catch disagreements that deterministic logic checks, golden cases, and an actual clinician's review already substantially cover. If wanted later, build it as a manual "re-draft and diff" button a clinician presses on a specific change, never an automatic pipeline step. See ADR-012. |
| 13 | **History Check is deterministic code, not an agent.** Only the exact-fingerprint-match layer survives (a DynamoDB hash lookup, folded into Logic Checks); the AI-semantic-similarity layer is dropped. | The part that mattered — never let IT silently re-approve a rule a clinician already rejected — needs no LLM. The speculative half (semantic summarization of "similar but not identical" past decisions) isn't worth the recurring cost at Medic's likely change volume. See ADR-013. |
| 14 | **No chat-based approver UX.** The officer's request stays a single form-style submission into Intake; the clinician's review stays a single structured view (decision table/flowchart over the LogicModel), not a conversation. | Confirmed with the team — chat was never going to be built. Keeps the officer-intake and clinician-review interactions single-shot, with no session/conversation state to design, store, or secure. See ADR-015. |
| 15 | **No Amazon Textract. Claude on Bedrock reads the guideline PDF directly**, and the extracted text is prompt-stuffed (per Decisions Log #11), never routed through a separate OCR step. | Closes out the "pick by measured accuracy during setup" open choice. One fewer service to wire up and pay for; Claude's native PDF understanding handles tables and decision charts that a plain OCR pass can mangle. Same reasoning that already cut the Knowledge Base. See ADR-016. |

---

## 1. Problem Statement

A clinical protocol can be updated in days; translating that update into CHT's actual configuration — XLSForm, JSON, JavaScript — takes weeks to months, because that translation currently requires one of a small pool of developers and a full release cycle, however small the change. The CHT serves 182,000+ community health workers across 24 countries; eight governments run it as their national platform and cannot adapt it themselves. Changes must also stay safe: a real prototype bug (two missing brackets) would have changed who sees 11 of 24 forms in a national configuration, and every manual check passed — only running synthetic patients through the build exposed it.

**Restated:** Non-technical program staff and clinicians have no way to safely change CHT configuration themselves. The fix must remove the *coding* requirement without removing a single check or approval that currently catches unsafe changes.

## 2. Solution Summary

AI drafts and flags. Code builds and tests. Humans approve twice. A program officer uploads a public guideline (or describes a change in plain language); Bedrock-backed agents draft the pathway's logic, citing every rule to its source passage and grounding it against the guideline text and a curated CHT-conventions primer, both stuffed directly into the prompt; deterministic code checks it (completeness, exclusivity, reachability, golden cases); a clinician approves the exact version; deterministic code — never a model — compiles it into real CHT files; a fresh sandboxed build proves it with synthetic patients; IT approves the diff and test report; a separate deployer step uploads it. CHW phones get it on their next sync, running standard, offline, non-AI configuration throughout.

## 3. Non-Negotiable Design Rules (Medic's, unchanged)

1. Models never write compiled configuration; deterministic code compiles approved logic.
2. Every change gets two human approvals: content before build, deploy before upload. Clinical changes always need a clinician.
3. AI drafts and hand edits take the same path and the same checks.
4. Approval binds to one exact, versioned snapshot, never to a conversation.
5. The approver's view comes from the same model (data) the compiler reads.
6. Expected outcomes come from the approved logic; a model never judges a test.
7. Ambiguity is flagged for a person, never resolved silently.
8. Synthetic data only; no real patient data, no real CHT credentials in a prompt.
9. Nothing generative runs on a health worker's phone.
10. Output is standard CHT configuration that builds with `cht-conf`; every change is reversible.

## 4. Users, Roles, and Separation of Duties

| Role | Skills | Does | Approval authority |
|---|---|---|---|
| Program officer | Excel-level, no code | Uploads the guideline, picks the pathway, describes changes, resolves flags | None — drafts and clarifies, never approves |
| Program reviewer | Non-clinical | Approves plain-wording edits; escalates anything with clinical meaning | Content approval, wording-only |
| Clinician | Clinical, no code | Reviews logic in plain clinical terms; approves or rejects with a note | Content approval, clinical |
| National IT lead | Technical | Reviews the diff, test report, and history-check flags; acknowledges each flag | Deploy approval |
| Community health worker | Uses the app | Never authors; receives the update on next sync | None |

**Separation of duties, enforced in code (not convention):** the `approve-content` and `approve-deploy` operations reject the request if the approver authored the snapshot, or if they already approved the other gate. Enforced via Cognito groups (`program_officer`, `program_reviewer`, `clinician`, `it_deploy`) checked server-side on every approval call. No single person can draft, approve, and deploy the same clinical change. At the event, a Medic representative plays the clinician role.

## 5. Architecture Overview

```
                    ┌─────────────────────────────┐
  Program officer /  │   Review UI / API (EC2)       │
  Clinician / IT      │   Authenticated, Cognito       │
                    └───────────────┬─────────────┘
                                    │ starts/resumes change, returns approval decisions
                                    ▼
                    ┌─────────────────────────────┐
                    │   AWS Step Functions           │◄── task tokens park
                    │   (orchestrator, fixed order)  │    at both approval gates
                    └───────────────┬─────────────┘
          calls each state's worker │ (internal API on the services EC2 instance)
       ┌────────────┬───────────────┼────────────────┐
       ▼            ▼               ▼                ▼
  ┌─────────┐ ┌───────────┐  ┌─────────────┐  ┌─────────────┐
  │ Intake   │ │ Drafting / │  │ Deterministic│  │ Change       │
  │ Agent    │ │ Clinical    │  │ logic checks │  │ Planner      │
  │ (EC2, one│ │ Review Agent│  │ (code, EC2,  │  │ Agent        │
  │ call, no │ │ (EC2)       │  │ incl. history│  │ (EC2, edits, │
  │ tools)   │ │             │  │ fingerprint) │  │ one call)    │
  └────┬─────┘ └─────┬──────┘  └──────┬───────┘  └──────┬──────┘
       └─────────────┴────────────────┴─────────────────┘
          both agents' prompts include the guideline text / CHT-conventions
          primer directly (cached) — no Knowledge Base, no vector store
                                    │
                          ┌─────────▼──────────┐
                          │   Bedrock + Guardrails │ (screens every model call)
                          └─────────────────────┘
                                    │
                      ⏸ CONTENT APPROVAL (task token) ⏸
                                    │ approved
                                    ▼
                    ┌─────────────────────────────┐
                    │ Deterministic Compiler (code)  │
                    └───────────────┬─────────────┘
                                    ▼
                    ┌─────────────────────────────┐
                    │ One-off build/test container   │  ← fresh per snapshot, read-only
                    │ NO NETWORK — cht-conf +        │    mount, non-root, destroyed after
                    │ cht-conf-test-harness          │
                    └───────────────┬─────────────┘
                                    ▼
                      ⏸ DEPLOY APPROVAL (task token) ⏸
                                    │ approved
                                    ▼
                    ┌─────────────────────────────┐
                    │ Separate Deployer step/role    │  ← only role with Secrets Manager
                    │ cht-conf upload + verify       │    read access, only now
                    └───────────────┬─────────────┘
                                    ▼
                CHW phones sync standard, offline CHT config — no AI on the device
```

All compute — the UI/API, the orchestrator's workers, the agents, the deterministic tools, the build/test container, and the CHT test instance — runs on EC2. Managed AWS is used only for non-compute bookkeeping: Step Functions (approval waits), Bedrock (model calls + Guardrails), S3, DynamoDB, Secrets Manager, CloudWatch.

## 6. Pipeline (Step Functions State Machine)

| # | State | Worker | Who | What happens | Gate? |
|---|---|---|---|---|---|
| 1 | Intake | Intake Agent | AI (single call, no tools) | Turns the request (guideline upload, pathway pick, or plain-language edit) into a structured spec; stores it in S3 + DynamoDB | Schema check |
| 2 | Draft | Drafting / Clinical Review Agent | AI | Drafts the logic snapshot from the spec, with the guideline text given directly in the prompt; cites guideline passages; flags gaps/ambiguities | Flags only |
| 3 | Logic checks | Deterministic validators | Code | Completeness, exclusivity, reachability, catch-all rows, ~12 golden cases, **and** a fingerprint check against past rejected rules for this pathway (§9) | Yes |
| 4 | **Content approval** | Review UI: clinician / program reviewer | Human | Approve, or reject with notes. Binds to one `snapshotHash`; sees any fingerprint-match flag from step 3 | **Yes** |
| 5 | Compile | Deterministic compiler | Code | Approved snapshot → XLSForm + `tasks.js` (+ properties/translations as needed) | Hard gate: must build |
| 6 | Build + test | One-off EC2 container | Code | Fresh, no-network, non-root container: `cht-conf` build, then synthetic patients via `cht-conf-test-harness` | **Yes** |
| 7 | **Deploy approval** | Review UI: IT lead | Human | Reviews the diff and test report | **Yes** |
| 8 | Deploy | Separate deployer step/role | Code | `cht-conf` uploads to the CHT test instance; verifies the instance now serves the built app settings | — |
| — | Sync | CHT (built-in) | — | CHW phones download the update on next connect | — |

**Loops:**
- *Schema-repair loop:* a malformed agent output is retried once on the same model, then once more escalating to a stronger model; two failures in a row kill the draft and surface the error to a human — never silently guessed.
- *Reject loop:* a clinician rejection (or a failed check) routes back to state 2 (Draft / Change Planner), which produces a **new snapshot**, then flows on to state 3 (Logic checks) exactly as a fresh draft would — the same checks apply either way (design rule 3). **Known simplification:** the ideal target, once a dedicated revision step exists, is to re-enter directly at Logic checks with the clinician's note applied as a targeted edit, without re-running the full drafting agent. That step isn't built yet, so v1 re-runs Draft/Change Planner on every rejection. Flagged the same way in the orchestrator's own code comments.
- *Build-failure split (Decisions Log #7):* if the failure means the approved logic itself must change, a new `snapshotHash` is created and content approval runs again. If it's a compiler or infrastructure bug with the logic unchanged, the same container rebuilds against the same hash and the existing content approval remains valid — no need to re-bother the clinician for a tooling retry.

Every human decision (states 4 and 7) is written to the append-only decision log by a Step Functions step — **never by an agent**.

## 7. Agent Roster

Two real agents. Everything else that touches clinical meaning is deterministic code. (See [[architecture-decisions]] ADR-010 through ADR-012 for why the roster shrank from five to two.)

| Agent | Must/Should | Purpose | Model | Allowed Gateway tools | Output schema | Explicitly denied |
|---|---|---|---|---|---|---|
| Intake Agent | Must | Turn a request into a structured spec — **one non-looping Bedrock call**, no tool use | Haiku-tier | Spec-store write (idempotent draft only) | `StructuredSpec` | Everything else: compiler, uploader, approvals, retrieval, memory writes |
| Drafting / Clinical Review Agent | Must | Draft the logic snapshot with citations and flags; guideline text given directly in the prompt (cached), not retrieved | Haiku-tier, escalate to Sonnet-tier after 2 schema failures | None (prompt-stuffed guideline, no retrieval tool) | `LogicModel` + citations + flags | Compiler, uploader, approvals, config files, memory writes |
| Change Planner Agent | Must (for the edit journey) | Propose a structured change plan from a plain-language edit request; CHT-conventions primer given directly in the prompt | Haiku-tier | Baseline-logic fetch, proposal-store write (both deterministic, not model-invoked) | `ChangePlan` | Writing XLSForm/`tasks.js` directly, uploader, approvals, memory writes |

**Never available to any agent, enforced two independent ways** (not registered on the agent-facing Gateway **and** explicitly denied by Cedar Policy `default: deny`, per the Open-path team doc's pattern): `approve-content`, `approve-deploy`, `deploy`, `verify-deploy`, `apply-change-plan`, `compile-config`, `cht-conf-build`, `run-synthetic-tests`, `write-xlsform`, `write-tasksjs`. Denials log to AgentCore Observability.

**Per-agent limits:** Intake and Change Planner need exactly one Bedrock call on the happy path, plus up to 2 schema-repair attempts. Drafting (not covered by this doc's code, built separately) should follow the same bound unless its guideline-reading step genuinely needs more.

**Note for whoever builds the Drafting Agent:** this roster assumes it also stuffs the guideline text directly into its prompt (with caching) rather than calling a Knowledge Base retrieval tool — the KB was cut project-wide (ADR-011). Confirm this matches what's actually being built.

## 8. Grounding Strategy: Prompt-Stuffed, No Vector Store

Both agents that need to ground their output in reference material (Drafting against the guideline; Change Planner against CHT conventions) get that material as plain text, directly in their prompt, with caching to control token cost — not through a Bedrock Knowledge Base or any vector store.

| What's grounded | How | Used by |
|---|---|---|
| Clinical guideline text | Full text of the one guideline for the one pathway being built, included directly in the prompt | Drafting Agent |
| CHT conventions | A short, team-curated primer (a few paragraphs, hand-picked from `medic/cht-docs` and `cht-core/config/default` for the pathway in hand) | Change Planner Agent |

**Why this, not a Knowledge Base (ADR-011):** at this scope — one guideline, one pathway — a vector-search pipeline solves a problem that doesn't exist yet ("find the relevant document among many"). Putting the whole guideline in context is both cheaper (no embeddings, no vector store, no ingestion pipeline) and a *stronger* safety guarantee than top-k retrieval, since there's no risk of the retrieval step missing the one passage that matters. A real Knowledge Base earns its place once Medic has many guidelines that genuinely don't fit in context together — that's Phase 2 per their own vision doc, not the MVP.

**What this does NOT change:** every drafted rule must still cite its source passage (design rule 7/5), and an uncited rule is still flagged, never silently accepted. The citation discipline is a prompt/schema requirement on the agent's output, independent of whether the source text arrived via retrieval or directly in the prompt.

**End-to-end mechanics of the guideline document itself** (this is about the file, distinct from the primer, which is just curated text with no file behind it):

1. **Upload.** The program officer uploads the guideline PDF through the Review UI/API. The UI writes it to **S3** under the `docs/` prefix and assigns it a `docId`; this is a Review UI/API responsibility, not something any agent does.
2. **Reference, not re-upload.** That `docId` (plus a `version` string) is what travels through the pipeline from here on — in the `IntakeRequest`, in the resulting `StructuredSpec`'s `guideline` field, and ultimately recorded on the `LogicModel` snapshot that gets drafted from it. The raw bytes are never re-uploaded or duplicated as they move through the pipeline.
3. **Fetch, then call Bedrock.** When the Drafting Agent runs, it fetches the PDF bytes from S3 by `docId` — a deterministic tool call, the same pattern Change Planner already uses for `getBaselineLogicModel` — and passes them to Claude as a document content block in the Converse call. No OCR step, no Knowledge Base, no ingestion pipeline; the fetch and the model call are the only two steps (ADR-011, ADR-016).
4. **Versioning.** The bucket has S3 object versioning enabled, so even a same-key re-upload never destroys a prior version. More importantly, versioning is explicit in the data model, not just the storage layer: every `guideline` reference carries its own `version` string, and every `LogicModel` snapshot records exactly which guideline version it was drafted against. A guideline update never retroactively touches an already-approved snapshot — it produces a new submission, a new snapshot, and a fresh approval, bound to the new version (see §22's note on guideline-version drift for the operational cost this implies at scale).

Note: this only applies to the **new-pathway** path. An edit never involves a guideline file at all — the officer's plain-language request and the existing `LogicModel` baseline are the only inputs Change Planner needs.

## 9. History Check (Deterministic, Not an Agent)

Folded into Logic Checks (§6, state 3) as a plain function, not a separate service:

- Every rule in a new snapshot is normalized and fingerprinted (hash of its structural condition + action).
- The fingerprint is compared against a DynamoDB index of fingerprints from past **rejected** decisions for the same pathway.
- An exact match surfaces as a high-severity flag on the content-approval screen — advisory only, never auto-blocking; the clinician still decides.

No LLM, no Knowledge Base, no AgentCore Memory. This replaces the earlier three-store "decision memory" design (Decisions Log #8/#13): the part that mattered — don't let a rejected rule quietly resurface — needed a hash lookup, not semantic similarity search. If Medic later wants "flag rules *similar to* (not identical to) a past rejection," that's a genuine LLM use case worth revisiting once there's a large enough decision history for it to matter — not before.

## 10. Logic Model

One structured JSON snapshot is the single source of truth: the approver view, the logic checks, the compiler, and the expected test outcomes all read from it.

```json
{
  "snapshotId": "child-cough-v3",
  "snapshotHash": "<sha256 of baseline + spec + evidence versions + golden-case version + compiler/toolchain identity>",
  "pathway": "Child cough and fast breathing",
  "guideline": { "name": "<public guideline>", "version": "<version>" },
  "inputs": [
    { "id": "age_months", "type": "integer", "label": "Child's age in months" },
    { "id": "breaths_per_min", "type": "integer", "label": "Breaths per minute" },
    { "id": "danger_sign", "type": "yes_no", "label": "Any danger sign?" }
  ],
  "rules": [
    {
      "id": "r1",
      "when": { "all": [ { "input": "danger_sign", "eq": "yes" } ] },
      "then": { "action": "refer_urgently" },
      "followUp": { "dueInDays": 1, "openForDays": 3 },
      "source": { "section": "<section>", "page": 0 }
    },
    { "id": "default", "when": { "otherwise": true }, "then": { "action": "home_care_advice" }, "source": { "section": "<section>", "page": 0 } }
  ],
  "flags": [ { "type": "ambiguity", "text": "<what is unclear>", "source": { "section": "<section>", "page": 0 } } ]
}
```

Each rule is stored **once**, as condition + action + follow-up — a rule like "follow up in 3 days, keep open 7 more" is never split by hand between a form calculation and `tasks.js`; the compiler splits it deterministically. Every model output is validated against this schema (Zod/Ajv) before use. Snapshots are append-only in versioned S3, indexed in DynamoDB.

**`snapshotHash` composition** (adopted from the AgentCore-focused team doc, more rigorous than a bare version number): baseline + full specification + evidence versions + golden-case version + compiler/toolchain identity. This is what lets an infrastructure retry reuse an approval safely (Decisions Log #7) while any real change to meaning forces a new hash and a new approval.

## 11. Change Lifecycle

```
draft → checked → content_review ⏸ → content_approved → built → tested ⏸(deploy_review) → deploy_approved → deployed
  ↑ human edits, new hash         │ checks fail            │ build/infra bug,         │ reject
  └────────────────────────────────┘ reject or open ambiguity  logic unchanged: rebuild SAME hash, approval stays valid
                                                              │ logic must change: NEW snapshotHash, re-approval
                                                                                                    └──────────────────┘
                                                                                      rolledback ← redeploy prior snapshot
```

- Approvals are append-only and bound to the exact `snapshotHash` — never to a conversation.
- `content_review` cannot be exited while an ambiguity is open.
- Deploy is release-only: a preview/non-deployable build (used for before/after edit comparisons) can never reach `deployed`.
- `rolledback` redeploys a prior tested, approved snapshot — the rollback path the demo must show.
- The two `*_review` states park a Step Functions task token, so a pending approval survives an orchestrator restart (the restart-resilience success criterion).

## 12. Compiler Output

Approved logic compiles deterministically into a standard `cht-conf` project: two app forms (e.g. `sick_child_assessment.xlsx`, `sick_child_follow_up.xlsx`), a `properties.json` beside each, one `tasks.js`, and a translations file. The same structured rule produces both the XLSForm `relevance`/`calculate`/`constraint` logic and the `tasks.js` `appliesIf`/`resolvedIf` logic from one source — never two hand-maintained copies that can drift apart. A form-reference integrity check confirms every form ID a task references actually exists before the build is considered valid. No model touches this step; it is plain, deterministic code.

## 13. Build/Test Sandbox and Deployer Separation

**Build/test container** (per snapshot, every time):
- Fresh container from the pinned `medicmobile/cht-app-ide` image (a specific release tag, amd64), started by the orchestrator.
- Snapshot mounted **read-only**; empty scratch/output directory.
- **No network at all** — Chromium and all dependencies baked into the image at build time, so the compile/test phase needs no internet access.
- Non-root, metadata endpoint blocked, only the `SYS_ADMIN` capability (required for headless Chromium) — nothing else.
- Runs `cht --no-check convert-app-forms`, then `cht --no-check compile-app-settings`, then the harness (`mocha` + `cht-conf-test-harness`: `fillForm`/`getTasks`/`setNow`/`flush`), asserts `result.errors` is empty, writes the report, and is **destroyed** — never reused between snapshots.

**Deployer step** (Decisions Log #5, separate from the build container, with its own IAM role):
- Only this role can read the CHT test instance's login from Secrets Manager, and only after deploy approval has been recorded.
- Runs `cht-conf` upload, then a deterministic check that the instance now serves the built app settings.
- Rollback redeploys a prior approved, tested snapshot through this same role.

This split means the container that actually runs arbitrary build/test tooling never holds deployment credentials, and the role that can touch the real CHT instance never runs untrusted build tooling — a materially stronger blast-radius boundary than one container doing both.

## 14. AWS Infrastructure

| Component | Service | Notes |
|---|---|---|
| Compute | EC2 (Ubuntu, x86_64) | t3.xlarge for services/agents/orchestrator workers, t3.large for the CHT test instance |
| AI agents | Containers on the services EC2 instance (framework: Strands Agents or equivalent) | One container per agent; **not** AgentCore Runtime (Decisions Log #3). Two agents, not five (ADR-010/012/013). |
| Agent tools | AgentCore Gateway | Exposes the spec-store and proposal-store writes as MCP tools; Cedar policy in `ENFORCE` mode. No KB retrieval tool (ADR-011). |
| Agent permissions | AgentCore Policy (Cedar) | Enforces each agent's allowed-tool list; deny-by-default |
| Agent identity | AgentCore Identity | Per-agent-container workload identity for calling Gateway; no long-lived keys |
| Agent tracing | AgentCore Observability (OpenTelemetry → CloudWatch) | Every agent step and token count traced per change |
| Orchestrator | AWS Step Functions (standard workflow) | Fixed state machine; task tokens for both approval waits; visual execution graph for the demo |
| Models | Amazon Bedrock, `us.` inference profiles | Smallest model per job behind one interface |
| Input screening | Bedrock Guardrails | Screens every drafting input for personal data before it reaches a model |
| Guideline reading | Claude on Bedrock, direct PDF input | No separate OCR step (Decisions Log #15); output goes straight into the prompt (§8), not into a KB |
| Pipeline state | DynamoDB: `Changes`, `Approvals`, `Audit`, `Tokens` tables | PK `changeId`; see §10–11 for key design. Also holds the History Check fingerprint index (§9). |
| Storage | S3, private, versioned, encrypted (SSE-KMS) | `docs/`, `snapshots/`, `builds/`, `reports/`, `proposals/` prefixes |
| Secrets | Secrets Manager | CHT test instance login — readable only by the deployer role, only post-approval |
| Access | Systems Manager Session Manager | No open SSH/admin ports; IMDSv2 required, hop limit 2 |
| Logs/traces | CloudWatch | Every model call and container log; gives cost-per-run |
| UI sign-in | Cognito + ALB (optional) | Session Manager port forwarding is the event-day fallback |
| Infrastructure as code | Terraform (Medic's standard) or CDK in TypeScript | One deploy command, one teardown command |
| Network | VPC, private subnets for compute, public subnet only for an optional ALB | Gateway→internal-tools connectivity should be smoke-tested on day 1 (it is not automatic) |

**Not used:** AgentCore Runtime, AgentCore Memory, Bedrock Knowledge Bases, any vector store, Amazon Textract, Lambda for application logic, Fargate, SageMaker, RDS/Aurora, Kinesis/MSK, model endpoints outside Bedrock, public S3 buckets, open SSH/admin ports.

## 15. Security and Data Handling

- Synthetic data and public guidelines only; no real patient data or real CHT credentials anywhere in a prompt or trace.
- Bedrock Guardrails screen every drafting input, including extracted guideline text before it's placed in a prompt — not just live chat.
- Least-privilege IAM role per component; no long-lived keys. Each agent container gets its own workload identity (AgentCore Identity) rather than sharing the instance role.
- Build container: non-root, no git write credentials, no Docker socket, only `SYS_ADMIN`, metadata endpoint blocked, **no network**.
- Deployer role: the only component with Secrets Manager read access to the CHT login, gated on deploy approval having been recorded.
- CHT test instance reachable only through Session Manager.
- Append-only audit: every prompt, snapshot, approval, and test report is recorded and never overwritten.
- Public repo (if any) never contains secrets or `.env` files.

## 16. Testing and Verification

All gates are deterministic; a model never judges a test.

| Check | When | Proves |
|---|---|---|
| Schema validation | Every model output | Shape is right before use |
| Logic checks (incl. history fingerprint, §9) | Before content approval | No missing branches, no overlaps, every question reachable, catch-all present, no exact repeat of a rejected rule |
| Golden cases (~12) | Before content approval | Logic matches the guideline's own worked examples; written by the team, confirmed by Medic |
| `cht-conf` build | After compile | Valid CHT configuration — a form that doesn't convert never ships |
| Synthetic patients | After build | 100% branch coverage; built form produces the outcome the approved logic predicts |
| Deployment check (stretch) | After upload | CHT test instance serves the built app settings |

Expected outcomes are always computed from the approved snapshot — never by a model.

## 17. Cost Plan ($500 Sandbox)

- AWS Budgets alerts at $250 and $400.
- Smallest model per job (§7); prompt caching for the guideline text and conventions primer, which are the largest repeated inputs.
- Coding assistants on Bedrock count against the budget — use deliberately.
- Agents share the services EC2 instance, so they add no hosting cost beyond its running hours.
- No Knowledge Base, no vector store, no embeddings — that entire cost category is gone (ADR-011).
- AgentCore Gateway/Policy/Observability bill per call/telemetry volume — tiny at hackathon scale, but report per-run in the README anyway, for Medic's handover.
- Stop EC2 instances outside build hours. Tag every resource with the project tag.
- Record token use per pathway run; report cost per run in the README.
- One teardown command removes everything, including any retained volumes.

## 18. Well-Architected Mapping

### Six-pillar summary

| Pillar | Evidence at the demo |
|---|---|
| Operational excellence | Deploy from README into a fresh account; one change traced request → deploy; agent roles/handoffs documented (§7) |
| Security | Access model, Guardrails, build/deploy credential separation (§13), approvals bound to exact versions |
| Reliability | Restart during an approval wait (task tokens survive it); build-failure split (§6, #7) avoids unnecessary re-approval; rollback to a prior snapshot |
| Performance efficiency | Timed run, guideline to approved tested build in minutes; smallest model per job; two agents, one Bedrock call each on the happy path, no open-ended loops |
| Cost optimization | Spend to date, cost per run, **zero vector-store/KB infrastructure**, teardown command |
| Sustainability | Compute only while building/testing; no model training; CHW phones stay AI-free |

### Agentic AI Lens highlights (adopted from one team doc's review against the AWS Well-Architected Agentic AI Lens)

| Practice | How this design applies it |
|---|---|
| Define agent roles, success criteria, handoffs | §7's table — two agents, each with one job, one output schema, handing off only through Step Functions |
| Bounded autonomy / tool access | AgentCore Policy (Cedar) denies every approve/deploy/write tool, enforced two independent ways (§7) |
| Human-in-the-loop governance | Two approvals via Step Functions task tokens; rejection notes feed back as a new snapshot (never re-guessed by the AI) |
| Testing and evaluation frameworks | Golden cases, logic checks, synthetic patients are the only gates; LLM-as-judge is explicitly excluded, per Medic's stricter rule 6 |
| Arbiter patterns, fallbacks | Step Functions is the arbiter: retries bounded, then routes to a human with the error, never a guess |
| Control reasoning-loop costs | No tool-use loops at all anymore (ADR-010/011) — each agent is one Bedrock call plus bounded schema repair |
| Right-size models, attribute cost | Model tier per agent (§7); tag every resource/call by `agent`, `tenant`, `runId` for per-agent cost reporting |

## 19. Timeline and Cut List

| When | Focus |
|---|---|
| Day 1 AM | CHT setup (per Medic's setup path); pick pathway and guideline; lock the logic-model JSON schema |
| Day 1 PM | Intake + Drafting agents producing a schema-valid `LogicModel`; guideline text prompt-stuffed into Drafting (no ingestion step needed); logic checks; write golden cases |
| Day 2 AM | Step Functions state machine wired end to end; content approval UI; compiler; build/test container (no-network, destroyed-per-run) |
| Day 2 PM | Deploy approval UI; separate deployer step/role; change lifecycle hash-binding and build-failure split (§6/#7/§11); full end-to-end timed run; README, cost tracking |
| Day 3 AM | Rehearse; no new features |

**Cut list, in order, if behind:** deploy upload to live CHT test instance → UI polish. **Never cut:** logic checks, the two approvals, or synthetic-patient testing. (Cross-Check and the AI half of History Check are no longer on this list — they're cut from scope entirely, not deferred; see Decisions Log #12/#13. Chat-based approver UX isn't on this list either — see Decisions Log #14, it was never going to be built.)

## 20. Open Items

- [ ] Final guideline + pathway (child cough and fast breathing is the working example throughout this doc, but not yet locked in by the team).
- [ ] Smoke-test AgentCore Gateway → internal-tools connectivity on day 1 — it is not automatic and was flagged as unverified in more than one source doc.
- [x] ~~Decide the approver UX: decision table, flowchart, chat, or a combination.~~ **Decided: a structured review view (decision table/flowchart over the LogicModel), not chat.** The officer's request stays a single form-style submission into Intake; the clinician's review stays a single static view, not a conversation. See Decisions Log #14.
- [ ] Write the ~12 golden cases once the pathway is locked; get Medic's confirmation in the clinician role.
- [ ] IAM role design per component (one role per agent via AgentCore Identity; separate orchestrator, det-services, deployer, and UI roles) — draft Terraform/CDK modules against §14's service table.
- [ ] Curate the real CHT-conventions primer content for the chosen pathway (the Change Planner Agent's `primer.ts` currently ships placeholder text — see its README).
- [ ] Confirm with whoever builds the Drafting Agent that it prompt-stuffs the guideline rather than calling a Knowledge Base tool (§7 note).

## 21. Production Cost Note

Everything above targets the 2-day hackathon demo, where EC2-always-on is both required by Medic's own rules and cheap in absolute terms over two days. That is **not** the same as the right shape for a real, ongoing deployment, and it's worth saying so plainly rather than letting the hackathon's constraint quietly become a permanent architecture decision:

- The genuinely serverless pieces (Bedrock, Step Functions, DynamoDB on-demand, Lambda glue) scale cost *with* usage, which is correct — more changes processed means more value delivered, at proportionally more cost, with no surprise floor.
- The EC2-hosted pieces (services instance, build/test instance, CHT test instance) carry a fixed cost whether or not anyone submits a change that month, which is the wrong shape for what's almost certainly a low-volume, bursty workload. It gets worse per additional ministry that each gets its own isolated stack.
- If this becomes a real deployment conversation with Medic, the honest recommendation is to move the agent/build tier to scale-to-zero compute — Fargate, or notably AgentCore Runtime itself, which scales to zero between invocations and would be worth reconsidering for production even though it was deliberately skipped for this hackathon build (Decisions Log #3).

No action needed for the demo. Flagging this now so it's on record before anyone mistakes "what we built in two days under Medic's hackathon rules" for "the right production architecture."

## 22. Known Limitations and Non-Technical Risks

Named explicitly rather than implied as solved:

- **Golden-case authoring doesn't scale for free.** Writing ~12 golden cases per pathway needs real clinician time — a scarcer resource than AWS dollars for a nonprofit. More pathways means more of this scarce time spent, mirroring a smaller version of the exact bottleneck this project exists to remove.
- **Guideline-version drift compounds.** When a guideline updates, every pathway drafted against the old version may need re-drafting and re-approval. That's a recurring clinician-time cost that grows with the library of approved pathways, not a one-time build cost.
- **The bottleneck may relocate, not disappear.** This removes the *developer* bottleneck. If clinician availability doesn't grow to match demand for changes, the new bottleneck is "which clinician has time to review an AI draft today" — a people problem, not a technical one.
- **Adoption risk.** A technically safe system still fails if ministry staff don't trust an AI-drafted clinical rule enough to use the no-code path instead of asking a developer out of habit.
- **Handover sustainability.** Medic's own small team has to operate and debug whatever gets handed off after the hackathon. Every additional agent or managed service is something they have to maintain with less context than the team that built it — a second, non-financial argument for the simplification in this revision, independent of cost.
