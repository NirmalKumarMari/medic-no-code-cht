# Vera

**No-code CHT configuration for health ministries.** Vera turns a public clinical guideline, or a plain-language change request, into tested, approved [Community Health Toolkit](https://communityhealthtoolkit.org) (CHT) configuration. 

Built for [Medic](https://medic.org) at AWS Breaking Barriers 2026 (Seattle, Open path).

---

## Why Vera exists

The CHT serves 182,000+ community health workers in 24 countries, and eight governments run it as their national platform. Changing it today requires fluency in XLSForm, JSON, JavaScript and CHT conventions, so every change, even a five-minute label fix, waits on a small pool of developers and a full release cycle. Protocol updates can take months to reach health workers.

Changes must also stay safe. In Medic's own audit, a missing pair of brackets would have changed who sees 11 of 24 forms in a national configuration, and every manual check passed. Only running synthetic patients through the build caught it.

**Vera removes the coding requirement without removing a single check or approval.**

## How it works

| # | Step | Who | What happens |
|---|---|---|---|
| 1 | Intake | AI | Turns the request into a structured spec (one non-looping call, no tools) |
| 2 | Draft | AI | Drafts the pathway's logic from the guideline text in its prompt, citing every rule; flags gaps and ambiguities |
| 3 | Logic checks | Code | Missing branches, overlapping conditions, unreachable questions, catch-all rows, ~12 golden cases, and an exact-fingerprint check against past rejected rules |
| 4 | **Content approval** | Clinician | Approves or rejects the exact snapshot (bound to its `snapshotHash`) |
| 5 | Compile | Code | Approved logic becomes XLSForm and `tasks.js`, deterministically |
| 6 | Build and test | Code | Fresh, no-network container runs `cht-conf` and synthetic patients through every branch |
| 7 | **Deploy approval** | IT lead | Reviews the diff, test report and any history flags |
| 8 | Deploy | Code | A separate deployer role uploads with `cht-conf` and verifies the instance |
| | Sync | CHT | Health workers' phones get the update on their next sync |

The cost/over-engineering review on 2026-11-04 (ADR-010 to ADR-013) cut the Cross-Check agent, replaced the Knowledge Base with prompt-stuffing, and folded the history check into the logic checks as deterministic code. See the solution design and `architecture-decisions.md`.

**Edit journey:** a plain-language edit ("add a danger sign that triggers referral") goes to the Change Planner agent, which proposes a structured plan. Code applies it as a new snapshot, which enters at logic checks and goes through every step after it.

**Reject loop:** a clinician rejection creates a new snapshot that re-enters at logic checks. The AI never silently re-guesses.

**Build failures:** if the logic must change, a new `snapshotHash` and a new clinician approval are required. If it's a tooling bug with unchanged logic, the same hash is rebuilt and the existing approval stays valid.

## Design rules

Vera holds all ten of Medic's rules:

1. Models never write compiled configuration; deterministic code compiles approved logic.
2. Every change gets two human approvals: content before build, deploy before upload. Clinical changes need a clinician.
3. AI drafts and hand edits take the same path and the same checks.
4. Approval binds to one exact, versioned snapshot, never to a conversation.
5. The approver's view comes from the same data the compiler reads.
6. Expected outcomes come from the approved logic; a model never judges a test.
7. Ambiguity is flagged for a person, never resolved silently.
8. Synthetic data only; no real patient data or real CHT credentials in a prompt.
9. Nothing generative runs on a health worker's phone.
10. Output is standard CHT configuration that builds with `cht-conf`; every change is reversible.

## Agents

Two real agents, plus the Change Planner for the edit journey. Everything else that touches clinical meaning is deterministic code (ADR-010 to ADR-013).

| Agent | Priority | Job | Model tier | Can never |
|---|---|---|---|---|
| Intake | Must | Request into a `StructuredSpec`; one non-looping call, no tools | Haiku-tier | Compile, upload, approve, retrieve, write memory |
| Drafting / Clinical Review | Must | `LogicModel` with citations and flags; guideline text in the prompt, not retrieved | Haiku-tier, escalates to Sonnet-tier after 2 schema failures | Compile, upload, approve, write config or memory |
| Change Planner | Must (edit journey) | Plain-language edit into a `ChangePlan`; CHT-conventions primer in the prompt | Haiku-tier | Write XLSForm or `tasks.js`, upload, approve |

The **history check is deterministic code, not an agent** (ADR-013): an exact rule-fingerprint lookup folded into the logic checks. The **Cross-Check agent was cut** (ADR-012).

Agents run as **Strands Agents in containers on EC2**. They reach tools only through **AgentCore Gateway**, with **AgentCore Policy (Cedar)** set to deny by default. Approve, deploy, compile, build, test and file-writing tools are never registered on the agent Gateway and are explicitly denied by policy. Intake and Change Planner make one Bedrock call on the happy path plus up to 2 schema-repair attempts before failing to a human.

## Architecture

| Component | Service |
|---|---|
| Orchestrator | AWS Step Functions (standard workflow); task tokens park both approvals |
| Compute | EC2 (Ubuntu, x86_64): t3.xlarge for services and agents, t3.large for the CHT test instance |
| Agents | Strands Agents in Docker containers (not AgentCore Runtime) |
| Agent tools, permissions, identity, tracing | AgentCore Gateway, Policy (Cedar), Identity, Observability |
| Decision history | DynamoDB fingerprints + S3 decision log, written by code only (no AgentCore Memory — ADR-013) |
| Models | Amazon Bedrock via `us.` inference profiles, smallest model per job |
| Input screening | Bedrock Guardrails on drafting and intake inputs |
| Grounding | Guideline text and CHT-conventions primer stuffed into prompts, with caching (no Knowledge Base or vector store — ADR-011) |
| State and audit | DynamoDB (`Changes`, `Approvals`, `Audit`, `Tokens`) + S3 (versioned, SSE-KMS) |
| Build and test | One-off container from pinned `medicmobile/cht-app-ide`, no network, non-root, read-only snapshot |
| Deployer | Separate step and IAM role; the only reader of the CHT login in Secrets Manager, and only after deploy approval |
| Access | Systems Manager Session Manager (no open SSH), Cognito groups for approvers |
| Infrastructure as code | Terraform *(or CDK in TypeScript; see [Tools and why](#tools-and-why))* |

**Not used:** AgentCore Runtime, AgentCore Memory, Bedrock Knowledge Bases, any vector store, Lambda for application logic, Fargate, SageMaker, RDS, model endpoints outside Bedrock, public S3 buckets.

### Grounding (no Knowledge Base)

There is no Bedrock Knowledge Base and no vector store (ADR-011). The guideline text and a short CHT-conventions primer are stuffed directly into the Drafting and Change Planner prompts, with caching. A rule with no citation is flagged.

| Reference material | How | Used by |
|---|---|---|
| Clinical guideline | Full text in the prompt (cached) | Drafting |
| CHT-conventions primer | Curated text in the prompt (cached) | Change Planner |

### Decision history

| Store | Holds | Written by |
|---|---|---|
| DynamoDB + S3 | Exact decision records, rule fingerprints, approvals (source of truth) | Step Functions |

The history check is deterministic code, not an agent (ADR-013): it looks up rule fingerprints in the decision log for exact matches. There is no AgentCore Memory and no AI "similar decision" layer. Its flags are advisory and IT must acknowledge each one at the deploy gate.

## Repository layout

> Planned layout. Update as the code lands.

```
.
├── README.md
├── docs/
│   ├── solution-design.md      # Canonical design (read this first)
│   ├── architecture.png        # Diagram above
│   └── architecture.svg
├── infra/                      # Terraform (or CDK) for every AWS resource
├── statemachine/               # Step Functions definition
├── agents/
│   ├── intake-agent/           # Request -> StructuredSpec (one call, no tools)
│   ├── drafting/               # StructuredSpec -> LogicModel (guideline in prompt)
│   ├── change-planner/         # Plain-language edit -> ChangePlan
│   └── history-check/          # Deterministic exact-fingerprint check (not an agent)
├── services/
│   ├── logic-checks/           # Deterministic validators + golden cases
│   ├── compiler/               # LogicModel -> XLSForm + tasks.js
│   ├── deployer/               # cht-conf upload + verify (separate role)
│   └── review-ui/              # Clinician and IT approval screens
├── build-image/                # Dockerfile from pinned medicmobile/cht-app-ide
├── schemas/                    # StructuredSpec, LogicModel, ChangePlan
└── golden-cases/               # ~12 cases from the guideline, confirmed by Medic
```

## Getting started

### Prerequisites

- An AWS account in `us-west-2` with Bedrock model access
- Terraform 1.x *(or Node.js 22 + CDK 2.x if using CDK)*
- AWS CLI v2 and the Session Manager plugin
- Docker with Compose v2

### Deploy

```bash
# TODO: confirm once infra/ is in place
cd infra
terraform init
terraform apply -var="project=vera"
```

### Open the review UI

```bash
# TODO: fill in instance ID and port from terraform output
aws ssm start-session --target <services-instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["<port>"],"localPortNumber":["<port>"]}'
```

### Run a pathway

1. Upload a public guideline and pick a pathway in the review UI.
2. Review flags, then approve as the clinician.
3. Review the diff, test report and history flags, then approve as the IT lead.

### Tear down

```bash
cd infra
terraform destroy -var="project=vera"
```

This removes everything, including the vector store and retained volumes.

## Testing

All gates are deterministic. No model grades a test.

| Check | When | Proves |
|---|---|---|
| Schema validation | Every model output | Output has the right shape |
| Logic checks | Before content approval | No missing branches, overlaps or unreachable questions |
| Golden cases | Before content approval | Logic matches the guideline's own worked examples |
| `cht-conf` build | After compile | Valid CHT configuration; failure means it never ships |
| Synthetic patients | After build | 100% branch coverage; built form matches the approved logic |
| Deployment check | After upload | CHT instance serves the built app settings |

## Cost

| Item | Value |
|---|---|
| Model cost per pathway run | *TBD* |
| AgentCore cost per run | *TBD* |
| Total spend during the event | *TBD* (budget $500, alerts at $250 and $400) |

Every resource is tagged with the project tag and every model call is tagged by `agent`, `tenant` and `runId`, so Cost Explorer and CloudWatch show cost per run and per agent.

## Well-Architected

| Pillar | Evidence |
|---|---|
| Operational excellence | One-command deploy and teardown; each change traced from request to deploy |
| Security | Least-privilege role per component, Guardrails, deny-by-default agent policy, build and deploy credentials separated, approvals bound to exact versions |
| Reliability | Pending approvals survive a restart (task tokens); build-failure split avoids needless re-approval; rollback to a prior approved snapshot |
| Performance efficiency | Guideline to approved, tested build in minutes; smallest model per job; no open-ended agent loops |
| Cost optimization | Cost per run reported; S3 Vectors instead of a provisioned vector store; instances stopped when idle |
| Sustainability | No model training; compute only while building or testing; phones stay AI-free |

Also reviewed against the AWS Well-Architected **Agentic AI Lens**: bounded autonomy, human-in-the-loop governance, deterministic evaluation, and per-agent cost attribution. Details in [docs/solution-design.md](docs/solution-design.md#18-well-architected-mapping).

## Tools and why

| Tool or service | Why |
|---|---|
| Step Functions | Fixed order the agents can't skip; durable approval waits; visual execution history |
| Strands Agents on EC2 | Portable agent code with no hosting lock-in; matches Medic's containers-on-EC2 direction |
| AgentCore Gateway + Policy | Enforces each agent's tool list outside the agent's own code |
| AgentCore Memory | Lets agents learn from past clinician decisions at production scale |
| Bedrock Knowledge Base + S3 Vectors | Grounds drafts in the guideline with citations; no provisioned vector capacity |
| DynamoDB + S3 | Exact, append-only decision log and audit trail |
| `medicmobile/cht-app-ide` | Medic's own pinned build toolchain, so builds match what Medic runs |
| Terraform | Medic's infrastructure standard |

**Models used:** *TBD (record Bedrock model IDs and versions here).*

## Path to production

- Each ministry is a separate `tenant` in every record, S3 path, KB filter and Memory namespace.
- Decision history is tied to the guideline version; older versions are marked superseded.
- Production sign-in through Cognito or the ministry's identity provider, with roles enforced server-side.
- Models sit behind one interface, so Medic can swap to a cheaper or better model without code changes.
- Output is always standard CHT configuration that ministries can maintain without Vera.

## Open items

See [docs/solution-design.md §20](docs/solution-design.md#20-open-items). The pathway and guideline (working example: child cough and fast breathing) are not yet final.

## Team

Team Vera, AWS Breaking Barriers 2026, Seattle.

## License

[AGPL-3.0](LICENSE), compatible with Medic's open-source tools.
