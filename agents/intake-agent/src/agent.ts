import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";
import {
  IntakeRequestSchema,
  StructuredSpecSchema,
  type IntakeRequest,
  type StructuredSpec,
} from "./schema.js";
import type { Tools } from "./tools.js";

/**
 * Raised whenever the agent cannot produce a valid StructuredSpec after its
 * bounded retries, or when a caller bug makes a run impossible. The caller
 * (server.ts, and eventually the orchestrator) must surface this to a human —
 * this agent never guesses (design rule 7).
 */
export class IntakeAgentError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "IntakeAgentError";
  }
}

function extractText(message: Message | undefined): string {
  return (message?.content ?? [])
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

/** Strips accidental markdown code fences; the model is told not to use them, but models drift. */
function stripCodeFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? raw).trim();
}

export type ConverseFn = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

/** Real implementation, used by server.ts. Tests inject a fake instead. */
export function createBedrockConverse(client = new BedrockRuntimeClient({ region: config.region })): ConverseFn {
  return (input) => client.send(new ConverseCommand(input));
}

/**
 * Intake run (revised Agent Roster, design §7 / ADR-010/011): ONE non-looping
 * Bedrock call, NO tools, plus up to `maxSchemaRepairAttempts` schema-repair
 * retries. The authoritative fields (changeId, requestKind, pathway, guideline,
 * submittedBy, and the edit fields) are copied from the validated request onto
 * the final spec — the model normalizes, it does not get to change identity.
 */
export async function runIntakeAgent(
  rawRequest: unknown,
  tools: Tools,
  converse: ConverseFn,
): Promise<StructuredSpec> {
  const request: IntakeRequest = IntakeRequestSchema.parse(rawRequest);

  // Caller-bug checks (authoring-agents Req 2.4 / 2.7): fail before any model
  // call, these are not ambiguities for the model to flag.
  if (
    (request.requestKind === "guideline_upload" || request.requestKind === "pathway_pick") &&
    (!request.pathway || !request.guideline)
  ) {
    throw new IntakeAgentError(
      `${request.requestKind} requests must include pathway, guideline name, and guideline version`,
    );
  }
  if (
    request.requestKind === "plain_language_edit" &&
    (!request.baselineSnapshotHash || !request.editText)
  ) {
    throw new IntakeAgentError(
      "plain_language_edit requests must include baselineSnapshotHash and editText",
    );
  }

  const messages: Message[] = [
    { role: "user", content: [{ text: buildUserMessage(request) }] },
  ];

  let modelId = config.bedrock.draftModelId;
  let repairAttempts = 0;

  while (true) {
    const response = await converse({
      modelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      inferenceConfig: { temperature: 0, maxTokens: 2048 },
      ...(config.bedrock.guardrailId
        ? {
            guardrailConfig: {
              guardrailIdentifier: config.bedrock.guardrailId,
              guardrailVersion: config.bedrock.guardrailVersion,
              trace: "enabled",
            },
          }
        : {}),
    });

    if (response.stopReason === "guardrail_intervened" || response.stopReason === "content_filtered") {
      throw new IntakeAgentError(
        `Bedrock Guardrails blocked this request (stopReason=${response.stopReason}); surfacing to a human rather than retrying`,
      );
    }

    const assistantMessage = response.output?.message;
    if (assistantMessage) messages.push(assistantMessage);

    const rawText = stripCodeFences(extractText(assistantMessage));
    let parsedJson: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawText);
      parsedJson = typeof parsed === "object" && parsed !== null ? parsed : {};
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    } catch (err) {
      repairAttempts = await repairOrThrow(messages, repairAttempts, `Your response was not a valid JSON object: ${(err as Error).message}`);
      ({ modelId } = maybeEscalate(repairAttempts, modelId));
      continue;
    }

    // Overwrite the identity-bearing fields from the validated request so the
    // model can never change them; it only normalizes free-text understanding.
    const candidate = {
      ...parsedJson,
      changeId: request.changeId,
      requestKind: request.requestKind,
      pathway: request.pathway ?? parsedJson.pathway,
      guideline: request.guideline ?? parsedJson.guideline,
      submittedBy: request.submittedBy,
      ...(request.requestKind === "plain_language_edit"
        ? { baselineSnapshotHash: request.baselineSnapshotHash, editText: request.editText }
        : {}),
    };

    const parsed = StructuredSpecSchema.safeParse(candidate);
    if (!parsed.success) {
      repairAttempts = await repairOrThrow(
        messages,
        repairAttempts,
        `Your JSON did not match the StructuredSpec schema: ${parsed.error.message}`,
      );
      ({ modelId } = maybeEscalate(repairAttempts, modelId));
      continue;
    }

    await tools.writeSpecDraft(parsed.data);
    return parsed.data;
  }
}

async function repairOrThrow(
  messages: Message[],
  repairAttempts: number,
  errorText: string,
): Promise<number> {
  if (repairAttempts >= config.agent.maxSchemaRepairAttempts) {
    throw new IntakeAgentError(
      `Intake agent failed schema validation after ${repairAttempts} repair attempts: ${errorText}`,
    );
  }
  messages.push({
    role: "user",
    content: [{ text: `${errorText}\n\nRespond again with ONLY the corrected JSON object, nothing else.` }],
  });
  return repairAttempts + 1;
}

function maybeEscalate(repairAttempts: number, currentModelId: string): { modelId: string } {
  // Generic schema-repair-then-escalate pattern from the design doc (section 6):
  // retry once on the same model, then escalate to a stronger one before giving up.
  if (repairAttempts >= config.agent.maxSchemaRepairAttempts && config.bedrock.escalationModelId) {
    return { modelId: config.bedrock.escalationModelId };
  }
  return { modelId: currentModelId };
}
