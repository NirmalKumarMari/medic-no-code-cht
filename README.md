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

## Implemented modules

- Root `src/`, `tests/`: artifact storage, reviewed source publication, full prompt-context preparation and screening. [Storage instructions](docs/STORAGE.md), [handoff](docs/HANDOFF.md).
- [infra/](infra/README.md): one CDK app with separate storage and workflow-data stack modules. All infrastructure definitions and CDK dependencies live at the repository root.
- [packages/workflow-data](packages/workflow-data/README.md): four-table runtime repositories, fingerprint history, human decisions and callback recovery. [Status](packages/workflow-data/docs/STATUS.md), [integration contract](packages/workflow-data/docs/INTEGRATION.md).

These are libraries/IaC and an internal callback worker. The UI, Cognito verifier, live state machine, model prompt/cache integration, compiler/harness and CHT deployment adapter must be connected by their owners. Local tests are not proof of a deployed end-to-end clinical workflow. The final pathway, real guideline, clinician-reviewed golden cases and real curated primer remain team decisions. Existing public sample files are optional development fixtures, not finalized clinical inputs.

## Verify locally

Node 22+, npm and Docker are required. From the repository root:

```sh
npm ci
npm run check
npm test
npm run synth
cd packages/workflow-data
npm ci
docker compose up -d
npm run build
npm test
```

Root `npm run synth` generates both templates in `cdk.out/`. Root tests cover both stacks; the workflow package's `synth` command forwards to the same root app for compatibility.

The package's DynamoDB tests use loopback-only synthetic local state. No command above publishes sources, seeds AWS/CHT or invokes models. Source and artifact SDK clients are stubbed in the root tests. See each module's documentation for explicit opt-in deployment. Keep offline build containers credential-free and separate from the deploy role. All resources use the project's AWS `us-west-2` environment and tag conventions.

## Deployment and retention

The four workflow tables were deployed and storage-smoke-verified on November 3 (receipts are in the workflow package). The single `infra/` folder keeps source storage/screens/roles and workflow tables in independently deployable stacks with their original names and logical IDs; live migration status is documented in [the revision note](docs/DATABASE_REVISION_2026-11-04.md). Never apply an old stack template that recreates the removed infrastructure.

Both IaC stacks retain durable stores by default. A stack delete is **not** complete data teardown. Review exports/retention and exact resources before any explicit destructive cleanup. EC2/CHT resources are managed separately from these modules.

## License

[AGPL-3.0](LICENSE), compatible with Medic's open-source tools.
