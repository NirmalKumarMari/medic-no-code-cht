# Architecture Decisions — Medic Mobile No-Code CHT Configuration

Companion to [[Medic Mobile - FINAL Solution Design (Open Path)]]. That document says what the solution *is*; this one records why each major call was made the way it was, including the two decisions this project reconsidered and reversed. Numbered chronologically, in the order the decisions were actually made. "Superseded" means a later ADR changed the call — the original entry is kept, not deleted, so the reasoning trail stays intact.

---

### ADR-001: Build track — Open path, not Reference path

**Status:** Decided.

**Context:** Medic's hackathon offers two tracks. Reference path means building inside `cht-ui-builder`, Medic's existing open-source editor. Open path means a fresh guideline-to-`cht-conf` pipeline with a team-designed approver UI. Four independently-written team design docs split on this: one committed hard to Reference path, two leaned Open path or left it open, and the fourth was explicitly Open path.

**Decision:** Open path.

**Why:** `cht-ui-builder` has known gaps (no approve action yet, a sign-off view that shows some task conditions inverted) that would need fixing before any approval workflow could be safely built on top of it. Taking on an unfamiliar codebase's existing bugs, on a 2-day clock, is a worse risk than building fresh. Three of the four source docs independently leaned the same way.

**Consequences:** No reuse of `cht-ui-builder`'s editor UI or its existing tests. The approver experience (decision table, flowchart, or chat) is built from scratch — left as an open item, not a blocker.

---

### ADR-002: Orchestrator — AWS Step Functions, not a custom EC2-hosted workflow engine

**Status:** Decided.

**Context:** Two of four team docs built their own hand-written durable workflow process on EC2 for pipeline sequencing and human-approval waits. One used AWS Step Functions outright.

**Decision:** AWS Step Functions (standard workflow), with `.waitForTaskToken` for both human-approval gates.

**Why:** A managed state machine with built-in, durable task-token waits, a visual execution history for the demo, and far less custom code to write and debug in two days. A hand-rolled orchestrator would need to reimplement exactly the restart-safety and durable-wait behavior Step Functions already provides.

**Alternatives considered:** Custom EC2-hosted orchestrator (full control, but build-your-own durability); hybrid (custom step sequencing, Step Functions only for the approval waits). Rejected both — no concrete advantage over Step Functions outright that offset the extra code to write and test.

---

### ADR-003: Agent hosting — plain EC2 containers, not AgentCore Runtime

**Status:** Decided. **Supersedes an earlier draft of this project's own design, which originally specified AgentCore Runtime.**

**Context:** AgentCore Runtime is AWS's managed hosting for agents. One team doc made it a hard requirement; another skipped it entirely in favor of plain EC2 containers with AgentCore's other primitives (Gateway, Policy, Identity, Observability) wrapped around them; a third made it a runtime flag (EC2 by default, Runtime only if explicitly approved).

**Decision:** Plain EC2 containers. AgentCore Gateway (tool exposure + Cedar policy enforcement), Policy, Identity, and Observability are still used; Runtime specifically is not.

**Why:** For two lightweight agents (after ADR-010/012/013 cut the roster down), standing up and learning Runtime's deployment model is new infrastructure surface with no clear payoff at this scale. The majority of the reviewed team docs converged on skipping it. It also resolves a tension flagged earlier in this project: with Runtime out of the picture, the agents (built on a portable framework, e.g. Strands Agents) have no AWS-proprietary hosting dependency — only the Gateway/Policy/Identity/Observability wrapper is AWS-specific, and that wrapper sits behind a clean interface in the code (see ADR-007).

**Consequences:** No scale-to-zero behavior for agent compute during the hackathon (see ADR-014 for why that matters for production, not the demo).

---

### ADR-004: Build/test sandbox has no network at all; deploy is a separate role

**Status:** Decided.

**Context:** The build/test step runs arbitrary `cht-conf` and Chromium-based test tooling against an approved snapshot. The deploy step needs real CHT test-instance credentials. One design had a single container/role doing both.

