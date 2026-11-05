import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Small event glue (explicitly allowed per the design doc's disallow list:
 * "Lambda stays allowed for small event glue only"). This is the one and
 * only way the state machine calls out to a worker container's HTTP
 * endpoint — Intake, Draft, ChangePlan, LogicChecks, Compile, BuildTest,
 * and Deploy are all invoked the same way, through this function.
 *
 * On a non-2xx response this throws, so a Step Functions `Catch` can route
 * the failure — it never swallows a worker error.
 */
export interface InvokeWorkerEvent {
  workerUrl: string;
  body: unknown;
  /**
   * Secrets Manager secret holding the worker's Bearer token (SecretString is
   * the token itself). Only the ARN travels in the execution; the token is
   * read here and never returned or logged.
   */
  authSecretArn?: string;
}

const secrets = new SecretsManagerClient({});
// Short cache so a rotated token is picked up within a few minutes.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map<string, { token: string; expires: number }>();

async function workerToken(secretArn: string): Promise<string> {
  const cached = tokenCache.get(secretArn);
  if (cached && cached.expires > Date.now()) return cached.token;
  const out = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const token = out.SecretString?.trim();
  if (!token) throw new Error("Worker auth secret has no SecretString");
  tokenCache.set(secretArn, { token, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

export async function handler(event: InvokeWorkerEvent): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (event.authSecretArn) headers.authorization = `Bearer ${await workerToken(event.authSecretArn)}`;

  const response = await fetch(event.workerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(event.body ?? {}),
  });

  const text = await response.text();
  let parsedBody: unknown;
  try {
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    parsedBody = text;
  }

  if (!response.ok) {
    // A rejected token may have been rotated: drop it so the next attempt re-reads it.
    if (response.status === 401 && event.authSecretArn) tokenCache.delete(event.authSecretArn);
    const detail = typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody);
    const error = new Error(`Worker at ${event.workerUrl} returned ${response.status}: ${detail}`);
    // 503/429 mean "busy, try again": a distinct error name lets Step Functions
    // retry only these, while every other failure still goes to its Catch.
    if (response.status === 503 || response.status === 429) error.name = "WorkerBusy";
    throw error;
  }

  return parsedBody;
}
