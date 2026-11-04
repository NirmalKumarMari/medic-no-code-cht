import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
} from "@aws-sdk/client-bedrock-runtime";

/**
 * Bedrock Guardrails screening on the drafting input (design rule 8, §15):
 * every drafting input is screened for personal data BEFORE it reaches a model.
 * The StructuredSpec and the guideline text are the two entry points for
 * personal data, so both the spec-derived text and the guideline text are
 * screened as INPUT before the drafting model call.
 *
 * Screening sits behind an interface, mirroring ModelClient, so tests inject a
 * fake and production uses BedrockGuardrail. If no guardrail is configured the
 * agent fails closed by default (see DraftingAgent) — screening is not optional
 * for a real run.
 */

export interface GuardrailDecision {
  /** true when the guardrail intervened (blocked / masked) on the content. */
  intervened: boolean;
  /** Short reason(s) for the intervention, for the human-facing flag. */
  reasons: string[];
  /** The (possibly masked) text the guardrail returned, when provided. */
  maskedText?: string;
}

export interface Guardrail {
  /** Screen user-supplied input text before it reaches the model. */
  screenInput(text: string): Promise<GuardrailDecision>;
}

export interface BedrockGuardrailOptions {
  guardrailIdentifier: string;
  guardrailVersion?: string;
  region?: string;
  client?: BedrockRuntimeClient;
}

export class BedrockGuardrail implements Guardrail {
  private readonly client: BedrockRuntimeClient;
  private readonly guardrailIdentifier: string;
  private readonly guardrailVersion: string;

  constructor(opts: BedrockGuardrailOptions) {
    this.guardrailIdentifier = opts.guardrailIdentifier;
    this.guardrailVersion = opts.guardrailVersion ?? "DRAFT";
    this.client =
      opts.client ?? new BedrockRuntimeClient({ region: opts.region ?? "us-west-2" });
  }

  async screenInput(text: string): Promise<GuardrailDecision> {
    const command = new ApplyGuardrailCommand({
      guardrailIdentifier: this.guardrailIdentifier,
      guardrailVersion: this.guardrailVersion,
      source: "INPUT",
      content: [{ text: { text } }],
    });

    const out = await this.client.send(command);
    const intervened = out.action === "GUARDRAIL_INTERVENED";

    const reasons: string[] = [];
    for (const assessment of out.assessments ?? []) {
      for (const pii of assessment.sensitiveInformationPolicy?.piiEntities ?? []) {
        if (pii.type) reasons.push(`pii:${pii.type}`);
      }
      for (const topic of assessment.topicPolicy?.topics ?? []) {
        if (topic.name) reasons.push(`topic:${topic.name}`);
      }
      for (const filter of assessment.contentPolicy?.filters ?? []) {
        if (filter.type) reasons.push(`content:${filter.type}`);
      }
      for (const word of assessment.wordPolicy?.customWords ?? []) {
        if (word.match) reasons.push(`word:${word.match}`);
      }
    }

    const maskedText = out.outputs?.map((o) => o.text ?? "").join("") || undefined;

    return { intervened, reasons, maskedText };
  }
}

/** A pass-through guardrail for tests / local runs with no AWS. Never blocks. */
export class NoopGuardrail implements Guardrail {
  async screenInput(): Promise<GuardrailDecision> {
    return { intervened: false, reasons: [] };
  }
}
