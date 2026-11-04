# Sample guideline PDFs (the inputs)

These are what a program officer would upload. The Drafting agent reads one and turns it into a logic model (JSON).

| File | What it is | What should happen |
|---|---|---|
| `1-who-postnatal-2022-full.pdf` | The real WHO guideline Medic gave us (242 pages) | Too big to send whole. Use the excerpt below |
| `1b-who-postnatal-2022-rec25-rec44-excerpt.pdf` | 4 pages: cover, copyright, Rec 25 (newborn danger signs), Rec 44 (visit schedule) | Main demo input. All 16 golden cases must pass |
| `2-format-A-table-protocol.pdf` | Same rules written as a decision table (fictional ministry) | All 16 golden cases must pass |
| `3-format-B-narrative-guidance.pdf` | Same rules written as paragraphs, with reversed wording ("60 or fewer is normal") | All 16 golden cases must pass |
| `4-format-C-checklist-job-aid.pdf` | Same rules as a tick-box checklist ("61 or more", "37.6 °C or higher") | All 16 golden cases must pass |
| `5-format-D-vague-should-be-flagged.pdf` | Deliberately vague: no numbers for "fast breathing", "high fever", "early jaundice", "soon" | The agent must raise ambiguity flags, not invent numbers. Several golden cases should NOT pass, and content approval should be blocked until a person resolves the flags |

Files 2 to 5 are synthetic test documents from made-up ministries, marked on every page. They copy the WHO Rec 25 thresholds so the same answer key works for all of them. They prove the agent handles different government formats, which is what Medic asked for.

What the Drafting agent should find in each of A, B and C:

- 9 referral rules: not feeding well, convulsions, breathing > 60, severe chest in-drawing, no spontaneous movement, temperature > 37.5 °C, temperature < 35.5 °C, jaundice under 24 hours old, yellow palms and soles
- 1 catch-all: no danger signs, routine care
- A flag that referral follow-up timing isn't stated

Licence note: the WHO content is CC BY-NC-SA 3.0 IGO (non-commercial use with attribution is allowed). Each synthetic file carries the attribution.

`text/` has the same documents as plain text. The Drafting agent currently takes text, not PDF, so test 2 uses these.
