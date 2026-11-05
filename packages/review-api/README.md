# Review API

Connects the existing MVP React UI to `@vera/workflow-data` and `@vera/artifact-storage`. It runs as a Node/Fastify service; no AWS credentials are sent to the browser.

## Local preview

From the repository root, with Node 22+ and Docker:

```sh
npm ci
npm run review:local:setup
npm run review:local:api
```

In another terminal at the repository root:

```sh
npm run ui:dev
```

Open http://localhost:5173/. The local API binds to loopback on port 3001; Vite proxies `/api`. It uses four isolated `vera-ui-local-*` tables in DynamoDB Local and content-addressed files under this package's ignored `.local/review-artifacts/` directory. The UI explicitly labels this as local development. The identity is a fixed local program officer, configured by the server, and is never accepted from request headers/body. No AWS resources, clinical approvals or callback tokens are fabricated by local setup.

Use **Fill in an example**, then **Save draft and show flowchart**. Refresh or restart the API to reopen the stored draft. Editing saves a new immutable version; its previous bytes remain retrievable. Requests keep their idempotency IDs across uncertain retries, and concurrent/stale edits fail instead of overwriting a newer version.

`npm run db:local:down` stops/removes the disposable DynamoDB container and its in-memory tables. Local artifact files remain until removed deliberately. Restart the local setup to recreate empty local tables.

## AWS configuration

The repository includes `.env.aws` for this workshop on a developer machine and `.env.ec2.aws` for the EC2 worker. These contain resource identifiers only; AWS credentials come from the SDK profile/instance role. The EC2 profile configuration file is provisioned separately and assumes the scoped worker role using EC2 metadata. `scripts/.env.gateway.aws` contains the EC2 gateway settings. Other environment files remain ignored.

For another deployment, copy `.env.example` to an ignored local file and fill in the real values. From the repository root after `npm run build`:

```sh
node --env-file=packages/review-api/.env packages/review-api/dist/server.js
```

Use an authorized AWS SDK session/EC2 role. The artifact bucket must already be deployed, versioned and configured with the actual KMS key. The published Guardrail version screens submitted draft content and decision notes before persistence. Screening errors stop the operation.

The current default is shared demo access (`REVIEW_AUTH_MODE=demo`), with a fixed server-owned program officer in `REVIEW_DEMO_TENANT`. Storage remains AWS. Individual workflow decisions are disabled in demo mode.

For individual sign-in, set `REVIEW_AUTH_MODE=cognito` and configure a Cognito **public app client without a client secret**, authorization-code grant with PKCE and `openid` scope. Register the exact UI URL, including its trailing slash and any workshop prefix, as both callback and sign-out URL. `COGNITO_DOMAIN` is the HTTPS hosted-login origin. The browser signs in with PKCE and keeps its access token in sessionStorage; the API verifies access-token signature, issuer, client, use and expiry using [AWS JWT Verify](https://github.com/awslabs/aws-jwt-verify). It derives the subject/groups from the verified token and permits only server-configured tenant memberships. The `X-Tenant-Id` header chooses among those memberships and cannot grant access.

Set `REVIEW_ALLOWED_ORIGINS` to the exact trusted UI origins. Serve the UI and `/api` through one HTTPS reverse proxy, or use Session Manager port forwarding. `REVIEW_HOST` defaults to loopback. In workshop Vite mode, `/absproxy/5173/api` is also proxied. AWS mode never falls back to local storage and rejects a DynamoDB endpoint override.

Runtime IAM needs scoped reads/queries and transactional writes on Changes/Audit for authoring drafts, scoped S3 versioned reads/writes and KMS use, and `bedrock:ApplyGuardrail`. The trusted human-decision handler additionally needs the existing transaction permissions on Approvals/Changes/Audit/Tokens documented in workflow-data's integration guide. Agents do not receive this role. No new IAM grants, bucket, table, or CloudFormation resources are deployed by this integration.

## Data and workflow boundary

- Draft bytes: `snapshots/authoring/<tenant>/<changeId>/<requestId>.json` in the artifact store, containing the typed form, deterministic model and checks.
- Changes records: `AUTHORING#META`, `AUTHORING#VERSION#<requestId>`, `AUTHORING#REQUEST#<requestId>`. Only current metadata enters the existing `ReviewInboxIndex` under `<tenant>#authoring`. DynamoDB holds references and compact metadata; full form/model bytes stay in artifacts.
- Audit: a separate `AUTHORING#<tenant>#<changeId>` partition prevents collisions with workflow history. One append-only `authoring.saved` event committed with each new draft revision.
- These are **pre-workflow drafts**, not approved workflow snapshots. They do not create `META` workflow records, approvals, evidence citations, build/test results, invented execution ARNs or task tokens. The authoring `contentHash` is an artifact-integrity hash, not a clinical workflow `snapshotHash`.
- The review queue loads actual `content_review` records from the existing repository. It reads the exact versioned snapshot/report, checks the bundle hash, shows server-side check results and advisory rejection history, and records decisions through `WorkflowRepository.recordDecision`. Existing role separation, hash checks, transactional idempotency and callback recovery apply.
- A successful decision means the decision/outbox transaction committed. The separately supervised callback worker delivers it to the real Step Functions wait. The API never opens artificial waits or sends `SendTaskSuccess` itself.

The prototype's hand-authored form remains deterministic; it is not relabeled as an AI result. Agent invocation and promotion of an authoring draft into `createDraft`/`registerRevision` with real evidence, toolchain identity and workflow execution remain the orchestrator's responsibility. PDF upload, live compiler/build/deployment, workflow revision submission, deployment-review UI, and the full review-UI requirements spec are outside this connection's implemented surface. Unsupported clinical logic is shown as raw data with approval disabled, preserving the existing narrower prototype renderer rather than silently dropping conditions.

## Routes

| Route | Operation |
|---|---|
| `GET /api/auth/config`, `GET /api/session` | Sign-in configuration and verified user/tenants |
| `GET/POST /api/drafts` | List or save authoring drafts |
| `GET/PUT /api/drafts/:changeId` | Load or revise a draft (`revisionId` optionally loads an older version) |
| `GET /api/drafts/:changeId/audit` | Paginated saved activity |
| `GET /api/reviews` | Paginated actual content-review queue |
| `GET /api/reviews/:changeId` | Verified snapshot, checks, report, flags and decisions |
| `POST /api/reviews/:changeId/decisions` | Hash-bound content decision with stable idempotency ID |
| `GET /api/reviews/:changeId/audit` | Paginated workflow activity, allowlisted fields only |

No endpoint exposes Tokens, repository internals, arbitrary table queries, user-chosen S3 references or raw SDK errors. API responses are not cached. Authenticated data is cleared after a 401; errors preserve form entries and do not show an unconfirmed operation as successful.
