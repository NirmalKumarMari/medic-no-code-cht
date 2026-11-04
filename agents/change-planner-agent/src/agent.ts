import {
  BedrockRuntimeClient,
  ConverseCommand,
  ApplyGuardrailCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { ulid } from "ulid";
import { config, validateLiveConfig } from "./config.js";
import {
  computeSnapshotHash,
  diffLogic,
  canonicalStringify,
  equal,
  validateReferences,
  sha256,
  LogicModelSchema,
} from "./logicModel.js";
import { SYSTEM_PROMPT, buildMessages } from "./prompt.js";
import { PRIMER_HASH, PRIMER_VERSION } from "./primer.js";
import {
  BaselineSnapshotSchema,
  ChangePlanSchema,
  EditChangeRequestSchema,
  ModelProposalSchema,
  type ChangePlan,
} from "./schema.js";
import type { Tools } from "./tools.js";
export class ChangePlannerAgentError extends Error {
  constructor(
    message: string,
    readonly code = "PLANNER_FAILED",
  ) {
    super(message);
    this.name = "ChangePlannerAgentError";
  }
}
export type ConverseFn = (
  input: ConverseCommandInput,
) => Promise<ConverseCommandOutput>;
export type TraceSink = (event: Record<string, unknown>) => void;
export function createBedrockConverse(
  client = new BedrockRuntimeClient({ region: config.region, maxAttempts: 1 }),
  settings = config,
  trace: TraceSink = () => {},
  signal: AbortSignal = AbortSignal.timeout(105000),
): ConverseFn {
  validateLiveConfig(settings);
  return async (input) => {
    // Screen the COMPLETE input, including reference text and repair messages.
    const screening = await client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: settings.bedrock.guardrailId!,
        guardrailVersion: settings.bedrock.guardrailVersion!,
        source: "INPUT",
        content: [
          {
            text: {
              text: JSON.stringify({
                system: input.system,
                messages: input.messages,
              }),
            },
          },
        ],
      }),
      { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
    );
    const sensitive = screening.assessments?.some(
      (a) =>
        a.sensitiveInformationPolicy?.piiEntities?.length ||
        a.sensitiveInformationPolicy?.regexes?.length,
    );
    trace({
      event: "screening.completed",
      passed: screening.action === "NONE" && !sensitive,
    });
    if (screening.action !== "NONE" || sensitive)
      throw new ChangePlannerAgentError(
        "Input screening blocked or could not verify the complete input.",
        "SCREENING_BLOCKED",
      );
    try {
      const result = await client.send(new ConverseCommand(input), {
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
      });
      trace({
        event: "model.completed",
        modelId: input.modelId,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: result.usage?.cacheWriteInputTokens ?? 0,
      });
      return result;
    } catch (e) {
      trace({ event: "model.failed", modelId: input.modelId });
      throw e;
    }
  };
}
function assertBounds(raw: unknown) {
  const pending: Array<[unknown, number]> = [[raw, 0]];
  let nodes = 0;
  while (pending.length) {
    const [v, d] = pending.pop()!;
    if (d > 40 || ++nodes > 30000)
      throw Error("Document nesting or size limit exceeded.");
    if (v && typeof v === "object")
      for (const child of Object.values(v)) pending.push([child, d + 1]);
  }
}
/** A human rejection of the previous proposal that the re-plan must address. */
export interface PlannerRevision {
  gate: "content" | "deploy";
  /** The reviewer's rejection notes, verbatim. */
  notes: string;
}
export async function runChangePlannerAgent(
  raw: unknown,
  tools: Tools,
  converse: ConverseFn,
  settings = config,
  revision?: PlannerRevision,
): Promise<ChangePlan> {
  const request = EditChangeRequestSchema.parse(raw);
  if (request.requestKind !== "plain_language_edit")
    throw new ChangePlannerAgentError(
      "Only plain_language_edit StructuredSpecs are accepted.",
      "INVALID_REQUEST",
    );
  const record = await tools.getBaselineSnapshot(
    { snapshotHash: request.baselineSnapshotHash! },
    request.changeId,
  );
  assertBounds(record);
  const baseline = BaselineSnapshotSchema.parse(record);
  if (
    baseline.snapshotHash !== request.baselineSnapshotHash ||
    computeSnapshotHash(baseline.hashInputs) !== request.baselineSnapshotHash ||
    !equal(baseline.hashInputs.spec, baseline.logicModel)
  )
    throw new ChangePlannerAgentError(
      "Baseline ID, content or authoritative bundle hash does not match.",
      "STALE_BASELINE",
    );
  if (
    !equal(baseline.logicModel.pathway, request.pathway) ||
    !equal(baseline.logicModel.guideline, request.guideline)
  )
    throw new ChangePlannerAgentError(
      "Request pathway differs from baseline.",
      "INVALID_BASELINE",
    );
  const baselineIssues = validateReferences(baseline.logicModel);
  if (baselineIssues.length)
    throw new ChangePlannerAgentError(
      "Baseline has invalid input references or duplicate IDs.",
      "INVALID_BASELINE",
    );
  if (
    sha256(baseline.plannerContext.text) !== PRIMER_HASH ||
    baseline.plannerContext.source.sourceS3Ref.sha256 !== PRIMER_HASH ||
    baseline.plannerContext.contextHash !==
      sha256(
        JSON.stringify({
          mode: "change_planner",
          source: baseline.plannerContext.source,
          text: baseline.plannerContext.text,
        }),
      )
  )
    throw new ChangePlannerAgentError(
      "Publish the current primer and supply its versioned ArtifactRef.",
      "PRIMER_NOT_PINNED",
    );
  if (
    baseline.guideline &&
    (!baseline.hashInputs.evidenceVersions.some(
      (e) =>
        e.sourceId === baseline.guideline!.sourceId &&
        e.version === baseline.guideline!.version &&
        e.sourceS3Ref.sha256 === baseline.guideline!.sha256,
    ) ||
      sha256(baseline.guideline.text) !== baseline.guideline.sha256)
  )
    throw new ChangePlannerAgentError(
      "Guideline does not match pinned evidence.",
      "INVALID_GROUNDING",
    );
  const messages = buildMessages(
    request,
    baseline,
    settings.bedrock.promptCaching,
    revision,
  );
  const usage: ChangePlan["execution"]["usage"] = [];
  let parsed: ReturnType<typeof ModelProposalSchema.parse> | undefined;
  let lastErrors: string[] = [];
  let modelId = settings.bedrock.draftModelId;
  const totalCalls = 1 + settings.agent.maxSchemaRepairAttempts;
  for (let turn = 0; turn < totalCalls; turn++) {
    // Primary -> same-model repair -> stronger-model final repair. Never a tool loop.
    modelId =
      turn === 2
        ? settings.bedrock.escalationModelId
        : settings.bedrock.draftModelId;
    if (!modelId)
      throw new ChangePlannerAgentError(
        "Escalation model is not configured.",
        "CONFIGURATION",
      );
    const response = await converse({
      modelId,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      inferenceConfig: { temperature: 0, maxTokens: 8192 },
      ...(settings.bedrock.guardrailId
        ? {
            guardrailConfig: {
              guardrailIdentifier: settings.bedrock.guardrailId,
              guardrailVersion: settings.bedrock.guardrailVersion,
            },
          }
        : {}),
    });
    usage.push({
      modelId,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      cacheReadInputTokens: response.usage?.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: response.usage?.cacheWriteInputTokens ?? 0,
    });
    if (
      response.stopReason === "guardrail_intervened" ||
      response.stopReason === "content_filtered"
    )
      throw new ChangePlannerAgentError(
        "Bedrock Guardrails blocked the input/output.",
        "GUARDRAIL_BLOCKED",
      );
    if (response.stopReason !== "end_turn")
      throw new ChangePlannerAgentError(
        "Unexpected or truncated model response.",
        "MODEL_STOP",
      );
    const text = (response.output?.message?.content ?? [])
      .map((b) => b.text ?? "")
      .join("");
    lastErrors = [];
    try {
      if (text.length > 120000) throw Error("Model output exceeds limit.");
      const json: unknown = JSON.parse(text);
      assertBounds(json);
      const candidate = ModelProposalSchema.parse(json);
      const original = (json as { proposedLogicModel: Record<string, unknown> })
        .proposedLogicModel;
      if (
        !equal(
          { ...original, flags: original.flags ?? [] },
          candidate.proposedLogicModel,
        )
      )
        throw Error(
          "Unknown model fields would be discarded; use the shared schema.",
        );
      const issues = validateReferences(candidate.proposedLogicModel);
      if (
        !equal(
          candidate.proposedLogicModel.pathway,
          baseline.logicModel.pathway,
        ) ||
        !equal(
          candidate.proposedLogicModel.guideline ?? null,
          baseline.logicModel.guideline ?? null,
        )
      )
        issues.push("Pathway and guideline metadata must stay unchanged.");
      for (const old of baseline.logicModel.flags)
        if (!candidate.proposedLogicModel.flags.some((f) => equal(f, old)))
          issues.push("Existing flags must be preserved for human resolution.");
      if (issues.length) {
        lastErrors = issues;
        throw Error("Invalid references or protected metadata.");
      }
      parsed = candidate;
      break;
    } catch (e) {
      // Do not return model content or detected personal data in errors/logs.
      if (!lastErrors.length)
        lastErrors = [
          "Output must be JSON matching the requested schema, with no extra keys.",
        ];
      if (turn + 1 < totalCalls)
        messages.push(
          {
            role: "assistant",
            content: [{ text: text.slice(0, 120000) || "(empty response)" }],
          },
          {
            role: "user",
            content: [
              {
                text: JSON.stringify({
                  repair: true,
                  errors: lastErrors,
                  instruction:
                    "Return the complete corrected JSON proposal. Do not change unrelated content.",
                }),
              },
            ],
          },
        );
    }
  }
  if (!parsed)
    throw new ChangePlannerAgentError(
      "Proposal failed validation after the bounded repair attempts. Human clarification is required.",
      "INVALID_MODEL_OUTPUT",
    );
  const snapshotId = ulid();
  const proposed = LogicModelSchema.parse({
    ...parsed.proposedLogicModel,
    snapshotId,
  });
  delete proposed.snapshotHash;
  const flags = [...proposed.flags, ...parsed.flags];
  for (const rule of proposed.rules) {
    const prior = baseline.logicModel.rules.find((r) => r.id === rule.id);
    if (!rule.source?.section && !rule.source?.page)
      flags.push({
        type: "uncited_rule",
        text: `Rule ${rule.id} has no guideline citation.`,
      });
    if (!prior || !equal(prior, rule)) {
      const quote = parsed.citationQuotes.find(
        (q) => q.ruleId === rule.id,
      )?.quote;
      if (
        !baseline.guideline ||
        !quote ||
        !baseline.guideline.text.includes(quote)
      )
        flags.push({
          type: "uncited_rule",
          text: `Rule ${rule.id}: clinical source quote is missing or not present in the supplied guideline; clinician clarification required.`,
        });
    }
  }
  // Flag merge is deterministic and included in the same model that is hashed/reviewed.
  proposed.flags = Array.from(
    new Map(flags.map((f) => [canonicalStringify(f), f])).values(),
  );
  const { operations, riskLevel } = diffLogic(baseline.logicModel, proposed);
  const hashInputs = {
    ...baseline.hashInputs,
    baselineRevision: baseline.snapshotHash,
    spec: JSON.parse(JSON.stringify(proposed)),
    evidenceVersions: [
      ...baseline.hashInputs.evidenceVersions.filter(
        (e) => e.sourceId !== baseline.plannerContext.source.sourceId,
      ),
      {
        sourceId: baseline.plannerContext.source.sourceId,
        version: baseline.plannerContext.source.version,
        sha256: baseline.plannerContext.source.sourceHash,
        sourceS3Ref: baseline.plannerContext.source.sourceS3Ref,
      },
    ],
  };
  hashInputs.retrievalEvidenceRefs = [
    ...hashInputs.retrievalEvidenceRefs.filter(
      (r) => !equal(r, baseline.plannerContext.evidenceRef),
    ),
    baseline.plannerContext.evidenceRef,
  ];
  const snapshotHash = computeSnapshotHash(hashInputs);
  const plan = ChangePlanSchema.parse({
    changeId: request.changeId,
    requestKind: "plain_language_edit",
    snapshotId,
    snapshotHash,
    baselineSnapshotId: baseline.logicModel.snapshotId,
    baselineSnapshotHash: request.baselineSnapshotHash,
    proposedLogicModel: proposed,
    hashInputs,
    operations,
    riskLevel,
    rationale: parsed.rationale,
    flags: proposed.flags,
    status: proposed.flags.length ? "needs_clarification" : "proposed",
    approvalStatus: "unapproved",
    grounding: {
      primerVersion: PRIMER_VERSION,
      primerHash: PRIMER_HASH,
      ...(baseline.guideline
        ? { guidelineHash: baseline.guideline.sha256 }
        : {}),
    },
    execution: {
      modelId,
      modelCalls: usage.length,
      escalated: usage.length === 3,
      usage,
    },
  });
  await tools.writeChangePlanDraft(plan);
  return plan;
}
