# Direct source context and artifact storage — November 4 revision

Implements revised design §§8–9 and 14. There is one private versioned SSE-KMS artifact bucket and one retained KMS key. The old second source bucket, Knowledge Base/data sources, S3 Vectors bucket/index, embedding access and synchronization jobs are absent from the current template. Bedrock Guardrails and isolated trusted worker roles remain.

## Source and prompt APIs

- `ArtifactStore`: conditional immutable writes, version/hash/content-type/KMS verification, manifest verification and version listing. ArtifactRef is `{ bucket, key, versionId, sha256, contentType }`; VersionId must be real and non-null.
- `SourcePublisher` (`src/sources.ts`): a trusted human-reviewed source upload. Verify original bytes/hash/origin, enforce pinned commits for CHT docs/reference configs, screen source metadata/text, and write raw source, complete readable text and provenance under `docs/<sourceId>/<version>/`. No chunking, metadata sidecar, indexing or sync job follows publication.
- `PromptContextBuilder` (`src/prompt-context.ts`): trusted pre-inference code selects **one exact guideline** for `drafting`, or **one explicitly curated `cht-primer`** for `change_planner`. It re-reads the pinned provenance/raw/document versions, checks exported text against the original, screens the full input again, persists a complete context receipt and awaits the injected durable DynamoDB audit callback. It returns exact text and references only after audit success.

This is not an agent-facing tool or a search service. Never expose source selection, tenant or source pins as model-controlled arguments. The authenticated workflow selects them. Source text stays stable across requests for the caller's model prompt cache; volatile request IDs and audit metadata are not inserted into that text. The model adapter must put this complete text into its actual prompt and use only that model's supported caching mechanism. This storage module does not claim to enable provider-side prompt caching itself.

Full sources may be up to 1 MiB of UTF-8 text; no text is silently truncated. This is a storage intake ceiling, **not** a guarantee the text fits a model context window or a single Guardrail call. The model/input-screening owners must validate current service/token limits before invocation and fail visibly if the full source cannot be processed. PDF extraction/reading and citation validation remain deterministic/backend or agent integration work; this module accepts prepared md/txt/js text, not arbitrary PDF bytes. Public sources can trigger screening false positives; investigate instead of bypassing screening.

A `cht-primer` is a reviewed, versioned few paragraphs curated for the selected pathway from pinned CHT docs/config. This change does not invent one, transform the existing demo references into an approved primer, or finalize a clinical guideline. Do not publish patient data, credentials, prompts, decisions, golden cases, test fixtures or hosted MCP answers as source material. Full model-call records, screened context receipts and test reports are ordinary audit artifacts under `reports/`, not reference sources.

## Infrastructure

`infra/storage-stack.ts` keeps the logical IDs `Artifacts` and `StorageKey` to retain existing artifact identities. Outputs: `ArtifactBucket`, `KmsKeyArn`, `SourceWriterRoleArn`, `PromptContextWorkerRoleArn`, `ArtifactWorkerRoleArn`, `GuardrailId`, `GuardrailVersion`. No KB/vector IDs are output.

Source writer: `docs/*` publication. Prompt-context worker: versioned `docs/*` reads and `reports/*/context/*` writes. Artifact worker: snapshot/proposal/build/report writes, source reads, and artifact version listing. All use scoped KMS and screening permissions. Agents receive an explicit deny for bucket access and service-role assumption. This stack does not implement Cognito, DynamoDB permissions, Gateway/Cedar, instance profiles or runtime credential isolation. Never share a host service role with agents; offline build containers get staged read-only bytes and no credentials.

```sh
npm ci
npm run check
npm test
npm run synth
# With an existing authorized AWS session and all real agent role names:
npm run preflight
npx cdk bootstrap
npm run deploy -- --parameters AgentRoleNames=intake-role,drafting-role,planner-role
```

Review the synthesized change set before an update to an already deployed stack. Removing a resource from a template can delete the resource/data unless it is retained. No script in this revision automatically deletes existing KB/vector resources, retained source objects or historical evidence. See the revision note for verified live inventory. Creating/attaching the new worker permissions must follow the account's approval rules. Do not deploy arbitrary example role names.

## Optional sample publication

`examples/publish-samples.ts` is an explicit upload example, never run by tests. It uses `ARTIFACT_BUCKET`, `KMS_KEY_ARN`, `GUARDRAIL_ID`, a published numeric `GUARDRAIL_VERSION`, and actual stable `SOURCE_REVIEWER`/`SOURCE_REVIEWED_AT`. It records exact published versions in local ignored `publications.json`. Existing CDC/CHT examples remain only smoke-test candidates. There is no `sync-sources` command. A trusted backend selects full approved input references; it does not query or rank these samples.

Before production enablement, test actual S3/KMS and Guardrail permissions, use real reviewed inputs, confirm full-context model/caching limits and citation fidelity, and prove agents cannot access storage/worker credentials. Root tests use fake SDK responses and CDK assertions, not live AWS access.

## Retention and teardown

Normal stack deletion retains the versioned artifact bucket and KMS key. Export evidence and stop every writer before reviewed destructive cleanup. The opt-in `CONFIRM_DELETE_STACK=BreakingBarriersStorage npm run teardown` purges only the current stack's exact artifact bucket. It leaves the KMS key retained and refuses legacy stack outputs; it never purges a legacy source bucket or schedules a potentially shared/historical key for deletion. Do not run it merely to remove a Knowledge Base, on shared data, or before auditing all resources that use the KMS key. Stack updates cannot erase previous approval evidence. EC2/CHT resources and their volumes are outside this module.

CDK's bundled minimatch advisory remains tracked; no untrusted glob patterns are accepted by the tooling. Model inference/Guardrails remain on Bedrock; AgentCore Gateway/Policy/Identity/Observability remain in the architecture. AgentCore Memory and semantic history search are removed.
