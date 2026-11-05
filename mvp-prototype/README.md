# Vera authoring and content review UI

The existing structured prototype is connected to the review API and storage packages. It saves hand-authored drafts, restores them after refresh, saves immutable revisions, shows activity and opens the real content-review queue. Flowchart/table/checks still come from the same deterministic model. The browser carries no AWS credentials and has no direct database/S3 access.

## Local preview

Requires Node 22+ and Docker. Install from the repository root using the shared lockfile:

```sh
npm ci
npm run review:local:setup
npm run review:local:api
```

In another terminal at the repository root:

```sh
npm run ui:dev
```

Open http://127.0.0.1:5173/. The local API runs on loopback port 3001. **Fill in an example** supplies an illustrative synthetic pathway; choose **Save draft and show flowchart**, refresh and reopen it, then edit/save version 2. The local banner names DynamoDB Local and local files explicitly. No AWS records or fabricated clinical approvals are created. `npm run db:local:down` removes the disposable in-memory local database when finished.

## AWS connection

Configure/start `@vera/review-api` with its real bucket/KMS/Guardrail, Cognito public-client PKCE settings and server-owned tenant memberships. See [API configuration and routes](../packages/review-api/README.md). Serve the static UI and `/api` on one HTTPS origin through the existing EC2/reverse proxy setup, or use Session Manager forwarding. All infrastructure remains in root `infra/`; this change deploys nothing.

For the workshop's CloudFront proxy, run `npm run dev:proxy --workspace @vera/review-ui` from the root and open `https://<your-cloudfront-host>/absproxy/5173/`. The API's allowed origins and Cognito callback/sign-out URLs must match that exact browser origin/path. Vite proxies both `/api` and the workshop-prefixed API path to port 3001.

## Review behavior

- Authoring drafts are stored before pipeline registration. Their integrity hash verifies file bytes; it is distinct from the workflow snapshot hash.
- Only actual `content_review` workflows expose decision controls, with the existing server-side identity/role/author separation, exact hash binding and idempotent decision/outbox transaction.
- Stored validation reports, history flags and decisions come from the backend. Conditions/actions unsupported by this narrower renderer keep approval disabled and show raw snapshot data instead.
- Saving or deciding shows success only after the server confirms persistence. Failures preserve the form/note and retries reuse the request ID. A 401 clears the authenticated view.
- AI invocation, promotion into a workflow with real evidence/execution/toolchain identity, build/test, deployment review and live CHT deployment remain with their component owners. This connection does not invent those integrations or present preview checks as clinical build evidence.

## Checks

From the root:

```sh
npm run check
npm test  # DynamoDB Local must be running
```

`npm run build` also creates the production UI in `mvp-prototype/dist/`. The prototype's existing deterministic-check suite remains under `test/`; database-backed API tests live in `packages/review-api/tests/`. Browser-safe model/check/form code now lives in `packages/review-model/`, with the old `src/data/` and `src/types/` paths re-exporting it for component compatibility.