**Decision:** The build/test container runs fully offline (no network, no credentials at all); a separate deployer step/role is the only thing with Secrets Manager read access to the CHT login, and only after deploy approval is recorded.

**Why:** Least privilege and blast-radius reduction. The container that runs the least-trusted code (arbitrary build/test tooling against whatever got approved) never holds deployment credentials; the role that can touch the real CHT instance never runs that build/test tooling. One container doing both would mean a build/test compromise could reach production credentials.

---

### ADR-005: Build-failure handling splits by cause, not treated uniformly

**Status:** Decided.

**Context:** A build/test failure after content approval could mean either (a) the approved logic itself is wrong and needs to change, or (b) a compiler/infrastructure bug occurred with the logic unchanged. Treating both the same way means either re-approving on every transient failure (annoying, trains clinicians to rubber-stamp) or never safely retrying (blocks on every flake).

**Decision:** Split explicitly. Case (a): new `snapshotHash`, back to content approval, clinician re-approves. Case (b): rebuild/rerun against the *same* hash; the existing approval remains valid.

**Why:** Avoids re-bothering a clinician for a pure tooling retry, while still forcing a fresh approval whenever the actual clinical meaning changes. A meaningfully better reliability design than a single uniform failure path.

---

### ADR-006: EC2, not EKS or ECS, for the hackathon demo

**Status:** Decided for the demo; explicitly revisited for production in ADR-014.

**Context:** A single-instance, 2-day build has no multi-tenant bin-packing need. One team doc used ECS.

**Decision:** Plain Docker on EC2 for the demo.

**Why:** ECS's managed-restart benefit isn't worth the extra setup surface for one instance over two days. EKS is far more setup overhead than a single-instance demo justifies. See ADR-014 for why this answer does not automatically carry over to a real production deployment, especially one scaling to multiple ministries.

---

### ADR-007: Model replaceability and orchestration portability are two separate concerns

**Status:** Decided (a framing decision, not an infrastructure change).

**Context:** Medic's own rule says "the model must stay replaceable" and ministries must be able to "run without Medic or any single vendor." Using AgentCore (ADR-003) raised the question of whether that violates this principle.

**Decision:** Treat them as two different layers. The *model* (which LLM answers a prompt) stays fully replaceable regardless of AgentCore — AgentCore Runtime/Gateway call Bedrock, they don't become the model, so swapping models is a config change either way. The *orchestration/hosting layer* (AgentCore Gateway/Policy/Identity/Observability) is a real, separate AWS dependency with no self-hostable equivalent.

**Why:** Conflating the two would either (a) wrongly block using any AgentCore primitive, or (b) wrongly claim full vendor-neutrality the design doesn't actually have. Precision here matters for an honest answer to a judge or to Medic about what's actually portable.

**Consequences:** Each agent's actual prompt/tool logic is written as plain functions AgentCore invokes, not interwoven with AgentCore-specific APIs throughout — a thin adapter boundary, not a full abstraction layer (not worth building further for a 2-day hackathon). The README should state plainly: model is replaceable today; the orchestration wrapper is AWS-native for this build, with a documented path off it if a ministry's infrastructure policy ever required it.

---

### ADR-008: TypeScript across agents, orchestrator, and services

**Status:** Decided.

**Context:** Medic's technical environment document requires TypeScript for "Services" and CDK code, and permits Python only for specific cases (PDF/XLSForm tooling, or "isolated services where a Python library is clearly better").

**Decision:** TypeScript everywhere built so far — Intake Agent, Change Planner Agent, the Step Functions CDK stack, the Approvals API.

**Why:** Every piece built is squarely a "service" by the doc's own definition; none has a distinctive need for a Python-only library. Direct Bedrock Converse calls via AWS SDK v3 give the same capability as Python's boto3, so there's no functional reason to switch. Consistency also matters operationally: one language, one test/build convention, one Docker base pattern across every piece, rather than two stacks for agents that are otherwise shaped identically.

