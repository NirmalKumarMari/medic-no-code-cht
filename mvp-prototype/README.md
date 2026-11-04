# Medic No-Code CHT — MVP Prototype

A small, **stubbed, visualize-only** UI prototype for the Medic no-code CHT
solution. It is kept separate from the real system we will build on top of it.

- **No AI and no backend.** The "generate" step (`src/data/stubGenerator.ts`)
  turns the form's answers into a logic model and fakes a short delay.
- The automatic checks (`src/data/checks.ts`) are real, deterministic code, as
  in the design doc: they run on every version, and a problem blocks approval.
- Colours follow Medic's palette from `cht-core`, darkened where needed to meet
  WCAG 2.2 AA contrast.
- Accessibility: labelled fields, an error summary that links to each field,
  keyboard support, focus moved to each new screen, a skip link, and a
  flowchart built from HTML so screen readers can read it.

## The flow

1. **Describe the change.** Pathway and guideline, the questions the health
   worker answers, the rules (checked top to bottom, first match wins), and
   what happens if no rule matches. Required fields are marked `*`.
   **Fill in an example** loads an illustrative child cough and fast breathing
   pathway. It is not clinical guidance.
2. **Generate.** The stub builds a versioned logic model.
3. **Review.** Automatic checks, then the logic as a flowchart or a decision
   table. **Approve**, or **Reject and edit** (a note is required). Each
   regeneration is a new version.
4. **Approved.** A confirmation, the approved logic, and the steps that would
   follow in the full system.

## Run it

Requires Node 18 or later (developed on Node 24).

```bash
cd mvp-prototype
npm install
npm run dev          # http://localhost:5173/
```

In the workshop environment, where the app is reached through the CloudFront
proxy, run `npm run dev:proxy` instead and open
`https://<your-cloudfront-host>/absproxy/5173/` (keep the trailing slash).

```bash
npm run build        # type-check and production build into dist/
npm run preview      # serve the production build
```

## Code map

| Path | What it is |
| --- | --- |
| `src/types/logic-model.ts` | The logic model (design doc section 10) |
| `src/types/draft.ts` | What the form edits |
| `src/data/stubGenerator.ts` | Stubbed drafting step: form answers to logic model |
| `src/data/checks.ts` | Deterministic logic checks |
| `src/data/validate.ts` | Form validation messages |
| `src/data/drafts.ts` | Empty drafts and the example pathway |
| `src/components/` | Screens and UI pieces |
