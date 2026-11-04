# Intake Agent

First agent in the pipeline (solution design §6 state 1; agent roster §7).

**Job:** turn one program officer's request — a guideline upload, a pathway pick, or a plain-language edit against an existing snapshot — into a schema-validated `StructuredSpec`. Nothing else. It never drafts clinical logic, never writes configuration, never approves anything.

Per the revised roster (ADR-010/011) it is **one non-looping Bedrock call with no tools**. The guideline is not searched at intake; the agent normalizes the request and copies the authoritative fields (changeId, requestKind, pathway, guideline, submittedBy, and the edit fields) through from the request, so the model cannot change them.

## Run locally

```bash
cp .env.example .env.local
set -a; source .env.local; set +a
npm install   # from the repo root (this is a workspace package)
npm run dev
```

`POST /intake` with a body matching `IntakeRequestSchema` (see `src/schema.ts`):

```json
{
  "changeId": "01JREQUEST000000000000000",
  "requestKind": "guideline_upload",
  "pathway": "child cough and fast breathing",
  "guideline": { "name": "WHO IMCI", "version": "2023" },
  "requestText": "Draft a pathway from the attached WHO IMCI guideline for child cough and fast breathing.",
  "submittedBy": { "role": "program_officer", "userId": "officer-1" }
}
```

Returns the persisted `StructuredSpec` (200) or a structured error (422) that the caller must surface to a human — this agent does not retry past its own bounded limits (one call plus up to 2 schema-repair attempts; see `src/config.ts`).

## Tests

Run from the repo root: `npm test`.

Covers: happy path (one call, request fields win over the model), edit copy-through, schema-repair, exhausted-retries (must never persist a guessed spec), Guardrails intervention (must not retry), and caller-bug cases.

## How this fits the rest of the pipeline

- **Output contract:** `StructuredSpec`, imported from `@vera/schemas` (single source of truth; master is `.kiro/specs/logic-model-snapshots` Requirement 4). The Drafting Agent reads the same type.
- **Side effect:** only an idempotent draft spec-store write (`src/tools.ts`) — no retrieval/KB tool (ADR-011). Implemented today as direct AWS calls (`createDirectTools()`); once AgentCore Gateway exists, swap that one function for a Gateway-backed implementation and `agent.ts` does not change.
- **Storage:** writes the raw spec JSON to S3 (`SPECS_S3_BUCKET`/`SPECS_S3_PREFIX`) and an index row to the `Changes` DynamoDB table (`changeId` PK, `sk = "spec"`) — see design §14.
- **Orchestrator contract:** exposes `POST /intake` so the Step Functions orchestrator can call this container for the "Intake" state.
