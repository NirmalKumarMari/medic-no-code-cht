import { createHash } from "node:crypto";
/** Curated engineering notes, not clinical guidance or a replacement for a guideline. */
export const PRIMER_VERSION = "cht-conventions-2026-11-04.1";
export const PRIMER_SOURCES = [
  {
    id: "cht-tasks",
    url: "https://docs.communityhealthtoolkit.org/building/tasks/tasks-js/",
    reviewedAt: "2026-11-04",
  },
  {
    id: "cht-reference",
    url: "https://github.com/medic/cht-core/blob/ac1d70cb8ea1f5b39c8d78c4ead03bd1814eddf9/config/default/GUIDE.md",
    version: "ac1d70cb8ea1f5b39c8d78c4ead03bd1814eddf9",
  },
];
export const CHT_CONVENTIONS_PRIMER = `CHT engineering primer ${PRIMER_VERSION}:
[cht-tasks] Task definitions distinguish eligibility (appliesIf), resolution (resolvedIf), actions and event timing. A task action identifies its form. Event start and end describe a window around a due date; do not equate start with the number of days until due. Preserve dueInDays and openForDays as separate approved values; the deterministic compiler owns their mapping to CHT event fields.
[cht-reference] Reference applications keep app/contact forms as XLSForm spreadsheets, later converted to XForm XML. A question has a stable name, a type and a label. Changing displayed wording does not require renaming its identifier. Configuration changes require compilation before upload.
Vera rules: represent conditions, actions and follow-up once in the structured logic. Never generate XLSForm, XPath or JavaScript here. Keep IDs and unrelated content unchanged. The compiler, deterministic checks and humans own later gates. These engineering sources do not supply clinical thresholds, referral criteria or treatment advice. Cite clinical rules to the supplied public guideline; flag missing evidence instead of inventing a passage.`;
export const PRIMER_HASH = createHash("sha256")
  .update(CHT_CONVENTIONS_PRIMER)
  .digest("hex");
