# Infrastructure

All CDK definitions live here, with one entry point and one set of CDK dependencies in the repository-root `package.json`.

```text
infra/
├── app.ts                  # Registers both independently deployable stacks
├── storage-stack.ts        # S3, KMS, Bedrock Guardrail and storage worker IAM
└── workflow-data-stack.ts  # Four DynamoDB tables, indexes and protections
```

The stacks retain their existing names, resource logical IDs, table names, outputs and retention settings. Moving the TypeScript files does not move AWS resources between stacks. Runtime workflow repositories remain in `packages/workflow-data/src/`; source/artifact runtime helpers live in `packages/artifact-storage/src/`. Shared runtime contracts are exported by `@vera/artifact-storage/contracts`.

## Commands

Run from the repository root with Node 22+:

```sh
npm ci
npm run check
npm run test:infra
npm run synth
```

The root `test:infra` command checks both stacks; full `npm test` also runs runtime package tests and requires DynamoDB Local (see the root README). Synthesis is local and generates both templates:

- `cdk.out/BreakingBarriersStorage.template.json`
- `cdk.out/vera-workflow-data.template.json`

`npm run synth:storage` and `npm run synth:workflow` select one default stack. The workflow package's existing `npm run synth` forwards to this root app; it requires the root dependencies to be installed.

## Deployment

The stacks have separate deployment lifecycles. With an authorized AWS session, deploy the selected stack explicitly:

```sh
# Storage requires actual existing agent role names, as described in docs/STORAGE.md.
npm run deploy -- --parameters AgentRoleNames=actual-intake-role,actual-drafting-role,actual-planner-role

# Workflow tables only; no storage stack deployment or storage parameters required.
npm run deploy:workflow
```

`npm run deploy` and `npm run destroy` select `BreakingBarriersStorage` explicitly, preserving their original scope. `npm run deploy:workflow` selects `vera-workflow-data`. Do not use example role names for a real deployment. See [storage instructions](../docs/STORAGE.md) and [workflow deployment instructions](../packages/workflow-data/README.md) for permissions, verification and retention details.

Both stacks use `AWS_REGION` (default `us-west-2`) and `CDK_DEFAULT_ACCOUNT` when supplied. `WORKFLOW_TABLE_PREFIX` and `WORKFLOW_STACK_NAME` still override the workflow names. For a custom stack name, use `npm run synth` and `npx cdk deploy <actual-stack-name>`; the convenience commands select the default names. Keep the deployed names and runtime configuration consistent.

The workflow stack remains bootstrap-free. S3 storage retains its existing CDK bootstrap requirements. There are no cross-stack references or added runtime permissions from this consolidation.

This folder consolidation does not deploy or delete cloud resources.
