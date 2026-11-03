# Medic Mobile — FINAL Solution Design (Open Path)

**Status:** Canonical design. Build the code and IaC against this document.
**Supersedes:** [[Medic Mobile - Solution Design (AgentCore + Bedrock)]] (earlier draft, now superseded — see its header note).
**Synthesized from:** This doc, the Vision/Technical Environment source docs, and four team design docs reviewed and reconciled on 2026-11-03 — "Design Doc_ Team Vera," "design doc yash," "vera-design-doc," and "CHT NoCode Architecture - Jonathan H." Where those docs disagreed, the resolution is recorded in the Decisions Log below.
**Track:** Open path. **Example pathway (illustrative only, not yet finalized):** child cough and fast breathing. Final guideline/pathway choice is still open — see §20.

---

## Decisions Log

| # | Decision | Why |
|---|---|---|
| 1 | **Track: Open path.** No cht-ui-builder integration. | Three of four team docs leaned Open path or left it open; only one committed to Reference path. Lower risk than modifying an unfamiliar codebase with known gaps (no approve action, inverted task conditions) under a 2-day deadline. |
| 2 | **Orchestrator: AWS Step Functions**, not a custom EC2-hosted workflow engine. | Managed, built-in task-token approval waits, visual execution history for the demo, far less custom code to write and debug in 2 days. Matches the most detailed of the four team docs; reconfirms the earlier decision this session. |
| 3 | **Agent hosting: plain EC2 containers**, not AgentCore Runtime. **Supersedes the earlier draft's choice of AgentCore Runtime.** AgentCore Gateway, Policy (Cedar), Identity, Memory, and Observability still wrap the agents regardless. | Majority of the team docs converged here; avoids standing up and learning Runtime's deployment model for only 4–5 lightweight agents in a 2-day build. Also removes the AgentCore-orchestration-lock-in tension flagged earlier — with Runtime out of the picture, the agents (built with a portable framework, e.g. Strands Agents) have no AWS-proprietary hosting dependency at all. |
| 4 | **Knowledge Base: full Bedrock Knowledge Base with S3 Vectors**, kept in scope. | Directly implements the grounding/confirmation capability asked for early in this project ("can we add a knowledge base that confirms what the clinician is recommending") and is what would have caught Medic's own bracket-bug near-miss. One team doc argued to cut it for the MVP; overruled — it's load-bearing, not a nice-to-have. |
| 5 | **Build/test sandbox: EC2, no network at all**, with upload as a **separate deployer step/role** that only reads CHT credentials after deploy approval. | Adopted from the Open-path team doc's design: splitting "build and test" (fully offline, no credentials) from "deploy" (a distinct role, credentials only after the second human approval) is a stronger least-privilege/blast-radius boundary than one container doing both. |
| 6 | **Model tiering with model-diversity on cross-check**: the independent cross-check agent always uses a *different* model family than whichever model produced the draft it's checking. | Adopted from the Open-path team doc. A second pass on the *same* model is a weaker independence guarantee than a genuinely different model; this is a low-cost way to strengthen the Should-Have cross-check feature. |
| 7 | **Build/test failure handling splits two ways**: (a) the meaning must change → new `snapshotHash`, back to content approval, clinician re-approves; (b) a compiler/infra bug with unchanged logic → rebuild/rerun the *same* hash, the existing approval stays valid. | Adopted from the Open-path team doc. Avoids re-bothering a clinician for a pure tooling retry while still forcing re-approval whenever meaning actually changes — a meaningfully better reliability design than treating every build failure the same way. |
| 8 | **Decision memory / history check (Should-have, not Must-have).** AgentCore Memory holds plain-language summaries of past approvals/rejections for agents to learn from; DynamoDB + S3 remain the exact, append-only source of truth; a History Check step flags similarities/exact-matches to IT as advisory-only (never blocking). | Adopted from one team doc's design — directly strengthens the audit and reversibility rules, cheap to build once the core pipeline works, and genuinely differentiates the demo. First item to cut if day 1 runs long, alongside independent cross-check. |
| 9 | **EC2, not EKS/ECS**, for the demo deployment. | Reconfirmed from earlier this session — single-instance, 2-day build; no multi-tenant bin-packing need yet. One team doc used ECS; not adopted, to keep setup surface minimal. |
| 10 | **Vector store: Amazon S3 Vectors**, not OpenSearch Serverless. | Reconfirmed from earlier this session; two of four team docs independently converged on the same choice. |

