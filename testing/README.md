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
