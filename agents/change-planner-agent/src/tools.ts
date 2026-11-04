import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BaselineSnapshot, ChangePlan } from "./schema.js";
export interface Tools {
  getBaselineSnapshot(
    ref: { snapshotHash: string },
    changeId: string,
  ): Promise<BaselineSnapshot>;
  /** Must conditionally store an unapproved draft; no current/approved pointer update. */
  writeChangePlanDraft(plan: ChangePlan): Promise<void>;
}
/** Thin AgentCore adapter; no direct S3/DynamoDB/KB access from the agent. */
export async function createGatewayTools(
  env: NodeJS.ProcessEnv = process.env,
  signal: AbortSignal = AbortSignal.timeout(105000),
) {
  const region = env.AWS_REGION ?? "us-west-2";
  const endpoint = new URL(
    env.AGENTCORE_GATEWAY_URL ?? "https://invalid.invalid",
  );
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(
      `.gateway.bedrock-agentcore.${region}.amazonaws.com`,
    ) ||
    endpoint.pathname !== "/mcp" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw Error(
      "Configure an actual regional AgentCore Gateway /mcp endpoint.",
    );
  const names = {
    get: env.GATEWAY_GET_BASELINE_TOOL ?? "",
    write: env.GATEWAY_WRITE_PROPOSAL_TOOL ?? "",
  };
  if (
    !names.get ||
    !names.write ||
    names.get === names.write ||
    Object.values(names).some((n) =>
      /approve|deploy|compile|apply.change|synthetic|write.xls|write.tasks|memory/i.test(
        n,
      ),
    )
  )
    throw Error(
      "Configure two distinct baseline/proposal-draft Gateway tools.",
    );
  if (!env.AGENTCORE_TOKEN_FILE)
    throw Error("Short-lived workload token file is required.");
  const token = (await fs.readFile(env.AGENTCORE_TOKEN_FILE, "utf8")).trim();
  if (!token || /[\r\n]/.test(token))
    throw Error("Invalid workload token file.");
  const client = new Client({ name: "vera-change-planner", version: "0.2.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
        },
      }),
      { timeout: 10000, signal },
    );
  } catch (e) {
    await client.close();
    throw e;
  }
  let calls = 0;
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (++calls > 2)
      throw Error(
        "Change Planner permits one baseline read and one draft write per run.",
      );
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 10000,
      signal,
    });
    if (result.isError)
      throw Error("Gateway operation failed; no direct access fallback.");
    if (result.structuredContent) {
      if (JSON.stringify(result.structuredContent).length > 500000)
        throw Error("Gateway response too large");
      return result.structuredContent;
    }
    if (!Array.isArray(result.content)) throw Error("Invalid Gateway content");
    const text = result.content
      .filter((c): c is { type: "text"; text: string } =>
        Boolean(
          c &&
          typeof c === "object" &&
          c.type === "text" &&
          typeof c.text === "string",
        ),
      )
      .map((c) => c.text)
      .join("");
    if (text.length > 500000) throw Error("Gateway response too large");
    return JSON.parse(text);
  }
  const tools: Tools = {
    async getBaselineSnapshot(ref, changeId) {
      return (await call(names.get, { changeId, ...ref })) as BaselineSnapshot;
    },
    async writeChangePlanDraft(plan) {
      const ack = (await call(names.write, { plan })) as any;
      if (
        ack?.status !== "draft_stored" ||
        ack.snapshotId !== plan.snapshotId ||
        ack.snapshotHash !== plan.snapshotHash
      )
        throw Error("Draft store acknowledgement does not match proposal.");
    },
  };
  return { tools, close: () => client.close() };
}
