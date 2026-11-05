import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  WorkflowDataError,
  WorkflowRepository,
  tablesFromEnvironment,
  type Gate,
  type WorkflowContext,
} from "@vera/workflow-data";

/**
 * Small event glue, invoked by a `.waitForTaskToken` state the moment it
 * starts. It opens the approval wait through workflow-data's
 * `openApprovalWait`, the same repository the UI uses to record decisions
 * (`recordDecision`) and the callback dispatcher uses to resume the run.
 * There is exactly one approval path.
 *
 * `openApprovalWait` binds the wait to the exact snapshotHash the workflow
 * checked (design rule 4): it refuses if that hash is no longer the change's
 * current snapshot, if the gate's prerequisites have not passed, or if an
 * ambiguity is open. It never calls SendTaskSuccess/SendTaskFailure itself;
 * only a human decision, delivered by the callback dispatcher, resumes the run.
 */
export interface RequestApprovalEvent {
  taskToken: string;
  changeId: string;
  tenant: string;
  /** The Step Functions execution ARN ($$.Execution.Id); must own the change in workflow-data. */
  executionArn: string;
  gate: Gate;
  /** The snapshotHash the logic checks ran on; the wait is bound to it. */
  snapshotHash: string;
}

/** Refusals the state machine routes to `ApprovalGateRefused` rather than `WorkerUnavailable`. */
export class ApprovalWaitRefused extends Error {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ApprovalWaitRefused";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let repo: WorkflowRepository | undefined;
function repository(): WorkflowRepository {
  repo ??= new WorkflowRepository({
    client: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    tables: tablesFromEnvironment(),
    // Opening a wait never registers an artifact.
    verifySnapshot: async () => {
      throw new Error("The approval-wait Lambda cannot register artifacts");
    },
  });
  return repo;
}

/**
 * Deterministic per task token, so a Lambda retry of the same wait reuses the
 * same Tokens row instead of opening a second one. 32 hex chars fit idSchema.
 */
export function attemptIdFor(taskToken: string): string {
  return createHash("sha256").update(taskToken).digest("hex").slice(0, 32);
}

/** Lambda entrypoint. (Lambda passes its own context as the 2nd argument, so deps are not taken here.) */
export async function handler(event: RequestApprovalEvent): Promise<void> {
  return openWait(event, { repository, now: () => Date.now() });
}

/** The wait logic, with injectable dependencies for tests. */
export async function openWait(
  event: RequestApprovalEvent,
  deps: { repository: () => WorkflowRepository; now: () => number },
): Promise<void> {
  const r = deps.repository();
  const waitSeconds = Number(requireEnv("APPROVAL_WAIT_SECONDS"));
  if (!Number.isInteger(waitSeconds) || waitSeconds <= 0) throw new Error("APPROVAL_WAIT_SECONDS must be a positive integer");
  const ctx: WorkflowContext = { tenantId: event.tenant, executionArn: event.executionArn, actorId: "step-functions" };
  const attemptId = attemptIdFor(event.taskToken);

  let historyFlagIds: string[] | undefined;
  if (event.gate === "deploy") {
    // IT must acknowledge every advisory history flag shown at content review (rejected-rule-check Req 5.4).
    const change = await r.getChange(ctx, event.changeId);
    historyFlagIds = ((change.historyFlags ?? []) as Array<{ id: string }>).map((f) => f.id);
  }

  try {
    await r.openApprovalWait(ctx, {
      changeId: event.changeId,
      snapshotHash: event.snapshotHash,
      gate: event.gate,
      attemptId,
      taskToken: event.taskToken,
      expiresAt: new Date(deps.now() + waitSeconds * 1000).toISOString(),
      ...(event.gate === "deploy" ? { targetId: requireEnv("CHT_TARGET_ID"), historyFlagIds } : {}),
    });
  } catch (err) {
    // A retried invocation for the same token finds its own row already written: that is success.
    const sk = `WAIT#${event.gate}#${event.snapshotHash}#${attemptId}`;
    const existing = await r.read(r.tables.tokens, event.changeId, sk).catch(() => undefined);
    if (existing && existing.taskToken === event.taskToken && existing.executionArn === event.executionArn) return;
    // Matched by name, not instanceof, so it holds even if two copies of the package are loaded.
    if (err instanceof Error && err.name === "WorkflowDataError") {
      throw new ApprovalWaitRefused((err as WorkflowDataError).code, err.message);
    }
    throw err;
  }
}
