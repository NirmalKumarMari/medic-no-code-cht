// TEMPORARY: pre-fills New change with the newborn example, so a demo needs no
// typing. Before real use, set DEMO_PREFILL to false, or delete this file and the
// example files in assets (who-postnatal-2022-rec25-excerpt.pdf, newborn-test-cases.json).
// Illustrative only: not reviewed by a clinician, and not clinical guidance.
import { exampleDraft } from "@vera/review-model/data/drafts";

export const DEMO_PREFILL = true;

export const PRACTICE_TITLE = "Newborn danger signs at a postnatal visit";
export const PRACTICE_REQUEST =
  "Create a pathway from WHO Recommendation 25 in the attached guideline. A health worker checks a newborn at a postnatal visit. Refer urgently if any danger sign in the recommendation is present, otherwise give home care advice.";
export const PRACTICE_PDF_NAME = "who-postnatal-2022-rec25-excerpt.pdf";
export const PRACTICE_CASES_NAME = "newborn-test-cases.json";
export const practiceDraft = exampleDraft;
