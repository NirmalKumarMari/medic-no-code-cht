import assert from "node:assert/strict";
import { before, test } from "node:test";
import { createApp } from "../src/app.js";
import { DemoSignIn, hashPassword } from "../src/demo-sign-in.js";
import type { ReviewService } from "../src/service.js";

// Sign-in never touches storage, so these tests need no database.
const service = {} as ReviewService;
const origin = "http://localhost:5173";
let accounts: unknown[];

before(async () => {
  accounts = [
    {
      email: "Clinician@vera.test",
      passwordHash: await hashPassword("right-password"),
      groups: ["clinician"],
      tenants: ["workshop"],
    },
  ];
});

function passwordApp(signIn = new DemoSignIn(accounts)) {
  return createApp({
    service,
    authenticate: signIn.authenticate,
    signIn: signIn.signIn,
    mode: "aws",
    origins: [origin],
    authConfig: { mode: "password" },
  });
}
const attempt = (app: ReturnType<typeof passwordApp>, payload: unknown, headers = {}) =>
  app.inject({ method: "POST", url: "/api/auth/sign-in", payload: payload as object, headers });

test("the right password opens a session with that account's role", async () => {
  const app = passwordApp();
  const signedIn = await attempt(app, { email: "clinician@vera.test", password: "right-password" });
  assert.equal(signedIn.statusCode, 200);
  const session = await app.inject({
    url: "/api/session",
    headers: { authorization: `Bearer ${signedIn.json().token}` },
  });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json().groups, ["clinician"]);
  assert.deepEqual(session.json().tenants, ["workshop"]);
  assert.equal(session.json().subject, "clinician-vera.test");
});

test("a wrong password and an unknown email get the same answer", async () => {
  const app = passwordApp();
  const wrong = await attempt(app, { email: "clinician@vera.test", password: "wrong" });
  const unknown = await attempt(app, { email: "nobody@vera.test", password: "right-password" });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(wrong.json(), unknown.json());
});

test("a missing or made-up token is not accepted", async () => {
  const app = passwordApp();
  assert.equal((await app.inject({ url: "/api/session" })).statusCode, 401);
  const madeUp = await app.inject({
    url: "/api/session",
    headers: { authorization: "Bearer made-up" },
  });
  assert.equal(madeUp.statusCode, 401);
});

test("a session stops working after eight hours", async () => {
  let time = 1_000;
  const app = passwordApp(new DemoSignIn(accounts, () => time));
  const { token } = (await attempt(app, { email: "clinician@vera.test", password: "right-password" })).json();
  const headers = { authorization: `Bearer ${token}` };
  time += 8 * 60 * 60 * 1000 - 1;
  assert.equal((await app.inject({ url: "/api/session", headers })).statusCode, 200);
  time += 1;
  assert.equal((await app.inject({ url: "/api/session", headers })).statusCode, 401);
});

test("sign-in rejects other origins and malformed requests", async () => {
  const app = passwordApp();
  const body = { email: "clinician@vera.test", password: "right-password" };
  assert.equal((await attempt(app, body, { origin })).statusCode, 200);
  assert.equal((await attempt(app, body, { origin: "https://elsewhere.example" })).statusCode, 403);
  assert.equal((await attempt(app, { email: "clinician@vera.test" })).statusCode, 400);
});

test("individual reviewers can reach decisions, unlike shared demo access", async () => {
  const blocked = createApp({
    service,
    authenticate: async () => ({ subject: "demo", groups: ["program_officer"], tenants: ["workshop"] }),
    mode: "aws",
    origins: [origin],
    authConfig: { mode: "demo" },
  });
  const url = "/api/reviews/change-1/decisions";
  const shared = await blocked.inject({ method: "POST", url, payload: {} });
  assert.equal(shared.json().code, "DEMO_ONLY");
  const individual = await passwordApp().inject({ method: "POST", url, payload: {} });
  assert.notEqual(individual.json().code, "DEMO_ONLY");
});

test("the sign-in route only exists in password mode", async () => {
  const other = createApp({
    service,
    authenticate: async () => {
      throw Error("not used");
    },
    mode: "aws",
    origins: [origin],
    authConfig: { mode: "demo" },
  });
  const response = await attempt(other, { email: "clinician@vera.test", password: "right-password" });
  assert.equal(response.statusCode, 404);
});

test("bad account settings stop the server starting", () => {
  assert.throws(() => new DemoSignIn([]));
  assert.throws(
    () =>
      new DemoSignIn([
        { email: "a@vera.test", passwordHash: "plain-text", groups: ["clinician"], tenants: ["workshop"] },
      ]),
  );
  assert.throws(
    () =>
      new DemoSignIn([
        { email: "a@vera.test", passwordHash: `${"0".repeat(32)}$${"0".repeat(64)}`, groups: ["admin"], tenants: ["workshop"] },
      ]),
  );
});
