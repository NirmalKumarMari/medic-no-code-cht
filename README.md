# Vera

No-code CHT configuration for health ministries. AI drafts, deterministic code builds/tests, and humans approve twice.

Source of truth: [FINAL Solution Design](Medic%20Mobile%20-%20FINAL%20Solution%20Design%20%28Open%20Path%29.md), revised November 4, 2026. This supersedes the earlier KB/Memory architecture. The guideline's full extracted text goes directly into Drafting; an explicitly curated CHT-conventions primer goes into Change Planner. There is no Knowledge Base, vector store, embeddings, semantic search, Cross-Check agent or AgentCore Memory in this MVP.

## Pipeline

Intake → Draft → deterministic logic checks (including rejected-rule fingerprints) → content approval → compile/build/test → deploy approval → upload/verify in CHT.

Step Functions drives the workflow; its task tokens park the two human approval gates. Services and agents run in EC2 containers, using Bedrock model inference and Guardrails. AgentCore Gateway, Policy, Identity and Observability remain in the design. No model-invoked evidence search tool is registered. Code loads exact approved source versions before inference. Models never compile, approve or deploy. Clinical changes require a clinician; role/author separation is enforced by trusted backend handlers.

## Storage

| Component | Purpose |
|---|---|
| DynamoDB Changes | Current projection and immutable snapshots, build/test/deploy references |
| DynamoDB Approvals | Human decisions/idempotency receipts and a strongly consistent rejected-rule lookup |
| DynamoDB Audit | Append-only causal history and artifact references |
| DynamoDB Tokens | Private approval callbacks/recovery, excluded from UI/model context |
| One versioned private SSE-KMS S3 bucket | `docs/`, `snapshots/`, `builds/`, `reports/`, `proposals/` |
| CHT's own CouchDB | Synthetic contacts/reports for the separately managed CHT test instance |

Rule history hashes structural `when` + `then` + optional `followUp`, normalizing object keys and conjunction/disjunction order. It matches previous content-rejected snapshots for the same tenant/pathway. Matches are high-severity **advisory** flags on content review. They are not clinical correctness judgments. No LLM or Memory service performs history lookup.

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
| Infrastructure as code | AWS CDK in TypeScript (`infra/`) |

**Not used:** AgentCore Runtime, AgentCore Memory, Bedrock Knowledge Bases, any vector store, Lambda for application logic, Fargate, SageMaker, RDS, model endpoints outside Bedrock, public S3 buckets.

## Implemented modules

- [packages/artifact-storage](packages/artifact-storage/README.md): artifact storage, reviewed source publication, full prompt-context preparation and screening. [Storage instructions](docs/STORAGE.md), [handoff](docs/HANDOFF.md).
- [infra/](infra/README.md): one CDK app with separate storage and workflow-data stack modules. All infrastructure definitions and CDK dependencies live at the repository root.
- [packages/workflow-data](packages/workflow-data/README.md): four-table runtime repositories, fingerprint history, human decisions and callback recovery. [Status](packages/workflow-data/docs/STATUS.md), [integration contract](packages/workflow-data/docs/INTEGRATION.md).

These are libraries/IaC and an internal callback worker. The UI, Cognito verifier, live state machine, model prompt/cache integration, compiler/harness and CHT deployment adapter must be connected by their owners. Local tests are not proof of a deployed end-to-end clinical workflow. The final pathway, real guideline, clinician-reviewed golden cases and real curated primer remain team decisions. Existing public sample files are optional development fixtures, not finalized clinical inputs.

## Verify locally

Node 22+, npm and Docker are required. This is an npm workspace with one root `package-lock.json`. Install once at the repository root:

```sh
npm ci
npm run check
npm run db:local:up
npm test
npm run synth
npm run db:local:down
```

`npm run build` builds artifact-storage first, then workflow-data. `npm run check` builds both and type-checks the packages, infrastructure, examples and scripts. `npm test` builds both and runs infrastructure tests plus both package suites. The DynamoDB tests need the local container started above. `db:local:down` removes that disposable container and its in-memory test data.

Root `npm run synth` generates both templates in `cdk.out/`. Infrastructure tests live in `tests/infra/`; runtime tests live next to each package under `tests/`. The workflow package's `synth` command forwards to the same root app for compatibility.

The DynamoDB tests use loopback-only synthetic local state. These commands do not publish sources, seed AWS/CHT or invoke models. Artifact-storage tests use fake SDK clients. See each module's documentation for explicit opt-in deployment. Keep offline build containers credential-free and separate from the deploy role. All resources use the project's AWS `us-west-2` environment and tag conventions.

## Package imports

```ts
import { ArtifactStore, SourcePublisher, PromptContextBuilder } from '@vera/artifact-storage';
import { artifactRefSchema, type ArtifactRef } from '@vera/artifact-storage/contracts';
import { WorkflowRepository, s3SnapshotVerifier } from '@vera/workflow-data';
```

Imports resolve to built JavaScript/declarations; run `npm run build` before consuming them. The contracts subpath is the shared `ArtifactRef` schema/type and does not import AWS SDK clients. Workflow-data re-exports that contract to preserve its existing public API. Import public package exports rather than another package's source files.

## Deployment and retention

The four workflow tables were deployed and storage-smoke-verified on November 3 (receipts are in the workflow package). The single `infra/` folder keeps source storage/screens/roles and workflow tables in independently deployable stacks with their original names and logical IDs; live migration status is documented in [the revision note](docs/DATABASE_REVISION_2026-11-04.md). Never apply an old stack template that recreates the removed infrastructure.

Both IaC stacks retain durable stores by default. A stack delete is **not** complete data teardown. Review exports/retention and exact resources before any explicit destructive cleanup. EC2/CHT resources are managed separately from these modules.

## License

[AGPL-3.0](LICENSE), compatible with Medic's open-source tools.
