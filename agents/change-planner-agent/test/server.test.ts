import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server.js";
import { ChangePlannerAgentError } from "../src/agent.js";
import { createGatewayTools } from "../src/tools.js";
test("HTTP health and worker authorization", async () => {
  const app = createApp(async (r) => r, "secret");
  try {
    assert.equal((await app.inject("/healthz")).statusCode, 200);
    assert.equal(
      (await app.inject({ method: "POST", url: "/change-plan", payload: {} }))
        .statusCode,
      401,
    );
    const good = await app.inject({
      method: "POST",
      url: "/change-plan",
      headers: { authorization: "Bearer secret" },
      payload: { hello: "world" },
    });
    assert.deepEqual(good.json(), { hello: "world" });
  } finally {
    await app.close();
  }
});
test("HTTP errors are sanitized and oversized bodies never invoke planner", async () => {
  let calls = 0;
  const app = createApp(async () => {
    calls++;
    throw Error("private-token-value");
  });
  try {
    const r = await app.inject({
      method: "POST",
      url: "/change-plan",
      payload: {},
    });
    assert.equal(r.statusCode, 502);
    assert.ok(!r.body.includes("private-token"));
    const large = await app.inject({
      method: "POST",
      url: "/change-plan",
      payload: { text: "x".repeat(20000) },
    });
    assert.equal(large.statusCode, 413);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});
test("HTTP known failure is returned for human review", async () => {
  const app = createApp(async () => {
    throw new ChangePlannerAgentError("detail", "STALE_BASELINE");
  });
  try {
    const r = await app.inject({
      method: "POST",
      url: "/change-plan",
      payload: {},
    });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error, "STALE_BASELINE");
  } finally {
    await app.close();
  }
});
test("Gateway rejects foreign endpoints before token reads or network", async () => {
  await assert.rejects(
    createGatewayTools({ AGENTCORE_GATEWAY_URL: "https://example.com/mcp" }),
  );
});
