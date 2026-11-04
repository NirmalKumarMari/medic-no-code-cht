import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";
export class GuardrailScreen {
  constructor(
    private runtime: BedrockRuntimeClient,
    private id: string,
    private version: string,
  ) {
    if (!id || !/^[1-9][0-9]*$/.test(version))
      throw Error("Published guardrail version required");
  }
  async screen(text: string): Promise<void> {
    const result = await this.runtime.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: this.id,
        guardrailVersion: this.version,
        source: "INPUT",
        content: [{ text: { text } }],
      }),
    );
    if (result.action !== "NONE") throw Error("Input screening failed closed");
  }
}