---

## 1. Problem Statement

A clinical protocol can be updated in days; translating that update into CHT's actual configuration — XLSForm, JSON, JavaScript — takes weeks to months, because that translation currently requires one of a small pool of developers and a full release cycle, however small the change. The CHT serves 182,000+ community health workers across 24 countries; eight governments run it as their national platform and cannot adapt it themselves. Changes must also stay safe: a real prototype bug (two missing brackets) would have changed who sees 11 of 24 forms in a national configuration, and every manual check passed — only running synthetic patients through the build exposed it.

**Restated:** Non-technical program staff and clinicians have no way to safely change CHT configuration themselves. The fix must remove the *coding* requirement without removing a single check or approval that currently catches unsafe changes.

## 2. Solution Summary

AI drafts and flags. Code builds and tests. Humans approve twice. A program officer uploads a public guideline (or describes a change in plain language); Bedrock-backed agents draft the pathway's logic, citing every rule to its source passage and grounding it against a Knowledge Base; deterministic code checks it (completeness, exclusivity, reachability, golden cases); a clinician approves the exact version; deterministic code — never a model — compiles it into real CHT files; a fresh sandboxed build proves it with synthetic patients; IT approves the diff and test report; a separate deployer step uploads it. CHW phones get it on their next sync, running standard, offline, non-AI configuration throughout.

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
       ┌────────────┬───────────────┼───────────────┬────────────────┐
       ▼            ▼               ▼               ▼                ▼
  ┌─────────┐ ┌───────────┐  ┌────────────┐  ┌─────────────┐  ┌─────────────┐
  │ Intake   │ │ Drafting / │  │ Cross-check │  │ Deterministic│  │ Change       │
  │ Agent    │ │ Clinical    │  │ Agent       │  │ logic checks │  │ Planner      │
  │ (EC2)    │ │ Review Agent│  │ (EC2, Should│  │ (code, EC2)  │  │ Agent        │
  │          │ │ (EC2)       │  │ -Have)      │  │              │  │ (EC2, edits) │
  └────┬─────┘ └─────┬──────┘  └──────┬─────┘  └──────┬───────┘  └──────┬──────┘
       └─────────────┴────────────────┴───────────────┴─────────────────┘
                    all reach tools only through AgentCore Gateway (Policy/Cedar enforced inside)
                                    │
                          ┌─────────▼──────────┐
                          │ Bedrock Knowledge   │   Bedrock + Guardrails
                          │ Base (S3 Vectors)   │◄──(screens every model call)
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
                    ┌─────────────────────────────┐
                    │ History Check (Should-Have)    │  advisory flags only, never blocks
                    └───────────────┬─────────────┘
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

All compute — the UI/API, the orchestrator's workers, the agents, the deterministic tools, the build/test container, and the CHT test instance — runs on EC2. Managed AWS is used only for non-compute bookkeeping: Step Functions (approval waits), Bedrock (model calls + Guardrails + Knowledge Base), S3, DynamoDB, Secrets Manager, CloudWatch.

## 6. Pipeline (Step Functions State Machine)

