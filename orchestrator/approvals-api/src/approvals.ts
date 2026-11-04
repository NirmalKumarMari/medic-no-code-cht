import { ulid } from "ulid";
import type { ApprovalDecisionRequest, ApprovalKind } from "./schema.js";

/**
 * The only module in this codebase that calls SendTaskSuccess. No agent,
 * and no Lambda glue, is allowed anywhere near this (design rule 2: nothing
 * may be approved by anything other than a person, and section 9: "Every
 * human decision is written to the decision log by a Step Functions step,
 * never by an agent" — here that "step" is this API, triggered by a human
 * action, not model output).
 */
export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export interface PendingToken {
  taskToken: string;
  summary: Record<string, unknown>;
}

export interface Deps {
  getPendingToken(changeId: string, kind: ApprovalKind): Promise<PendingToken | undefined>;
  getChangeAuthorId(changeId: string): Promise<string | undefined>;
  getOtherGateApproverId(changeId: string, otherKind: ApprovalKind): Promise<string | undefined>;
  putApprovalRecord(record: ApprovalRecord): Promise<void>;
  putAuditRecord(record: AuditRecord): Promise<void>;
  markTokenCompleted(changeId: string, kind: ApprovalKind): Promise<void>;
  sendTaskSuccess(taskToken: string, outputPayload: Record<string, unknown>): Promise<void>;
}

export interface ApprovalRecord {
  changeId: string;
  kind: ApprovalKind;
  snapshotHash: string | null;
  approverId: string;
  approverRole: string;
  decision: "approved" | "rejected";
  notes: string | null;
  decidedAt: string;
}

export interface AuditRecord {
  changeId: string;
  ulid: string;
  event: string;
  actor: string;
  at: string;
}

export interface CompleteApprovalResult {
  changeId: string;
  kind: ApprovalKind;
  approved: boolean;
}

function otherGate(kind: ApprovalKind): ApprovalKind {
  return kind === "content" ? "deploy" : "content";
}

/** v1 role eligibility. Full risk-based routing (plain wording -> program_reviewer,
 *  clinical/logic -> clinician specifically) is a TODO once that classification exists;
 *  for now any non-IT role may give content approval, and only it_deploy may deploy. */
function assertRoleEligible(kind: ApprovalKind, role: ApprovalDecisionRequest["approverRole"]): void {
  if (kind === "deploy" && role !== "it_deploy") {
    throw new ApprovalError("Deploy approval requires the it_deploy role", 403);
  }
  if (kind === "content" && role === "it_deploy") {
    throw new ApprovalError("it_deploy may not give content approval", 403);
  }
}

export async function completeApproval(
  changeId: string,
  kind: ApprovalKind,
  request: ApprovalDecisionRequest,
  deps: Deps,
): Promise<CompleteApprovalResult> {
  const token = await deps.getPendingToken(changeId, kind);
  if (!token) {
    throw new ApprovalError(`No pending ${kind} approval found for change ${changeId}`, 404);
  }

  assertRoleEligible(kind, request.approverRole);

  // Separation of duties (design doc section 4 / 11): approver != author, approver != other-gate approver.
  const authorId = await deps.getChangeAuthorId(changeId);
  if (authorId && authorId === request.approverId) {
    throw new ApprovalError("The author of a change may not approve it", 403);
  }
  const otherApproverId = await deps.getOtherGateApproverId(changeId, otherGate(kind));
  if (otherApproverId && otherApproverId === request.approverId) {
    throw new ApprovalError("The same person may not approve both the content and deploy gates", 403);
  }

  const approved = request.decision === "approved";
  const decidedAt = new Date().toISOString();
  const snapshotHash = typeof token.summary.snapshotHash === "string" ? token.summary.snapshotHash : null;

  // The SendTaskSuccess payload REPLACES the state machine's current input for
  // every state after this one — it must carry forward everything downstream
  // states need (design rule 4: approval binds to one exact snapshot, never a
  // conversation, so we bind it to the exact summary captured when the wait began).
  await deps.sendTaskSuccess(token.taskToken, {
    ...token.summary,
    // The state machine branches on `decision` ("approve" | "reject"), the same
    // field the workflow-data CallbackPayload uses.
    decision: approved ? "approve" : "reject",
    approved,
    notes: request.notes ?? null,
    approvedBy: request.approverId,
    approvedAt: decidedAt,
  });

  await deps.putApprovalRecord({
    changeId,
    kind,
    snapshotHash,
    approverId: request.approverId,
    approverRole: request.approverRole,
    decision: request.decision,
    notes: request.notes ?? null,
    decidedAt,
  });

  await deps.putAuditRecord({
    changeId,
    ulid: ulid(),
    event: `approval_${kind}_${request.decision}`,
    actor: request.approverId,
    at: decidedAt,
  });

  await deps.markTokenCompleted(changeId, kind);

  return { changeId, kind, approved };
}
