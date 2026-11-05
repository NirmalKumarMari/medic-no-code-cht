import { randomUuid } from "@vera/review-model/data/identity";
import type { CheckResult } from "../data/checks";
import type { RequirementsDraft } from "../types/draft";
import type { LogicModel } from "../types/logic-model";
export interface Session {
  subject: string;
  groups: string[];
  tenants: string[];
  storage: "local" | "aws";
}
export interface AuthConfig {
  mode: "local" | "cognito" | "demo";
  pipeline?: boolean;
  domain?: string;
  clientId?: string;
}
export interface DraftSummary {
  changeId: string;
  title: string;
  authorId: string;
  version: number;
  revisionId: string;
  contentHash: string;
  updatedAt: string;
}
export interface SavedDraft extends DraftSummary {
  kind: "authoring";
  draft: RequirementsDraft;
  model: LogicModel;
  checks: CheckResult[];
}
export interface ReviewSummary {
  changeId: string;
  pathwayId: string;
  snapshotHash: string;
  state: string;
  authorId: string;
}
export interface WorkflowReview {
  kind: "workflow";
  changeId: string;
  model: LogicModel;
  rawSpec: unknown;
  state: string;
  snapshotHash: string;
  authorId: string;
  checks: CheckResult[];
  canRender: boolean;
  canApprove: boolean;
  canReject: boolean;
  decisionReason: string;
  validation: unknown;
  historyFlags: {
    id: string;
    ruleId: string;
    severity: string;
    notesExcerpt: string;
    sourceChangeId: string;
  }[];
  decisions: {
    decisionId: string;
    decision: string;
    actorId: string;
    notes: string;
    createdAt: string;
  }[];
}
export interface Page<T> {
  items: T[];
  cursor?: string;
}
export interface AuditEvent {
  type: string;
  actorId: string;
  createdAt: string;
  version?: number;
  snapshotHash?: string;
}
let tenant = "";
export function setTenant(value: string) {
  tenant = value;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const token = sessionStorage.getItem("vera-access-token");
  let response: Response;
  const persona = sessionStorage.getItem("vera-preview-persona") ?? "program_officer";
  const url = new URL(`${import.meta.env.BASE_URL}api/${path}`, location.origin);
  if (method === "GET" && import.meta.env.BASE_URL === "/vera-preview/") url.searchParams.set("demoPersona", persona);
  try {
    response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(tenant ? { "X-Tenant-Id": tenant } : {}),
        "X-Demo-Persona": persona,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError(
      0,
      "The server did not confirm this operation. Your entries are preserved. Retry to check the same request.",
    );
  }
  const data = await response
    .json()
    .catch(() => ({ error: "The API returned an unreadable response." }));
  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem("vera-access-token");
      window.dispatchEvent(new Event("vera-unauthorized"));
    }
    throw new ApiError(
      response.status,
      [
        data.error ?? "The request failed.",
        ...(data.details ?? []).map(
          (d: { path: string; message: string }) => `${d.path}: ${d.message}`,
        ),
      ].join(" "),
    );
  }
  return data;
}
export function authConfig() {
  return api<AuthConfig>("auth/config");
}
function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function signIn(config: AuthConfig) {
  if (!config.domain || !config.clientId)
    throw Error("Cognito sign-in is not configured.");
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = randomUuid();
  sessionStorage.setItem("vera-pkce", JSON.stringify({ verifier, state }));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const url = new URL("/oauth2/authorize", config.domain);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: `${location.origin}${import.meta.env.BASE_URL}`,
    scope: "openid",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  location.assign(url);
}
export async function completeSignIn(config: AuthConfig) {
  if (config.mode === "demo") {
    sessionStorage.removeItem("vera-access-token");
    sessionStorage.removeItem("vera-pkce");
    const params = new URLSearchParams(location.search);
    if (params.has("code") || params.has("error")) history.replaceState(null, "", import.meta.env.BASE_URL);
    return;
  }
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return;
  const saved = JSON.parse(sessionStorage.getItem("vera-pkce") ?? "null");
  sessionStorage.removeItem("vera-pkce");
  history.replaceState(null, "", import.meta.env.BASE_URL);
  if (
    params.has("error") ||
    !saved ||
    params.get("state") !== saved.state ||
    !config.domain ||
    !config.clientId
  )
    throw Error("Sign-in could not be verified. Start sign-in again.");
  const response = await fetch(new URL("/oauth2/token", config.domain), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: params.get("code")!,
      redirect_uri: `${location.origin}${import.meta.env.BASE_URL}`,
      code_verifier: saved.verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== "string")
    throw Error("Cognito did not complete sign-in. Try again.");
  sessionStorage.setItem("vera-access-token", result.access_token);
}
export function signOut(config: AuthConfig) {
  sessionStorage.removeItem("vera-access-token");
  sessionStorage.removeItem("vera-pkce");
  if (config.domain && config.clientId) {
    const url = new URL("/logout", config.domain);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      logout_uri: `${location.origin}${import.meta.env.BASE_URL}`,
    }).toString();
    location.assign(url);
  } else location.reload();
}

function fileHeaders() {
  const token = sessionStorage.getItem("vera-access-token");
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenant ? { "X-Tenant-Id": tenant } : {}),
  };
}
async function fileError(response: Response): Promise<never> {
  if (response.status === 401) {
    sessionStorage.removeItem("vera-access-token");
    window.dispatchEvent(new Event("vera-unauthorized"));
  }
  const value = await response
    .json()
    .catch(() => ({ error: "The file operation could not be confirmed." }));
  throw new ApiError(
    response.status,
    value.error ?? "The file operation failed.",
  );
}
export async function uploadPdf(input: {
  documentId: string;
  requestId: string;
  expectedVersion: number;
  file: File;
}) {
  const response = await fetch(
    `${import.meta.env.BASE_URL}api/documents/${input.documentId}`,
    {
      method: "POST",
      headers: {
        ...fileHeaders(),
        "Content-Type": "application/pdf",
        "X-Filename": encodeURIComponent(input.file.name),
        "X-Request-Id": input.requestId,
        "X-Document-Version": String(input.expectedVersion),
      },
      body: input.file,
      credentials: "same-origin",
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) return fileError(response);
  return response.json();
}
export async function downloadPdf(
  documentId: string,
  revisionId: string,
  filename: string,
) {
  const response = await fetch(
    `${import.meta.env.BASE_URL}api/documents/${documentId}/file?revisionId=${encodeURIComponent(revisionId)}`,
    {
      headers: fileHeaders(),
      credentials: "same-origin",
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) return fileError(response);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