| # | State | Worker | Who | What happens | Gate? |
|---|---|---|---|---|---|
| 1 | Intake | Intake Agent | AI | Turns the request (guideline upload, pathway pick, or plain-language edit) into a structured spec; stores it in S3 + DynamoDB | Schema check |
| 2 | Draft | Drafting / Clinical Review Agent | AI | Drafts the logic snapshot from the spec + Knowledge Base; cites guideline passages; flags gaps/ambiguities | Flags only |
| 3 | Cross-check *(Should-Have)* | Cross-Check Agent | AI | Independently re-derives the logic using a different model family than the draft; disagreements flagged | Flags only |
| 4 | Logic checks | Deterministic validators | Code | Completeness, exclusivity, reachability, catch-all rows, ~12 golden cases | Yes |
| 5 | **Content approval** | Review UI: clinician / program reviewer | Human | Approve, or reject with notes. Binds to one `snapshotHash` | **Yes** |
| 6 | Compile | Deterministic compiler | Code | Approved snapshot → XLSForm + `tasks.js` (+ properties/translations as needed) | Hard gate: must build |
| 7 | Build + test | One-off EC2 container | Code | Fresh, no-network, non-root container: `cht-conf` build, then synthetic patients via `cht-conf-test-harness` | **Yes** |
| 8 | History check *(Should-Have)* | History Check Agent + code | AI + Code | Compares the change against past approved/rejected decisions; produces advisory flags for IT | Advisory; flags must be acknowledged, never auto-block |
| 9 | **Deploy approval** | Review UI: IT lead | Human | Reviews diff, test report, and history flags; acknowledges each flag | **Yes** |
| 10 | Deploy | Separate deployer step/role | Code | `cht-conf` uploads to the CHT test instance; verifies the instance now serves the built app settings | — |
| — | Sync | CHT (built-in) | — | CHW phones download the update on next connect | — |

