# Sample patients (fake newborns for testing the built app)

3,456 made-up newborns covering every distinct combination of answers. Each comes with the answer the rules say it should get.

| File | What it is |
|---|---|
| `patients.json` / `patients.csv` | The fake patients, the expected answer, and which rule decided it |
| `reference-logic-model.json` | Rules hand-built from WHO Rec 25, in the team's LogicModel format. A stand-in until the pipeline produces a real approved version |
| `generate-patients.mjs` | Makes the patients from any logic model |
| `evaluate.mjs` | The rule checker shared by both scripts. Plain code, no AI |

## Important (Medic's design rule 6)

In the real pipeline, the expected answers must come from the **clinician-approved** version of the rules, not from this reference file. After approval, run:

```bash
node generate-patients.mjs path/to/approved-snapshot.json
```

The reference version is here so the test box can be built and tested today, before the pipeline is finished.

## How patients are chosen

A rule's answer can only change at the numbers it compares against. So the generator tests each threshold and the values on either side:

- 59, 60, 61 breaths per minute
- 35.4, 35.5, 35.6 and 37.4, 37.5, 37.6 °C
- 23, 24, 25 hours old
- yes and no for every yes/no question

Every rule is reached at least once. The script prints a warning if any rule is never reached, because that would mean the rule can never fire.

## Next use

The test box (Medic's `cht-conf-test-harness`) fills the real compiled CHT form with each patient's answers and checks that the form gives `expected.action`. Field names here match the logic model's input ids. The compiler must use the same ids as form field names, or keep a mapping.
