import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";

/**
 * Model tier. The drafting agent runs Haiku-tier by default and Step Functions
 * escalates to Sonnet-tier after repeated schema failures (solution design §7).
 * The agent itself is single-attempt; it just takes whichever modelId it is told.
 */
export type ModelTier = "haiku" | "sonnet";

/** Default `us.` cross-region inference profiles (us-west-2). Override via env/config. */
export const DEFAULT_MODEL_IDS: Record<ModelTier, string> = {
  haiku: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
  sonnet: "us.anthropic.claude-sonnet-4-20250514-v1:0",
};

export interface ModelRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelResponse {
  /** Raw text the model returned. */
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Single interface in front of every model call (design: "models behind one
 * interface, so Medic can move to a cheaper or better model without code
 * changes"). Tests inject a fake; production uses BedrockModelClient.
 */
export interface ModelClient {
  readonly modelId: string;
  invoke(req: ModelRequest): Promise<ModelResponse>;
}

export class BedrockModelClient implements ModelClient {
  readonly modelId: string;
  private readonly client: BedrockRuntimeClient;

  constructor(opts: { modelId: string; region?: string; client?: BedrockRuntimeClient }) {
    this.modelId = opts.modelId;
    this.client =
      opts.client ?? new BedrockRuntimeClient({ region: opts.region ?? "us-west-2" });
  }

  async invoke(req: ModelRequest): Promise<ModelResponse> {
    const messages: Message[] = [{ role: "user", content: [{ text: req.user }] }];
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: req.system }],
      messages,
      inferenceConfig: {
        maxTokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0,
      },
    });

    const out = await this.client.send(command);
    const text =
      out.output?.message?.content
        ?.map((block) => ("text" in block ? block.text : ""))
        .join("") ?? "";

    return {
      text,
      inputTokens: out.usage?.inputTokens,
      outputTokens: out.usage?.outputTokens,
    };
  }
}
