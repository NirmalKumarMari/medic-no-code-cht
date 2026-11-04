# Database implementation status — revised November 4, 2026

Yash's workflow persistence implementation is in `packages/workflow-data/` on the `database` branch, alongside the teammate's existing artifact/storage implementation at the repository root. It is added on top of her `b189fc2` commit. The November 4 revision updates both components to the user's new canonical design. This change targets `database` only.

## Deployed and verified

- AWS account: `049197632966`, region `us-west-2`.
- CloudFormation stack: `vera-workflow-data`, status **CREATE_COMPLETE**.
- Stack ARN: `arn:aws:cloudformation:us-west-2:049197632966:stack/vera-workflow-data/6382e720-d7e2-11f1-a9d0-0a666345d565`.
- Four tables: `vera-workflow-Changes`, `vera-workflow-Approvals`, `vera-workflow-Audit`, `vera-workflow-Tokens`.
- Uploaded and locally regenerated CloudFormation template have the same SHA-256: `19298a5452429bc949616ab69963fd858d496544b72433b7f51079e1a6d46796`.
- Live smoke result **PASS**: active/on-demand/encrypted tables; PITR and deletion protection; token cleanup TTL; cross-table atomic write, conditional overwrite rejection and transaction rollback.
- Original downloaded receipts: [AWS smoke result](verification/aws-smoke-result.json), [stack outputs/table ARNs](verification/stack-outputs.json).

Deployment and smoke tests used the existing `WSParticipantRole/Participant` CloudShell session. No API keys or long-lived credentials were generated or saved. No IAM permissions/roles were attached or changed. The AWS smoke was run twice; each run retained one clearly labeled synthetic `PROBE` item in each table (eight small probe items total). These are not live approvals, application `META` rows, tokens or clinical evidence.

## Local implementation verified

Original November 3 checks passed before publication. The November 4 revision adds complete direct prompt-context source verification/auditing and atomic rejected-rule history, removing the KB/vector/ingestion APIs and infrastructure. Current test results are recorded in the root revision note. Local DynamoDB tests remain synthetic and do not prove live model/auth/workflow/CHT integration.

Runtime dependency audit reports zero vulnerabilities. Full development audit still reports CDK's bundled `minimatch` moderate advisory; see the README. This is documented, not hidden by a failed override. The ineffective override was removed.

## Integration still owned by the application components

The account's `us-west-2` Step Functions state-machine list was empty when checked after deployment (observed `2026-11-04 00:06:51 UTC`). Consequently, **real Step Functions callback integration has not been exercised**. The Cognito verifier, state machine, EC2 runtime/service roles, actual build/test harness and CHT deploy adapter are not present in this initial repository checkout and are not implemented by this database package. No clinical approvals or deployments were fabricated to suggest otherwise.

Use [INTEGRATION.md](INTEGRATION.md) for the teammate's exact artifact/prompt-context contract, trusted context construction, callback wiring, component IAM permission boundaries and recovery. Service permissions are proposed there, ready to apply to the application's actual isolated roles once those identities exist. They are not deployed role grants. The callback process is supplied but is not running in AWS without its real tenants/workflow/role configuration.

AgentCore Memory and semantic history are removed. Exact rejected-rule history is implemented in the existing Approvals table and refreshed during Logic Checks/content review. No table/index provisioning change is needed for these materialized key records. Source storage is simplified to one S3 artifact bucket plus screened full-context loading. See the root revision note for live resource inventory and remaining deployment work.

## Files and operations

- `src/`: schemas/hash functions, S3 snapshot verifier, workflow repository, durable callback dispatcher and environment configuration.
- `infra/app.ts`: four-table CDK source; generated template in ignored `.artifacts/`.
- `scripts/dispatch-callbacks.ts`: internal EC2/scheduler callback worker; no HTTP listener.
- `scripts/aws-smoke.ts`: explicit opt-in real AWS storage probe.
- `test/`: synthetic fixtures and current consistency/history checks.
- `.env.example`: table names/tenant/artifact-bucket configuration, no credentials.

The tables are retained and deletion-protected. Their storage/PITR billing persists until deliberately cleaned up by the account owner. The README explains retention/cleanup; no table or cloud data was deleted.
