import type { PipelineService } from "./pipeline.js";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import {
  idSchema,
  WorkflowDataError,
  type HumanContext,
  type Item,
} from "@vera/workflow-data";
import { HttpError, type Authenticate } from "./auth.js";
import { HistoryService } from "./history.js";
import { DocumentsService } from "./documents.js";
import { ReviewService, draftSummary, safeEvent } from "./service.js";
export interface AppOptions {
  service: ReviewService;
  documents?: DocumentsService;
  history?: HistoryService;
  pipeline?: PipelineService;
  authenticate: Authenticate;
  mode: "local" | "aws";
  origins: string[];
  authConfig: { mode: "local" | "cognito" | "demo"; pipeline?: boolean; domain?: string; clientId?: string };
}
function encode(cursor?: Item) {
  return cursor
    ? Buffer.from(JSON.stringify(cursor)).toString("base64url")
    : undefined;
}
function decode(
  value: unknown,
  tenantId: string,
  partition?: string,
): Item | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 4096)
    throw new HttpError(400, "INVALID_CURSOR", "Invalid page cursor.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some(
        (k) => !["changeId", "sk", "inbox", "inboxSort"].includes(k),
      ) ||
      typeof parsed.changeId !== "string" ||
      typeof parsed.sk !== "string" ||
      (partition && parsed.changeId !== partition) ||
      (parsed.inbox && !String(parsed.inbox).startsWith(`${tenantId}#`))
    )
      throw Error();
    return parsed;
  } catch {
    throw new HttpError(400, "INVALID_CURSOR", "Invalid page cursor.");
  }
}
export function createApp(o: AppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff");
    if (o.authConfig.mode === "demo" && !o.pipeline && request.method !== "GET" && request.url.startsWith("/api/reviews/"))
      throw new HttpError(403, "DEMO_ONLY", "Workflow decisions require an individual signed-in reviewer.");
    const origin = request.headers.origin;
    if (origin && !o.origins.includes(origin))
      throw new HttpError(403, "FORBIDDEN", "This origin is not allowed.");
    if (
      o.mode === "local" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(request.hostname)
    )
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Local mode only accepts loopback hosts.",
      );
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        code: "INVALID_INPUT",
        error: "Check the submitted fields.",
        details: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    if (error instanceof HttpError)
      return reply
        .code(error.status)
        .send({ code: error.code, error: error.message });
    if (error instanceof WorkflowDataError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : ["FORBIDDEN", "SEPARATION_OF_DUTIES", "UNAUTHORIZED"].includes(
                error.code,
              )
            ? 403
            : 409;
      return reply
        .code(status)
        .send({ code: error.code, error: error.message });
    }
    if ((error as { statusCode?: number }).statusCode === 413)
      return reply
        .code(413)
        .send({ code: "TOO_LARGE", error: "The request is too large." });
    if ((error as { statusCode?: number }).statusCode === 400)
      return reply
        .code(400)
        .send({ code: "INVALID_INPUT", error: "Invalid request." });
    // Never serialize SDK errors, credentials, tokens or request bodies.
    return reply.code(503).send({
      code: "STORAGE_UNAVAILABLE",
      error:
        "The service could not confirm this operation. Your changes have not been confirmed; retry the same request.",
    });
  });
  async function context(
    request: Parameters<Authenticate>[0],
  ): Promise<HumanContext> {
    const p = await o.authenticate(request);
    const requested = request.headers["x-tenant-id"];
    const tenantId =
      typeof requested === "string"
        ? requested
        : p.tenants.length === 1
          ? p.tenants[0]
          : undefined;
    if (!tenantId || !p.tenants.includes(tenantId))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Select an organization assigned to your account.",
      );
    idSchema.parse(tenantId);
    return { tenantId, subject: p.subject, groups: p.groups };
  }
  const pathId = (request: { params: unknown }) =>
    idSchema.parse((request.params as any).changeId);
  if (o.pipeline) {
    const pipeline = o.pipeline;
    app.get("/api/pipeline", async (request) => pipeline.list(await context(request)));
    app.post("/api/pipeline", async (request) => pipeline.start(await context(request), request.body));
    app.get("/api/pipeline/:changeId", async (request) => pipeline.read(await context(request), pathId(request)));
    app.post("/api/pipeline/:changeId/release-decision", async (request) => pipeline.decide(await context(request), pathId(request), request.body));
    app.get("/api/pipeline/:changeId/cht-project", async (request, reply) => {
      const bytes = await pipeline.release(await context(request), pathId(request), "cht");
      return reply.type("application/zip").header("Content-Disposition", "attachment; filename=vera-cht-project.zip").send(Buffer.from(bytes));
    });
    app.get("/api/pipeline/:changeId/release", async (request, reply) => {
      const bytes = await pipeline.release(await context(request), pathId(request));
      return reply.type("application/json").header("Content-Disposition", "attachment; filename=vera-preview-release.json").send(Buffer.from(bytes));
    });
  }
  const documents = () => {
    if (!o.documents)
      throw new HttpError(
        503,
        "DOCUMENTS_UNAVAILABLE",
        "Document storage is not configured.",
      );
    return o.documents;
  };
  app.addContentTypeParser(
    "application/pdf",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.get("/api/documents", async (request) => {
    const ctx = await context(request);
    const page = await documents().repository.list(
      ctx,
      decode((request.query as any).cursor, ctx.tenantId),
    );
    return { items: page.items, cursor: encode(page.cursor) };
  });
  app.post(
    "/api/documents/:changeId",
    { bodyLimit: 50 * 1024 * 1024 },
    async (request) => {
      const ctx = await context(request);
      let filename: string;
      try {
        filename = decodeURIComponent(
          String(request.headers["x-filename"] ?? ""),
        );
      } catch {
        throw new HttpError(400, "INVALID_INPUT", "Invalid filename encoding.");
      }
      return documents().upload(
        ctx,
        {
          documentId: pathId(request),
          requestId: request.headers["x-request-id"],
          expectedVersion: request.headers["x-document-version"],
          filename,
        },
        request.body as Buffer,
      );
    },
  );
  app.get("/api/documents/:changeId/versions", async (request) => {
    const ctx = await context(request);
    const id = pathId(request);
    const page = await documents().repository.versions(
      ctx,
      id,
      decode(
        (request.query as any).cursor,
        ctx.tenantId,
        `DOCUMENT#${ctx.tenantId}#${id}`,
      ),
    );
    return { items: page.items, cursor: encode(page.cursor) };
  });
  app.get("/api/documents/:changeId/file", async (request, reply) => {
    const file = await documents().download(
      await context(request),
      pathId(request),
      z
        .string()
        .uuid()
        .optional()
        .parse((request.query as any).revisionId),
    );
    return reply
      .type("application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .send(Buffer.from(file.bytes));
  });
  app.get("/healthz", async () => ({ status: "ok", storage: o.mode }));
  app.get("/api/auth/config", async () => o.authConfig);
  app.get("/api/session", async (request) => {
    const p = await o.authenticate(request);
    return {
      subject: p.subject,
      groups: p.groups,
      tenants: p.tenants,
      storage: o.mode,
    };
  });
  app.get("/api/drafts", async (request) => {
    const ctx = await context(request);
    const page = await o.service.authoring.list(
      ctx,
      decode((request.query as any).cursor, ctx.tenantId),
    );
    return { items: page.items.map(draftSummary), cursor: encode(page.cursor) };
  });
  app.post("/api/drafts", async (request) =>
    o.service.save(await context(request), undefined, request.body),
  );
  app.get("/api/drafts/:changeId", async (request) =>
    o.service.readDraft(
      await context(request),
      pathId(request),
      z
        .string()
        .uuid()
        .optional()
        .parse((request.query as any).revisionId),
    ),
  );
  app.put("/api/drafts/:changeId", async (request) =>
    o.service.save(await context(request), pathId(request), request.body),
  );
  app.get("/api/drafts/:changeId/audit", async (request) => {
    const ctx = await context(request);
    const changeId = pathId(request);
    const page = await o.service.authoring.audit(
      ctx,
      changeId,
      decode(
        (request.query as any).cursor,
        ctx.tenantId,
        `AUTHORING#${ctx.tenantId}#${changeId}`,
      ),
    );
    return { items: page.items.map(safeEvent), cursor: encode(page.cursor) };
  });
  app.get("/api/changes",async request=>{if(!o.history)throw new HttpError(503,"HISTORY_UNAVAILABLE","Change history is not configured.");return o.history.list(await context(request));});
  app.get("/api/changes/:changeId/history",async request=>{if(!o.history)throw new HttpError(503,"HISTORY_UNAVAILABLE","Change history is not configured.");return o.history.read(await context(request),pathId(request));});
  app.get("/api/reviews", async (request) => {
    const ctx = await context(request);
    const page = await o.service.workflow.listInbox(
      ctx,
      "content_review",
      decode((request.query as any).cursor, ctx.tenantId),
    );
    return {
      items: page.items.map((r) => ({
        changeId: r.changeId,
        snapshotHash: r.snapshotHash,
        pathwayId: r.pathwayId,
        state: r.state,
        authorId: r.authorId,
        updatedAt: r.updatedAt,
      })),
      cursor: encode(page.cursor),
    };
  });
  app.get("/api/reviews/:changeId", async (request) =>
    o.service.readReview(await context(request), pathId(request)),
  );
  app.post("/api/reviews/:changeId/decisions", async (request) =>
    o.service.decide(await context(request), pathId(request), request.body),
  );
  app.get("/api/reviews/:changeId/audit", async (request) => {
    const ctx = await context(request);
    const changeId = pathId(request);
    const page = await o.service.workflow.listAudit(
      ctx,
      changeId,
      decode((request.query as any).cursor, ctx.tenantId, changeId),
    );
    return { items: page.items.map(safeEvent), cursor: encode(page.cursor) };
  });
  return app;
}