**Consequences:** Python remains legitimately on the table for the Compiler (if it ends up reusing `cht-ai-tools`' existing `openpyxl`-based XLSForm scripts) or guideline-PDF extraction — neither of which has been built yet.

---

### ADR-009: Vector store choice — S3 Vectors over OpenSearch Serverless

**Status:** Moot. **Superseded by ADR-011 — there is no vector store in the MVP at all.**

**Context, for the record:** When a Knowledge Base was still in scope, OpenSearch Serverless (Bedrock KB's default vector store) bills a provisioned-capacity floor hourly regardless of query volume; S3 Vectors is pay-per-use with no floor. Two of four team docs independently converged on S3 Vectors for this reason.

**Why it no longer matters:** ADR-011 removed the Knowledge Base entirely, so the choice of vector store underneath it became moot. Kept here only so the reasoning that led to ADR-011 is traceable — the KB wasn't cut because its vector store was too expensive; the whole retrieval architecture was reconsidered as more infrastructure than the problem needed.

---

### ADR-010: Intake Agent simplified to a single Bedrock call, no tool use

**Status:** Decided (reconsideration of this project's own earlier design).

**Context:** The Intake Agent originally had a tool-calling loop (search a guideline Knowledge Base, up to 4 tool calls, 2 Bedrock turns) to normalize a request into a structured spec. On review — explicitly prompted by "don't build agents for the sake of having agents" — this was more machinery than the job needed.

**Decision:** One non-looping Bedrock call, no tools, with the existing schema-validation-and-repair retry kept (that part is cheap and still valuable).

**Why:** Normalizing a request into structured fields and flagging what's ambiguous or missing doesn't require retrieval or multi-turn reasoning. The guideline-search tool it had was never load-bearing — it existed because "agent" was the default shape reached for, not because the task demanded it. Removing it cuts Bedrock calls per run, removes a Knowledge Base dependency this agent never actually needed, and is strictly less for a reviewer (or a judge) to have to follow, for the identical output.

**Consequences:** `agents/intake-agent`'s `tools.ts` lost `searchGuidelineKb` entirely; it now exposes only the idempotent spec-store write. Tests updated to assert exactly one Bedrock call on the happy path.

---

### ADR-011: No Knowledge Base, no vector store — prompt-stuffing instead

**Status:** Decided (reconsideration of this project's own earlier design; directly reverses the choice recorded in ADR-009's context and the original Decisions Log #4).

**Context:** Earlier in this project, a full Bedrock Knowledge Base (Titan embeddings, S3 Vectors, a retrieval service) was deliberately kept in scope, reasoning that grounding drafted rules against the real guideline text is exactly the mechanism that would have caught Medic's own bracket-bug near-miss — a drafted rule that passed every structural check but didn't actually match the guideline. That reasoning about *why grounding matters* was correct and is unchanged. What changed is the judgment about *how much infrastructure grounding requires* at this project's actual scope.

**Decision:** Drop the vector-search Knowledge Base entirely. Put the full guideline text (for the one pathway being built) and a short, curated CHT-conventions primer directly into the Drafting and Change Planner agents' prompts, with caching to control token cost.

**Why:** A vector-search pipeline is sized for "find the relevant document among many" — a problem that doesn't exist at this scope, since the hackathon's own stated scope is one guideline, one pathway. For a document that small, putting the whole thing in context is both cheaper (no embeddings, no ingestion pipeline, no vector-store cost floor) and a *stronger* grounding guarantee than top-k retrieval, because there's no risk of a retrieval step missing the one passage that actually matters. One of the four original team docs argued exactly this point for the MVP; it was initially overruled and, on reflection, shouldn't have been — the KB's safety *goal* was never in question, only whether this specific scope justified the machinery.

**Consequences:** Removed `@aws-sdk/client-bedrock-agent-runtime` from both agents' dependencies. `agents/change-planner-agent/src/primer.ts` holds the (currently placeholder) CHT-conventions text — a real curation task for the team, separate from the mechanism. Whoever builds the Drafting Agent needs to follow the same pattern for the guideline text; flagged as an open item to confirm. Revisit a real Knowledge Base only if Medic scales to enough guidelines/pathways that they genuinely stop fitting in context together — explicitly a Phase 2 concern per Medic's own vision document, not this MVP's.

---

### ADR-012: Cross-Check Agent cut from the pipeline entirely

**Status:** Decided (reconsideration; stronger than this project's own earlier "Should-Have, cut first if time runs short" framing).

**Context:** The Cross-Check Agent re-derived drafted logic independently (using a deliberately different model family than the draft, per the original Decisions Log #6) and flagged disagreements. Every version of this design — including this project's own earlier drafts — already flagged it as the first thing to cut under time pressure, which was itself a signal worth listening to more carefully.

**Decision:** Cut entirely from the default pipeline, not deferred as a stretch goal.

**Why:** It doubles the cost of every single drafting call, forever, in exchange for catching disagreements that deterministic logic checks, golden cases, and an actual clinician's review already substantially cover. Those are the real safety backstops Medic's own rules insist on (a model never judges a test — the deterministic layer carries that weight, not a second AI opinion). Paying double on every run for a marginal increment of safety on top of that doesn't hold up once "don't build agents for the sake of having agents" is actually applied.

**Consequences:** If the underlying idea is ever wanted, it should be a manual "re-draft with a different model and diff the two outputs" action a clinician invokes on a specific change they're unsure about — not an automatic step on every change. Not built in any form yet; no code to remove.

---

### ADR-013: History Check is deterministic code, not an agent

**Status:** Decided (reconsideration; replaces the three-store "decision memory" design in the original Decisions Log #8).

**Context:** The original design built an elaborate three-store system for this: a Bedrock Knowledge Base, AgentCore Memory holding plain-language decision summaries for agents to learn from, and DynamoDB/S3 as the exact audit record — with two check layers, an exact-fingerprint-match (code) and a semantic-similarity pass (an LLM agent). On review, this reached for AgentCore Memory because the primitive existed, not because the problem demanded an LLM.

**Decision:** Keep only the exact-fingerprint-match layer, as a plain function folded into Logic Checks — a DynamoDB hash lookup against past rejected rules for the same pathway. Drop the AI-semantic-similarity layer and AgentCore Memory's decision-learning use case entirely.

**Why:** The part that actually mattered — never let IT silently re-approve a rule a clinician already explicitly rejected — needs no language model, just a hash comparison. The part that genuinely needed an LLM (summarizing "similar but not identical" past decisions) is the speculative half, and at Medic's realistic low volume of changes, an IT lead can plausibly read the last few related entries themselves just as well. Not worth the recurring agent cost for that benefit.

**Consequences:** No separate History Check service exists. The fingerprint index lives in the same DynamoDB tables already used for pipeline state. If Medic's decision volume ever grows enough that a human can no longer eyeball "similar" past decisions, that's the point to revisit an LLM-backed similarity layer — not before.

---

### ADR-014: Production compute shape is a deferred decision, not resolved by the hackathon build

**Status:** Deferred — documented so it isn't mistaken for settled.

**Context:** ADR-003 and ADR-006 chose plain EC2, always-on, for the hackathon demo — correctly, since Medic's own hackathon rules require containers on EC2 and two days of always-on compute is trivially cheap regardless. That is a different question from what a real, ongoing deployment for a cost-sensitive nonprofit should run on.

**Decision:** None yet, by design. Recorded explicitly as open rather than letting the hackathon's constraint silently become Medic's production answer.

**Why it matters:** The genuinely serverless parts of this architecture (Bedrock, Step Functions, DynamoDB on-demand) scale cost with usage, which is correct for a bursty, low-volume workload. The EC2-hosted parts carry a fixed cost whether or not a change is submitted that month, and that cost multiplies per additional ministry if each gets its own isolated stack. If this becomes a real deployment conversation, the honest recommendation is to move the agent/build tier to scale-to-zero compute — Fargate, or notably AgentCore Runtime itself (deliberately not used per ADR-003, for hackathon-scope reasons that don't automatically apply to a production workload with different traffic and operational characteristics).

**Consequences:** None for the hackathon build. A note to raise explicitly in any post-hackathon handover conversation with Medic, before assuming the demo's infrastructure choices should ship as-is.
