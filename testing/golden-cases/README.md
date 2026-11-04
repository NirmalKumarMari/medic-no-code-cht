# Golden cases (the answer key)

16 example newborns, each with the correct answer taken by hand from WHO Recommendation 25 (PDF page 13, printed page xii).

Demo data. Not reviewed by a clinician.

| File | For |
|---|---|
| `golden-cases-for-review.xlsx` | The Medic rep. One row per case, with columns to mark correct (Y/N) and add notes. The second sheet lists open questions |
| `golden-cases.json` | The code. This goes in the repo at `golden-cases/` |
| `golden-cases.csv` | Same data, for a quick look |
| `check-golden-cases.mjs` | Runs every case through a logic model and prints PASS/FAIL |

## Run the check

Needs Node 22, nothing to install.

```bash
node check-golden-cases.mjs                          # against the reference model
node check-golden-cases.mjs path/to/ai-draft.json    # against what the Drafting agent produced
```

It exits with code 1 if any case fails, so the pipeline can use it as a gate.

## Why the yellow (edge) cases matter

The guideline says "> 60" breaths and "> 37.5 °C". Exactly 60 and exactly 37.5 are not danger signs. If the AI writes "60 or more" instead, G05 and G09 fail before any doctor sees the draft. We tried this, and it caught both mistakes.