**Loops:**
- *Schema-repair loop:* a malformed agent output is retried once on the same model, then once more escalating to a stronger model; two failures in a row kill the draft and surface the error to a human — never silently guessed.
- *Reject loop:* a clinician rejection (or a plain-language edit) creates a **new snapshot** and re-enters at state 4 (Logic checks) — never back at the Drafting agent to be re-guessed. AI drafts and hand edits always share the same checks (design rule 3).
- *Build-failure split (Decisions Log #7):* if the failure means the approved logic itself must change, a new `snapshotHash` is created and content approval runs again. If it's a compiler or infrastructure bug with the logic unchanged, the same container rebuilds against the same hash and the existing content approval remains valid — no need to re-bother the clinician for a tooling retry.

Every human decision (states 5 and 9) is written to the append-only decision log by a Step Functions step — **never by an agent**.

## 7. Agent Roster

| Agent | Must/Should | Purpose | Model | Allowed Gateway tools | Output schema | Explicitly denied |
|---|---|---|---|---|---|---|
| Intake Agent | Must | Turn a request into a structured spec | Haiku-tier | `kb.search(guideline)`, spec-store write (idempotent draft only) | `StructuredSpec` | Compiler, uploader, approvals, KB/memory writes |
| Drafting / Clinical Review Agent | Must | Draft the logic snapshot with citations and flags | Haiku-tier, escalate to Sonnet-tier after 2 schema failures | `kb.search(guideline)`, `get-logic`, `validate-logic` | `LogicModel` + citations + flags | Compiler, uploader, approvals, config files, memory writes |
| Cross-Check Agent | Should-Have (first cut if day 1 runs long) | Independently re-derive the logic | Sonnet-tier, **always the opposite model family from whichever produced the current draft** (Decisions Log #6) | `kb.search(guideline)` | `LogicModel` (2nd opinion) | Same as above |
| Change Planner Agent | Must (for the edit journey) | Propose a structured change plan from a plain-language edit request | Haiku-tier | `kb.search(cht-docs, reference-config)`, `get-logic`, `diff-logic` | `ChangePlan` | Writing XLSForm/`tasks.js` directly, uploader, approvals, memory writes |
| History Check Agent | Should-Have (second cut if day 1 runs long) | Flag similarities to past decisions for IT | Haiku-tier | Decision-log read, decision-memory read | `flags[]`, advisory only | Writing/editing decisions or memory, approvals, uploader, blocking a run |

**Never available to any agent, enforced two independent ways** (not registered on the agent-facing Gateway **and** explicitly denied by Cedar Policy `default: deny`, per the Open-path team doc's pattern): `approve-content`, `approve-deploy`, `deploy`, `verify-deploy`, `apply-change-plan`, `compile-config`, `cht-conf-build`, `run-synthetic-tests`, `write-xlsform`, `write-tasksjs`. Denials log to AgentCore Observability.

**Per-agent limits** (initial values to tune, not accuracy guarantees): at most 4 tool calls and 2 Bedrock turns per drafting attempt, with at most 1 schema-repair turn, before the attempt fails to a human with the error.

## 8. Knowledge Base Architecture

A Bedrock Knowledge Base over a private, versioned, encrypted S3 bucket (`kb-source`), one prefix per source, embedded with Titan Text Embeddings V2, indexed in **Amazon S3 Vectors** (Decisions Log #10).

| Source | S3 prefix | Chunking | Metadata per chunk | Used by |
|---|---|---|---|---|
| Clinical guideline | `guideline/` | By section; tables/decision charts kept whole | `guideline`, `version`, `section`, `page`, `tableId` | Drafting, Cross-Check agents |
| CHT documentation (only the pages needed — XLSForm, tasks, `cht-conf`, reference app) | `cht-docs/` | By Markdown heading | `path`, `topic` | Change Planner agent |
| Reference configs (`cht-core/config/default`) | `reference-config/` | One chunk per form, one per task | `file`, `workflow` | Change Planner agent |

**Access rule:** agents never call the Knowledge Base directly — only through one shared **retrieval service** (its own container, called via AgentCore Gateway), which applies the source filter, returns chunks with citations, and logs every query to CloudWatch, stored with the snapshot. A rule drafted with no citation is flagged, never silently accepted. The retrieval service is the only enforcement point for "every answer carries a citation" — it cannot be bypassed.

**Boundary:** the Knowledge Base informs agents; it never decides. Logic checks, golden cases, and synthetic patients remain the only gates. It holds documents only — never patient data, credentials, golden cases, or anything from the `cht-docs` MCP server (which runs outside the AWS account).

## 9. Decision Memory / History Check (Should-Have)

Three stores, three distinct jobs, no duplication — adopted directly from the most detailed team doc's design, since it maps cleanly onto the audit/reversibility rules already required:

| Store | Holds | Writer | Reader | Role |
|---|---|---|---|---|
| Bedrock Knowledge Base | Guideline, CHT docs, reference configs | Ingest container (code) | Agents, via retrieval service | Documents with citations |
| **AgentCore Memory** (long-term) | Plain-language summaries of past approvals/rejections, namespaced per pathway | Memory writer (code, not an agent) | Drafting, Cross-Check, Change Planner, History Check agents | Learning from precedent |
| DynamoDB + S3 | Exact decision records, rule fingerprints, approvals | Step Functions (code) | History Check (exact match), review UI, auditors | Source of truth and audit |

Agents **read** memory; only code writes it, so a model can never alter what it learns from. An exact fingerprint match to a *rejected* rule surfaces as a high-severity flag at the top of IT's deploy-approval screen; flags are always advisory and must be acknowledged, never auto-blocking.

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
| AI agents | Containers on the services EC2 instance (framework: Strands Agents or equivalent) | One container per agent; **not** AgentCore Runtime (Decisions Log #3) |
| Agent tools | AgentCore Gateway | Exposes KB retrieval and the spec store as MCP tools; Cedar policy in `ENFORCE` mode |
| Agent permissions | AgentCore Policy (Cedar) | Enforces each agent's allowed-tool list; deny-by-default |
| Agent identity | AgentCore Identity | Per-agent-container workload identity for calling Gateway; no long-lived keys |
| Agent memory | AgentCore Memory (long-term) | Decision-history learning only (§9); never an approval authority |
| Agent tracing | AgentCore Observability (OpenTelemetry → CloudWatch) | Every agent step, tool call, and token count traced per change |
| Orchestrator | AWS Step Functions (standard workflow) | Fixed state machine; task tokens for both approval waits; visual execution graph for the demo |
| Models | Amazon Bedrock, `us.` inference profiles | Smallest model per job behind one interface (Decisions Log #6; §7 table) |
| Input screening | Bedrock Guardrails | Screens every drafting input for personal data before it reaches a model |
| Knowledge Base | Bedrock Knowledge Base + Titan Text Embeddings V2 + **S3 Vectors** | §8 |
| Guideline reading | Claude on Bedrock (direct PDF input) or Textract | Pick by measured accuracy during setup |
| Pipeline state | DynamoDB: `Changes`, `Approvals`, `Audit`, `Tokens` tables | PK `changeId`; see §10–11 for key design |
| Storage | S3, private, versioned, encrypted (SSE-KMS) | `docs/`, `snapshots/`, `builds/`, `reports/`, `proposals/` prefixes; separate `kb-source` bucket for the KB |
| Secrets | Secrets Manager | CHT test instance login — readable only by the deployer role, only post-approval |
| Access | Systems Manager Session Manager | No open SSH/admin ports; IMDSv2 required, hop limit 2 |
| Logs/traces | CloudWatch | Every model call and container log; gives cost-per-run |
| UI sign-in | Cognito + ALB (optional) | Session Manager port forwarding is the event-day fallback |
| Infrastructure as code | Terraform (Medic's standard) or CDK in TypeScript | One deploy command, one teardown command |
| Network | VPC, private subnets for compute, public subnet only for an optional ALB | Gateway→internal-tools connectivity should be smoke-tested on day 1 (it is not automatic) |

**Not used:** AgentCore Runtime, Lambda for application logic, Fargate, SageMaker, RDS/Aurora, Kinesis/MSK, model endpoints outside Bedrock, public S3 buckets, open SSH/admin ports.

## 15. Security and Data Handling

- Synthetic data and public guidelines only; no real patient data or real CHT credentials anywhere in a prompt or trace.
- Bedrock Guardrails screen every drafting input; the Knowledge Base ingestion path is screened too, not just live chat (a guideline PDF is a second entry point for personal data, not just chat text).
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
| Logic checks | Before content approval | No missing branches, no overlaps, every question reachable, catch-all present |
| Golden cases (~12) | Before content approval | Logic matches the guideline's own worked examples; written by the team, confirmed by Medic |
| `cht-conf` build | After compile | Valid CHT configuration — a form that doesn't convert never ships |
| Synthetic patients | After build | 100% branch coverage; built form produces the outcome the approved logic predicts |
| Deployment check (stretch) | After upload | CHT test instance serves the built app settings |

Expected outcomes are always computed from the approved snapshot — never by a model.

## 17. Cost Plan ($500 Sandbox)

- AWS Budgets alerts at $250 and $400.
- Smallest model per job (§7); prompt caching for repeated guideline text within a session.
- Coding assistants on Bedrock count against the budget — use deliberately.
- Agents share the services EC2 instance, so they add no hosting cost beyond its running hours.
- AgentCore Gateway/Policy/Memory/Observability bill per call/record/telemetry volume — tiny at hackathon scale, but report per-run in the README anyway, for Medic's handover.
- S3 Vectors has no provisioned-capacity floor, unlike OpenSearch Serverless — confirm `us-west-2` support on day 1; fall back to OpenSearch Serverless (with explicit teardown) only if unavailable.
- Stop EC2 instances outside build hours. Tag every resource with the project tag.
- Record token use per pathway run; report cost per run in the README.
- One teardown command removes everything, including the vector store and any retained volumes.

## 18. Well-Architected Mapping

### Six-pillar summary

| Pillar | Evidence at the demo |
|---|---|
| Operational excellence | Deploy from README into a fresh account; one change traced request → deploy; agent roles/handoffs documented (§7) |
| Security | Access model, Guardrails, build/deploy credential separation (§13), approvals bound to exact versions |
| Reliability | Restart during an approval wait (task tokens survive it); build-failure split (§6, #7) avoids unnecessary re-approval; rollback to a prior snapshot |
| Performance efficiency | Timed run, guideline to approved tested build in minutes; smallest model per job; fixed pipeline, no open-ended agent loops |
| Cost optimization | Spend to date, cost per run, S3 Vectors over a provisioned vector store, teardown command |
| Sustainability | Compute only while building/testing; no model training; CHW phones stay AI-free |

### Agentic AI Lens highlights (adopted from one team doc's review against the AWS Well-Architected Agentic AI Lens)

| Practice | How this design applies it |
|---|---|
| Define agent roles, success criteria, handoffs | §7's table — each agent has one job, one output schema, and hands off only through Step Functions |
| Bounded autonomy / tool access | AgentCore Policy (Cedar) denies every approve/deploy/write tool, enforced two independent ways (§7) |
| Human-in-the-loop governance | Two approvals via Step Functions task tokens; rejection notes feed back as a new snapshot (never re-guessed by the AI) |
| Testing and evaluation frameworks | Golden cases, logic checks, synthetic patients are the only gates; LLM-as-judge is explicitly excluded, per Medic's stricter rule 6 |
| Arbiter patterns, fallbacks | Step Functions is the arbiter: retries bounded, then routes to a human with the error, never a guess |
| Control reasoning-loop costs | No free-running loops; bounded tool calls/turns per agent attempt (§7) |
| Right-size models, attribute cost | Model tier per agent (§7); tag every resource/call by `agent`, `tenant`, `runId` for per-agent cost reporting |

## 19. Timeline and Cut List

| When | Focus |
|---|---|
| Day 1 AM | CHT setup (per Medic's setup path); pick pathway and guideline; lock the logic-model JSON schema |
| Day 1 PM | Intake + Drafting agents producing a schema-valid `LogicModel`; Knowledge Base ingestion (guideline + CHT docs); logic checks; write golden cases |
| Day 2 AM | Step Functions state machine wired end to end; content approval UI; compiler; build/test container (no-network, destroyed-per-run) |
| Day 2 PM | Deploy approval UI; separate deployer step/role; change lifecycle hash-binding and build-failure split (§6/#7/§11); full end-to-end timed run; README, cost tracking |
| Day 2 evening | Cross-check agent and History check agent, **only if on schedule** |
| Day 3 AM | Rehearse; no new features |

**Cut list, in order, if behind:** History Check agent → Cross-Check agent → deploy upload to live CHT test instance → chat-based approver UX → UI polish. **Never cut:** logic checks, the two approvals, or synthetic-patient testing.

## 20. Open Items

- [ ] Final guideline + pathway (child cough and fast breathing is the working example throughout this doc, but not yet locked in by the team).
- [ ] Confirm `us-west-2` S3 Vectors support for Bedrock Knowledge Bases on day 1; have the OpenSearch Serverless fallback ready.
- [ ] Smoke-test AgentCore Gateway → internal-tools connectivity on day 1 — it is not automatic and was flagged as unverified in more than one source doc.
- [ ] Decide the approver UX: decision table, flowchart, chat, or a combination (Open path leaves this to the team).
- [ ] Write the ~12 golden cases once the pathway is locked; get Medic's confirmation in the clinician role.
- [ ] IAM role design per component (one role per agent via AgentCore Identity; separate orchestrator, det-services, deployer, and UI roles) — draft Terraform/CDK modules against §14's service table.
