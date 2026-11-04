import { z } from "zod";
import { InputType } from "./logic-model.js";

/**
 * PLACEHOLDER StructuredSpec.
 *
 * The real StructuredSpec is owned by another team member (the Intake agent's
 * output contract). This minimal shape exists only so the Drafting agent can be
 * built and tested against a stable input today. Swap this import for the
 * teammate's schema once it lands — the Drafting agent reads only the fields
 * below, so the surface to reconcile is small.
 */
export const StructuredSpecPlaceholder = z.object({
  specVersion: z.string().default("placeholder/v0"),
  pathway: z.string().min(1),
  guideline: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  requestType: z.enum(["new_pathway", "edit"]).default("new_pathway"),
  /** Normalized, synthesized requirement statements from Intake. */
  requirements: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        /** Raw source text this requirement was synthesized from (for audit). */
        sourceText: z.string().optional(),
      }),
    )
    .default([]),
  /** Obvious data points Intake spotted; Drafting may refine these. */
  candidateInputs: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        type: InputType.optional(),
      }),
    )
    .default([]),
  /** Anything Intake could not resolve; Drafting should carry these forward as flags. */
  openQuestions: z.array(z.string().min(1)).default([]),
});

/**
 * Consumed shape of the StructuredSpec. Declared explicitly (rather than via a
 * bare z.infer) so downstream packages get fully-typed array elements across
 * package boundaries regardless of how Zod infers `.default([])` fields.
 * Kept structurally in sync with StructuredSpecPlaceholder above.
 */
export interface StructuredSpecRequirement {
  id: string;
  text: string;
  sourceText?: string;
}

export interface StructuredSpecCandidateInput {
  id: string;
  label: string;
  type?: InputType;
}

export interface StructuredSpec {
  specVersion: string;
  pathway: string;
  guideline: { name: string; version: string };
  requestType: "new_pathway" | "edit";
  requirements: StructuredSpecRequirement[];
  candidateInputs: StructuredSpecCandidateInput[];
  openQuestions: string[];
}

// Compile-time guarantee the Zod schema's output matches the declared interface.
type _AssertSpecMatches = z.infer<typeof StructuredSpecPlaceholder> extends StructuredSpec
  ? true
  : never;
const _specAssertion: _AssertSpecMatches = true;
void _specAssertion;
