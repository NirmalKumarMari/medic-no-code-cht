# Shared review model

Browser-safe types, deterministic hand-authored model construction, form validation and review checks shared by the React UI and the review API. It imports no AWS SDK or credentials. The prototype's existing module paths re-export these definitions so existing components/tests keep using the same implementation.

The request schema adds server-enforced field/array bounds and rejects unknown fields. The display schema rejects clinical fields and operators the current renderer cannot show; a workflow snapshot with unsupported logic remains readable as raw data with approval disabled. This package is the renderer's supported subset, not a replacement for the broader canonical agent/compiler schema in `@vera/schemas`.

Install/build from the repository root. Root `npm test` includes the prototype's existing deterministic-check suite and the API's database-backed integration tests.
