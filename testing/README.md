# Vera testing data: newborn danger signs

Pathway: newborn danger signs at a postnatal visit. Source: WHO postnatal care 2022, Recommendation 25 (with Rec 44 for the visit schedule).

| Folder | What | Who uses it |
|---|---|---|
| `sample-pdfs/` | Inputs: the WHO guideline plus 4 test versions in different government formats | Drafting agent |
| `golden-cases/` | Answer key: 16 hand-written cases + a checker script | Logic checks (before clinician approval) |
| `sample-patients/` | 3,456 fake newborns + a generator script | Build/test box (after compiling) |

Quick check (Node 22, no install):

```bash
node golden-cases/check-golden-cases.mjs            # 16/16 pass against the reference model
node sample-patients/generate-patients.mjs          # regenerates the patients
```

## Next steps

1. Get the Medic rep to confirm `golden-cases/golden-cases-for-review.xlsx` and answer the open questions.
2. Tell the team the pathway changed from child cough to newborn danger signs, and share this folder.
3. Put this in the repo: `golden-cases/` at the root, the PDFs under `guidelines/`, and the scripts in a shared testing package.
4. Run the Drafting agent on `1b`, `2`, `3`, `4` and `5`, then run `check-golden-cases.mjs` on each output.
5. Build the test box: `medicmobile/cht-app-ide` + `cht-conf-test-harness`, starting from Medic's `cht-core/config/default` tests.
6. When the compiler exists, feed `patients.json` through the built form and compare against `expected.action`.
