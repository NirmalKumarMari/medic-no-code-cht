# Vera artifact storage

`@vera/artifact-storage` owns immutable S3 artifacts, reviewed source publication, full guideline/primer prompt context and Bedrock Guardrail screening. [Storage operations](../../docs/STORAGE.md) and [integration handoff](../../docs/HANDOFF.md) describe the trust boundaries and runtime wiring.

## Public API

```ts
import { ArtifactStore, SourcePublisher, PromptContextBuilder, GuardrailScreen } from '@vera/artifact-storage';
import { artifactRefSchema, type ArtifactRef } from '@vera/artifact-storage/contracts';
```

The root export includes the storage helpers, contracts and `sha256`. The lightweight `contracts` subpath exports schemas/types without importing SDK clients. Workflow-data consumes the same `ArtifactRef` schema and re-exports it for compatibility.

| Module | Responsibility |
|---|---|
| `src/artifacts.ts` | Conditional versioned writes, exact-byte/version verification, manifests |
| `src/contracts.ts` | Shared artifact references and reviewed-source/prompt-context contracts |
| `src/sources.ts` | Screen and publish reviewed full-text sources and provenance |
| `src/prompt-context.ts` | Prepare exact full prompt input and await its durable audit callback |
| `src/screening.ts` | Fail-closed screening using a published Bedrock Guardrail version |

## Build and test

From the repository root:

```sh
npm ci
npm run build
npm run check
npm test --workspace @vera/artifact-storage
```

One root lockfile manages both packages. Public imports resolve to `dist/src/`, so build before importing them. Tests in `tests/` use fake AWS SDK clients and read the optional development sample files in root `examples/sources/`; they do not upload files or invoke models. Building emits runtime code/declarations only.

S3/KMS/Guardrail/IAM definitions stay in root `infra/storage-stack.ts`; this package does not provision resources. Run CDK/deployment and explicit sample publication commands from the repository root as described in the storage operations guide.
