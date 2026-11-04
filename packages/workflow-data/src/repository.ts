import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { artifactRefSchema, canonicalJson, digestSchema, hasRole, idSchema, requireData, safeDecision, sha256, snapshotBundleSchema, snapshotHash, validateContext,
  WorkflowDataError, type ArtifactRef, type Change, type DecisionInput, type Gate, type HumanContext, type Item, type SnapshotBundle, type Tables, type TestSummary, type WorkflowContext } from './model.js';
import { fingerprintRules, type HistoryFlag, type RuleFingerprint } from './fingerprints.js';
import type { SnapshotVerifier } from './snapshot-verifier.js';

type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export interface RepositoryOptions {
  client: DynamoDBDocumentClient; tables: Tables; verifySnapshot: SnapshotVerifier;
  now?: () => Date;
}
export interface DraftInput {
  changeId: string; pathwayId: string; snapshotId: string;
  executionArn: string; bundle: SnapshotBundle; artifact: ArtifactRef;
}
const clean = (v: Item): Item => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));

export class WorkflowRepository {
  readonly client: DynamoDBDocumentClient;
  readonly tables: Tables;
  readonly clock: () => Date;
  private readonly verifySnapshot: SnapshotVerifier;
  constructor(options: RepositoryOptions) {
    this.client = options.client; this.tables = options.tables;
    this.clock = options.now ?? (() => new Date()); this.verifySnapshot = options.verifySnapshot;
    requireData(typeof this.verifySnapshot === 'function', 'CONFIGURATION', 'A real snapshot artifact verifier is required');
  }
  stamp(): string { return this.clock().toISOString(); }
  async read(table: string, changeId: string, sk: string): Promise<Item | undefined> {
    return (await this.client.send(new GetCommand({ TableName: table, Key: { changeId, sk }, ConsistentRead: true }))).Item;
  }
  async getChange(ctx: { tenantId: string }, changeId: string): Promise<Change> {
    idSchema.parse(ctx.tenantId); idSchema.parse(changeId);
    const row = await this.read(this.tables.changes, changeId, 'META');
    requireData(row && row.tenantId === ctx.tenantId, 'NOT_FOUND', 'Change does not exist in this tenant');
    return row as Change;
  }
  private worker(ctx: WorkflowContext, row: Change): void {
    validateContext(ctx);
    requireData(ctx.tenantId === row.tenantId && ctx.executionArn === row.executionArn, 'STALE_EXECUTION', 'Workflow execution no longer owns this snapshot');
  }
  private expected(row: Change, hash: string): void {
    digestSchema.parse(hash);
    requireData(row.snapshotHash === hash, 'STALE_SNAPSHOT', 'Snapshot is no longer current');
  }
  private insert(table: string, item: Item): Write {
    return { Put: { TableName: table, Item: clean(item), ConditionExpression: 'attribute_not_exists(changeId) AND attribute_not_exists(sk)' } };
  }
  private metaUpdate(row: Change, patch: Item, remove: string[] = []): Write {
    const values: Item = { ':oldVersion': row.version, ':oldHash': row.snapshotHash, ':tenant': row.tenantId };
    const names: Record<string, string> = { '#version': 'version' };
    const next = clean({ ...patch, version: row.version + 1, updatedAt: this.stamp() });
    if (patch.state) { next.inbox = `${row.tenantId}#${patch.state}`; next.inboxSort = `${this.stamp()}#${row.changeId}`; }
    const sets = Object.entries(next).map(([k, v], i) => { names[`#s${i}`] = k; values[`:v${i}`] = v; return `#s${i} = :v${i}`; });
    const removals = remove.filter(k => !(k in next)).map((k, i) => { names[`#r${i}`] = k; return `#r${i}`; });
    return { Update: { TableName: this.tables.changes, Key: { changeId: row.changeId, sk: 'META' },
      UpdateExpression: `SET ${sets.join(', ')}${removals.length ? ` REMOVE ${removals.join(', ')}` : ''}`,
      ConditionExpression: '#version = :oldVersion AND snapshotHash = :oldHash AND tenantId = :tenant',
      ExpressionAttributeNames: names, ExpressionAttributeValues: values } };
  }
  private event(row: Pick<Change, 'changeId' | 'tenantId' | 'snapshotHash'> & { executionArn?: string; snapshotId?: string }, type: string, actorId: string, details: Item = {}): Write {
    const time = this.stamp(); const eventId = randomUUID();
    return this.insert(this.tables.audit, { changeId: row.changeId, sk: `${time}#${eventId}`,
      tenantId: row.tenantId, eventId, type, actorId, snapshotHash: row.snapshotHash, snapshotId: row.snapshotId, executionArn: row.executionArn, createdAt: time, ...details });
  }
  async commit(items: Write[]): Promise<void> {
    try { await this.client.send(new TransactWriteCommand({ TransactItems: items })); }
    catch (error) {
      if ((error as Error).name === 'TransactionCanceledException') throw new WorkflowDataError('CONFLICT', 'Concurrent or duplicate write; refresh the exact current version');
      throw error;
    }
  }
  async createDraft(ctx: HumanContext, input: DraftInput): Promise<Change> {
    hasRole(ctx, ['program_officer']);
    for (const v of [input.changeId, input.pathwayId, input.snapshotId]) idSchema.parse(v);
    validateContext({ tenantId: ctx.tenantId, executionArn: input.executionArn, actorId: 'workflow' });
    const bundle = snapshotBundleSchema.parse(input.bundle); const artifact = artifactRefSchema.parse(input.artifact);
    await this.verifySnapshot(artifact, bundle);
    const hash = snapshotHash(bundle); const rules = fingerprintRules(bundle.spec); const stamp = this.stamp();
    const row: Change = { changeId: input.changeId, sk: 'META', tenantId: ctx.tenantId,
      pathwayId: input.pathwayId, authorId: ctx.subject, snapshotId: input.snapshotId, snapshotHash: hash,
      executionArn: input.executionArn, state: 'draft', version: 1, buildKind: 'release', createdAt: stamp, updatedAt: stamp,
      artifact, baselineRevision: bundle.baselineRevision, schemaVersion: bundle.schemaVersion,
      inbox: `${ctx.tenantId}#draft`, inboxSort: `${stamp}#${input.changeId}` };
    const snapshot = { ...row, sk: `SNAPSHOT#${input.snapshotId}`, bundleHash: hash, compilerVersion: bundle.compilerVersion,
      toolchainImageDigest: bundle.toolchainImageDigest, goldenCaseVersion: bundle.goldenCaseVersion, evidenceVersions: bundle.evidenceVersions, retrievalEvidenceRefs: bundle.retrievalEvidenceRefs, ruleFingerprints: rules };
    await this.commit([this.insert(this.tables.changes, row), this.insert(this.tables.changes, snapshot), this.event(row, 'snapshot.created', ctx.subject, { artifact, executionArn: input.executionArn })]);
    return row;
  }
  async registerRevision(ctx: HumanContext, input: DraftInput & { expectedHash: string }): Promise<Change> {
    hasRole(ctx, ['program_officer', 'clinician', 'program_reviewer']);
    const row = await this.getChange(ctx, input.changeId); this.expected(row, input.expectedHash);
    requireData(!row.callbackPending && row.state !== 'deploying', 'BUSY', 'Finish callback delivery/deployment before replacing the active snapshot');
    idSchema.parse(input.snapshotId); idSchema.parse(input.pathwayId);
    requireData(row.pathwayId === input.pathwayId, 'INVALID_REVISION', 'A revision cannot change the pathway');
    validateContext({ tenantId: ctx.tenantId, executionArn: input.executionArn, actorId: 'workflow' });
    const bundle = snapshotBundleSchema.parse(input.bundle); const artifact = artifactRefSchema.parse(input.artifact);
    await this.verifySnapshot(artifact, bundle); const hash = snapshotHash(bundle); const rules = fingerprintRules(bundle.spec);
    requireData(hash !== row.snapshotHash, 'UNCHANGED_SNAPSHOT', 'Identical bundle is a retry, not a new approved version');
    const patch = { snapshotId: input.snapshotId, snapshotHash: hash, authorId: ctx.subject, artifact,
      baselineRevision: bundle.baselineRevision, executionArn: input.executionArn, state: 'draft' };
    const writes = [this.metaUpdate(row, patch, ['contentDecisionKey', 'deployDecisionKey', 'activeWaitSk', 'latestBuildId', 'latestTestId', 'callbackPending', 'requiresClinician', 'openAmbiguities', 'validationReport', 'historyFlags']),
      this.insert(this.tables.changes, { changeId: row.changeId, sk: `SNAPSHOT#${input.snapshotId}`, tenantId: row.tenantId,
        snapshotId: input.snapshotId, snapshotHash: hash, parentSnapshotHash: row.snapshotHash, authorId: ctx.subject,
        artifact, compilerVersion: bundle.compilerVersion, toolchainImageDigest: bundle.toolchainImageDigest,
        goldenCaseVersion: bundle.goldenCaseVersion, evidenceVersions: bundle.evidenceVersions, retrievalEvidenceRefs: bundle.retrievalEvidenceRefs, ruleFingerprints: rules, createdAt: this.stamp() }),
      this.event({ ...row, snapshotHash: hash }, 'snapshot.revised', ctx.subject, { parentSnapshotHash: row.snapshotHash, artifact })];
    if (row.activeWaitSk) writes.push({ Update: { TableName: this.tables.tokens, Key: { changeId: row.changeId, sk: row.activeWaitSk },
      UpdateExpression: 'SET #status = :superseded REMOVE taskToken, callbackQueue, callbackDueAt',
      ConditionExpression: '#status = :pending', ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':superseded': 'superseded', ':pending': 'pending' } } });
    await this.commit(writes); return this.getChange(ctx, row.changeId);
  }
  async getSnapshot(ctx: { tenantId: string }, changeId: string, snapshotId: string): Promise<Item> {
    await this.getChange(ctx, changeId); idSchema.parse(snapshotId);
    const row = await this.read(this.tables.changes, changeId, `SNAPSHOT#${snapshotId}`);
    requireData(row?.tenantId === ctx.tenantId, 'NOT_FOUND', 'Snapshot not found'); return row;
  }
  /** Strongly consistent materialized index in Approvals; tenant + pathway scoped. */
  async checkRuleHistory(ctx: WorkflowContext, changeId: string, hash: string): Promise<HistoryFlag[]> {
    const row = await this.getChange(ctx, changeId); this.worker(ctx, row); this.expected(row, hash);
    const snapshot = await this.getSnapshot(ctx, changeId, row.snapshotId);
    const flags: HistoryFlag[] = [];
    for (const rule of (snapshot.ruleFingerprints ?? []) as RuleFingerprint[]) {
      const historyKey = `HISTORY#${ctx.tenantId}#${row.pathwayId}#${rule.fingerprint}`;
      const result = await this.client.send(new QueryCommand({ TableName: this.tables.approvals, ConsistentRead: true, KeyConditionExpression: 'changeId = :key', ExpressionAttributeValues: { ':key': historyKey }, ScanIndexForward: false, Limit: 1 }));
      for (const prior of result.Items ?? []) {
        requireData(prior.tenantId === ctx.tenantId && prior.pathwayId === row.pathwayId && prior.fingerprint === rule.fingerprint && prior.decision === 'reject' && prior.gate === 'content', 'INTEGRITY_ERROR', 'Invalid rejection index entry');
        flags.push({ id: `history-${sha256(`${rule.ruleId}#${prior.sourceChangeId}#${prior.decisionId}`).slice(0, 32)}`,
          type: 'previously_rejected_rule', severity: 'high', advisory: true, ruleId: rule.ruleId, fingerprint: rule.fingerprint,
          sourceChangeId: prior.sourceChangeId, decisionId: prior.decisionId, rejectedSnapshotHash: prior.snapshotHash, rejectedSnapshotId: prior.snapshotId, notesExcerpt: String(prior.notes).slice(0, 320), createdAt: prior.createdAt });
      }
    }
    return flags;
  }
  async recordValidation(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; passed: boolean; openAmbiguities: number; requiresClinician: boolean; report: ArtifactRef }): Promise<void> {
    const row = await this.getChange(ctx, input.changeId); this.worker(ctx, row); this.expected(row, input.snapshotHash);
    requireData(['draft', 'draft_failed', 'checked'].includes(row.state), 'INVALID_STATE', 'Validation cannot replace approved/build evidence');
    requireData(Number.isInteger(input.openAmbiguities) && input.openAmbiguities >= 0, 'INVALID_VALIDATION', 'Ambiguity count must be a non-negative integer');
    requireData(typeof input.requiresClinician === 'boolean' && typeof input.passed === 'boolean', 'INVALID_VALIDATION', 'Validation and risk routing must be explicit booleans');
    const report = artifactRefSchema.parse(input.report); const passed = input.passed && input.openAmbiguities === 0;
    const snapshot = await this.getSnapshot(ctx, row.changeId, row.snapshotId);
    requireData(!passed || !input.requiresClinician || snapshot.ruleFingerprints?.length > 0, 'MISSING_RULES', 'A clinical snapshot must contain explicit rules before successful validation/history checking');
    const historyFlags = await this.checkRuleHistory(ctx, row.changeId, row.snapshotHash);
    await this.commit([this.metaUpdate(row, { state: passed ? 'checked' : 'draft_failed', requiresClinician: input.requiresClinician,
      openAmbiguities: input.openAmbiguities, validationReport: report, historyFlags }),
      this.event(row, 'validation.recorded', ctx.actorId, { passed, openAmbiguities: input.openAmbiguities, report, historyFlagIds: historyFlags.map(f => f.id) })]);
  }
  /** Adapter for the trusted prompt-context builder's awaited audit callback. */
  async recordPromptContext(ctx: WorkflowContext, input: { changeId: string; snapshotId: string; requestId: string; contextHash: string; evidenceRef: ArtifactRef }): Promise<void> {
    const row = await this.getChange(ctx, input.changeId); this.worker(ctx, row);
    idSchema.parse(input.snapshotId); idSchema.parse(input.requestId); digestSchema.parse(input.contextHash);
    requireData(row.snapshotId === input.snapshotId && ['draft', 'draft_failed'].includes(row.state), 'STALE_SNAPSHOT', 'Prompt context must belong to the current unapproved draft');
    const evidenceRef = artifactRefSchema.parse(input.evidenceRef);
    requireData(evidenceRef.key === `reports/${row.changeId}/context/${input.snapshotId}/${input.requestId}.json`, 'INVALID_ARTIFACT', 'Prompt context receipt path does not match its causal identifiers');
    const sk = `CONTEXT#${input.snapshotId}#${input.requestId}`;
    const receipt = { changeId: row.changeId, sk, tenantId: row.tenantId, snapshotId: input.snapshotId, snapshotHash: row.snapshotHash,
      requestId: input.requestId, contextHash: input.contextHash, evidenceRef, executionArn: ctx.executionArn };
    const same = async () => {
      const prior = await this.read(this.tables.changes, row.changeId, sk);
      if (!prior) return false;
      requireData(canonicalJson(prior) === canonicalJson(receipt), 'IDEMPOTENCY_CONFLICT', 'Prompt context request ID was already used for different evidence'); return true;
    };
    if (await same()) return;
    try { await this.commit([this.insert(this.tables.changes, receipt),
      { ConditionCheck: { TableName: this.tables.changes, Key: { changeId: row.changeId, sk: 'META' },
        ConditionExpression: '#v = :version AND snapshotHash = :hash', ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':version': row.version, ':hash': row.snapshotHash } } },
      this.event(row, 'prompt_context.recorded', ctx.actorId, { snapshotId: input.snapshotId, requestId: input.requestId, contextHash: input.contextHash, evidenceRef, executionArn: ctx.executionArn })]);
    } catch (error) { if ((error as WorkflowDataError).code === 'CONFLICT' && await same()) return; throw error; }
  }
  async openApprovalWait(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; gate: Gate; attemptId: string; taskToken: string; expiresAt: string; targetId?: string; expectedPriorDeploymentId?: string; historyFlagIds?: string[] }): Promise<void> {
    const row = await this.getChange(ctx, input.changeId); this.worker(ctx, row); this.expected(row, input.snapshotHash);
    idSchema.parse(input.attemptId); requireData(input.gate === 'content' || input.gate === 'deploy', 'INVALID_GATE', 'Invalid review gate');
    requireData(input.taskToken.length > 0 && input.taskToken.length <= 4096, 'INVALID_TOKEN', 'Callback token is missing or too long');
    const expiry = new Date(input.expiresAt).getTime(); requireData(Number.isFinite(expiry) && expiry > this.clock().getTime(), 'EXPIRED_TOKEN', 'Callback deadline has passed');
    requireData(!row.callbackPending, 'BUSY', 'Previous callback is still being delivered');
    requireData(row.state === (input.gate === 'content' ? 'checked' : 'tested'), 'INVALID_STATE', 'Gate prerequisites have not passed');
    requireData(row.openAmbiguities === 0, 'OPEN_AMBIGUITY', 'Open ambiguity blocks approval');
    let historyFlags: HistoryFlag[] = row.historyFlags ?? [];
    if (input.gate === 'content') {
      const snapshot = await this.getSnapshot(ctx, row.changeId, row.snapshotId);
      requireData(snapshot.retrievalEvidenceRefs?.length > 0, 'MISSING_EVIDENCE', 'Freeze the exact prompt-context source references into a new snapshot before review');
      historyFlags = await this.checkRuleHistory(ctx, row.changeId, row.snapshotHash);
    }
    let build: Item | undefined;
    if (input.gate === 'deploy') {
      idSchema.parse(input.targetId); if (input.expectedPriorDeploymentId) idSchema.parse(input.expectedPriorDeploymentId);
      build = await this.read(this.tables.changes, row.changeId, `BUILD#${row.latestBuildId}`);
      requireData(build?.buildKind === 'release' && build.snapshotHash === row.snapshotHash && row.latestTestId, 'INVALID_BUILD', 'Only a tested release build can enter deploy review');
    }
    const sk = `WAIT#${input.gate}#${row.snapshotHash}#${input.attemptId}`;
    for (const flag of input.historyFlagIds ?? []) idSchema.parse(flag);
    const token = clean({ changeId: row.changeId, sk, tenantId: row.tenantId, gate: input.gate, snapshotHash: row.snapshotHash,
      executionArn: ctx.executionArn, attemptId: input.attemptId, taskToken: input.taskToken, expiresAt: new Date(expiry).toISOString(),
      status: 'pending', createdAt: this.stamp(), buildId: build?.buildId, artifactDigest: build?.artifactDigest,
      targetId: input.targetId, expectedPriorDeploymentId: input.expectedPriorDeploymentId ?? null,
      historyFlagIds: [...new Set(input.historyFlagIds ?? [])] });
    await this.commit([this.insert(this.tables.tokens, token), this.metaUpdate(row, { state: input.gate === 'content' ? 'content_review' : 'deploy_review', activeWaitSk: sk, historyFlags }),
      this.event(row, `${input.gate}.review_opened`, ctx.actorId, { attemptId: input.attemptId, expiresAt: token.expiresAt, buildId: build?.buildId })]);
  }
  async recordDecision(ctx: HumanContext, input: DecisionInput): Promise<Item> {
    validateContext(ctx);
    for (const v of [input.changeId, input.decisionId, input.idempotencyKey]) idSchema.parse(v);
    digestSchema.parse(input.snapshotHash);
    requireData(input.gate === 'content' || input.gate === 'deploy', 'INVALID_GATE', 'Invalid review gate');
    requireData(['approve', 'reject'].includes(input.decision), 'INVALID_DECISION', 'Decision must approve or reject');
    requireData((input.notes?.length ?? 0) <= 8000, 'INVALID_DECISION', 'Notes are too long');
    requireData(input.decision !== 'reject' || Boolean(input.notes?.trim()), 'MISSING_NOTES', 'Rejection requires an explanation');
    const row = await this.getChange(ctx, input.changeId);
    const requestHash = sha256(canonicalJson(clean({ ...input, notes: input.notes ?? '', acknowledgedFlagIds: [...new Set(input.acknowledgedFlagIds ?? [])].sort(), actorId: ctx.subject })));
    const receiptKey = `IDEMP#${input.idempotencyKey}`;
    const replay = async (): Promise<Item | undefined> => {
      const receipt = await this.read(this.tables.approvals, row.changeId, receiptKey);
      if (!receipt) return undefined;
      requireData(receipt.tenantId === ctx.tenantId && receipt.requestHash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different input');
      const decision = await this.read(this.tables.approvals, row.changeId, receipt.decisionKey);
      requireData(decision, 'INTEGRITY_ERROR', 'Decision receipt is incomplete'); return safeDecision(decision);
    };
    const prior = await replay(); if (prior) return prior;
    this.expected(row, input.snapshotHash);
    requireData(row.state === `${input.gate}_review`, 'INVALID_STATE', 'Change is not waiting at this review gate');
    const allowed = input.gate === 'deploy' ? ['it_deploy'] as const : row.requiresClinician ? ['clinician'] as const : ['program_reviewer', 'clinician'] as const;
    hasRole(ctx, [...allowed]);
    requireData(row.authorId !== ctx.subject, 'SEPARATION_OF_DUTIES', 'Snapshot author cannot approve or reject their own review');
    if (input.gate === 'deploy') {
      const content = await this.read(this.tables.approvals, row.changeId, row.contentDecisionKey);
      requireData(content?.decision === 'approve' && content.snapshotHash === row.snapshotHash, 'MISSING_CONTENT_APPROVAL', 'Exact snapshot lacks content approval');
      requireData(content.actorId !== ctx.subject, 'SEPARATION_OF_DUTIES', 'The same person cannot decide both approval gates');
    }
    const token = await this.read(this.tables.tokens, row.changeId, row.activeWaitSk);
    requireData(token?.status === 'pending' && token.snapshotHash === row.snapshotHash && token.gate === input.gate, 'STALE_TOKEN', 'No active callback attempt matches this decision');
    requireData(token.expiresAt > this.stamp(), 'EXPIRED_TOKEN', 'Approval wait has expired');
    const acknowledged = [...new Set(input.acknowledgedFlagIds ?? [])];
    for (const flag of acknowledged) idSchema.parse(flag);
    if (input.gate === 'deploy' && input.decision === 'approve') requireData((token.historyFlagIds as string[]).every(id => acknowledged.includes(id)), 'UNACKNOWLEDGED_FLAGS', 'IT must acknowledge each advisory history flag');
    const decisionKey = `${input.gate.toUpperCase()}#${row.snapshotHash}#${input.decisionId}`;
    const decision = clean({ changeId: row.changeId, sk: decisionKey, tenantId: row.tenantId, decisionId: input.decisionId,
      gate: input.gate, snapshotHash: row.snapshotHash, decision: input.decision, actorId: ctx.subject,
      actorRole: ctx.groups.find(g => allowed.includes(g as never)), authorId: row.authorId, notes: input.notes ?? '',
      createdAt: this.stamp(), idempotencyKey: input.idempotencyKey, buildId: token.buildId, artifactDigest: token.artifactDigest, targetId: token.targetId,
      expectedPriorDeploymentId: token.expectedPriorDeploymentId, acknowledgedFlagIds: acknowledged, historyFlags: row.historyFlags ?? [],
      validationReport: row.validationReport, testReport: row.testReport, diffReport: row.diffReport, executionArn: row.executionArn });
    // `notes` is the same value stored on the decision record; a reject always has one (MISSING_NOTES above).
    const payload = clean({ changeId: row.changeId, snapshotHash: row.snapshotHash, gate: input.gate, decisionId: input.decisionId,
      decision: input.decision, buildId: token.buildId, artifactDigest: token.artifactDigest, notes: input.notes || undefined });
    const patch: Item = { state: input.decision === 'approve' ? `${input.gate}_approved` : 'rejected', callbackPending: true };
    if (input.decision === 'approve') patch[`${input.gate}DecisionKey`] = decisionKey;
    const rejectedRules: Write[] = [];
    if (input.gate === 'content' && input.decision === 'reject') {
      const snapshot = await this.getSnapshot(ctx, row.changeId, row.snapshotId);
      const unique = new Set<string>();
      for (const rule of (snapshot.ruleFingerprints ?? []) as RuleFingerprint[]) {
        if (unique.has(rule.fingerprint)) continue; unique.add(rule.fingerprint);
        rejectedRules.push(this.insert(this.tables.approvals, { changeId: `HISTORY#${ctx.tenantId}#${row.pathwayId}#${rule.fingerprint}`,
          sk: `${decision.createdAt}#${input.decisionId}`, tenantId: ctx.tenantId, pathwayId: row.pathwayId,
          fingerprint: rule.fingerprint, sourceChangeId: row.changeId, snapshotHash: row.snapshotHash, snapshotId: row.snapshotId,
          decisionId: input.decisionId, decisionKey, decision: 'reject', gate: 'content', notes: decision.notes, createdAt: decision.createdAt }));
      }
    }
    try {
      await this.commit([...rejectedRules, this.insert(this.tables.approvals, decision), this.insert(this.tables.approvals, { changeId: row.changeId,
        sk: receiptKey, tenantId: row.tenantId, requestHash, decisionKey, createdAt: this.stamp() }),
        this.metaUpdate(row, patch), this.event(row, `${input.gate}.${input.decision}`, ctx.subject, { decisionId: input.decisionId, decisionKey }),
        { Update: { TableName: this.tables.tokens, Key: { changeId: row.changeId, sk: token.sk },
          UpdateExpression: 'SET #status = :decided, decisionPayload = :payload, callbackQueue = :queue, callbackDueAt = :now, decisionKey = :key, deliveryAttempts = :zero',
          ConditionExpression: '#status = :pending AND expiresAt > :now', ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':decided': 'decided', ':pending': 'pending', ':payload': payload, ':queue': row.tenantId, ':now': this.stamp(), ':key': decisionKey, ':zero': 0 } } }]);
    } catch (error) { if ((error as WorkflowDataError).code === 'CONFLICT') { const won = await replay(); if (won) return won; } throw error; }
    return safeDecision(decision);
  }
  async assertContentApproved(ctx: WorkflowContext, changeId: string, hash: string): Promise<Change> {
    const row = await this.getChange(ctx, changeId); this.worker(ctx, row); this.expected(row, hash);
    const decision = row.contentDecisionKey && await this.read(this.tables.approvals, changeId, row.contentDecisionKey);
    requireData(decision?.decision === 'approve' && decision.snapshotHash === hash && decision.actorId !== row.authorId, 'MISSING_CONTENT_APPROVAL', 'Exact current snapshot is not approved');
    return row;
  }
  async recordBuild(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; buildId: string; buildKind: 'preview' | 'release'; compilerVersion: string; toolchainImageDigest: string; artifacts: ArtifactRef; artifactDigest: string; diff: ArtifactRef }): Promise<void> {
    const row = await this.getChange(ctx, input.changeId); this.worker(ctx, row); this.expected(row, input.snapshotHash);
    idSchema.parse(input.buildId); digestSchema.parse(input.artifactDigest);
    requireData(['preview', 'release'].includes(input.buildKind), 'INVALID_BUILD', 'Unknown build kind');
    const artifacts = artifactRefSchema.parse(input.artifacts); const diff = artifactRefSchema.parse(input.diff);
    requireData(input.artifactDigest === artifacts.sha256, 'HASH_MISMATCH', 'Release digest must match the versioned release artifact checksum');
    const snapshot = await this.getSnapshot(ctx, row.changeId, row.snapshotId);
    requireData(snapshot.compilerVersion === input.compilerVersion && snapshot.toolchainImageDigest === input.toolchainImageDigest, 'TOOLCHAIN_CHANGED', 'Toolchain changed: create a new hash-bound snapshot and obtain content review');
    if (input.buildKind === 'release') {
      await this.assertContentApproved(ctx, row.changeId, row.snapshotHash);
      requireData(['content_approved', 'build_failed', 'test_failed'].includes(row.state) && !row.callbackPending, 'INVALID_STATE', 'Release build must follow completed content approval or an identical-input retry');
    }
    const writes = [this.insert(this.tables.changes, { ...input, artifacts, diff, tenantId: row.tenantId, sk: `BUILD#${input.buildId}`, createdAt: this.stamp() }),
      this.event(row, 'build.recorded', ctx.actorId, { buildId: input.buildId, buildKind: input.buildKind, artifactDigest: input.artifactDigest, artifacts, diff })];
    if (input.buildKind === 'release') writes.push(this.metaUpdate(row, { state: 'built', latestBuildId: input.buildId, diffReport: diff }, ['latestTestId', 'testReport', 'deployDecisionKey']));
    else writes.push({ ConditionCheck: { TableName: this.tables.changes, Key: { changeId: row.changeId, sk: 'META' }, ConditionExpression: '#v = :version AND snapshotHash = :hash', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':version': row.version, ':hash': row.snapshotHash } } });
    await this.commit(writes);
  }
  async recordBuildFailure(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; code: string }): Promise<void> {
    const row = await this.assertContentApproved(ctx, input.changeId, input.snapshotHash);
    requireData(['content_approved', 'build_failed'].includes(row.state), 'INVALID_STATE', 'Cannot replace an existing release result with an earlier build failure');
    idSchema.parse(input.code);
    await this.commit([this.metaUpdate(row, { state: 'build_failed' }), this.event(row, 'build.failed', ctx.actorId, { errorCode: input.code })]);
  }
  async recordTestResult(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; buildId: string; attemptId: string; report: ArtifactRef; summary: TestSummary }): Promise<void> {
    const row = await this.getChange(ctx, input.changeId); this.worker(ctx, row); this.expected(row, input.snapshotHash);
    idSchema.parse(input.attemptId); idSchema.parse(input.buildId);
    requireData(['built', 'test_failed'].includes(row.state) && row.latestBuildId === input.buildId, 'INVALID_STATE', 'Tests must match the current release build');
    const { summary } = input;
    requireData(typeof summary.passed === 'boolean' && [summary.branchCount, summary.coveredBranches, summary.goldenCaseCount, summary.passedGoldenCases, summary.errorCount].every(n => Number.isInteger(n) && n >= 0), 'INVALID_TEST_RESULT', 'Test counts must be non-negative integers');
    requireData(summary.coveredBranches <= summary.branchCount && summary.passedGoldenCases <= summary.goldenCaseCount, 'INVALID_TEST_RESULT', 'Test coverage counts are inconsistent');
    const passed = summary.passed && summary.branchCount > 0 && summary.coveredBranches === summary.branchCount && summary.goldenCaseCount > 0 && summary.passedGoldenCases === summary.goldenCaseCount && summary.errorCount === 0;
    const report = artifactRefSchema.parse(input.report); const testId = `TEST#${input.buildId}#${input.attemptId}`;
    await this.commit([this.insert(this.tables.changes, { changeId: row.changeId, sk: testId, tenantId: row.tenantId, snapshotHash: row.snapshotHash,
      buildId: input.buildId, summary, passed, report, createdAt: this.stamp() }),
      this.metaUpdate(row, { state: passed ? 'tested' : 'test_failed', latestTestId: testId, testReport: report }),
      this.event(row, 'test.recorded', ctx.actorId, { buildId: input.buildId, passed, report, summary })]);
  }
  async getReleaseCandidate(ctx: WorkflowContext, changeId: string, hash: string): Promise<Item> {
    const row = await this.assertContentApproved(ctx, changeId, hash);
    requireData(row.state === 'deploy_approved' && !row.callbackPending, 'MISSING_DEPLOY_APPROVAL', 'Deployment approval must be recorded and its callback delivered');
    const decision = await this.read(this.tables.approvals, changeId, row.deployDecisionKey);
    const build = await this.read(this.tables.changes, changeId, `BUILD#${row.latestBuildId}`);
    const test = await this.read(this.tables.changes, changeId, row.latestTestId);
    requireData(decision?.decision === 'approve' && decision.snapshotHash === hash && build?.buildKind === 'release' && build.snapshotHash === hash &&
      decision.buildId === build.buildId && decision.artifactDigest === build.artifactDigest && test?.passed === true && test.buildId === build.buildId && test.snapshotHash === hash,
    'INVALID_RELEASE', 'Approval, test evidence and artifact do not match');
    return { changeId, snapshotHash: hash, buildId: build.buildId, artifactDigest: build.artifactDigest, artifacts: build.artifacts,
      targetId: decision.targetId, expectedPriorDeploymentId: decision.expectedPriorDeploymentId, approval: safeDecision(decision), testReport: test.report };
  }
  async acquireDeployment(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; deploymentId: string; leaseSeconds?: number }): Promise<Item> {
    const release = await this.getReleaseCandidate(ctx, input.changeId, input.snapshotHash);
    const row = await this.getChange(ctx, input.changeId); idSchema.parse(input.deploymentId);
    // Revalidate after the release's multi-item reads. A revision may have won
    // between those reads and this META read; never claim it using an old release.
    this.worker(ctx, row); this.expected(row, input.snapshotHash);
    requireData(row.state === 'deploy_approved' && !row.callbackPending && row.latestBuildId === release.buildId && row.deployDecisionKey === release.approval.sk,
      'INVALID_RELEASE', 'The approved release changed before its deployment claim');
    const seconds = input.leaseSeconds ?? 900; requireData(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, 'INVALID_LEASE', 'Deployment lease must be between 30 and 3600 seconds');
    const targetPk = `TARGET#${ctx.tenantId}#${release.targetId}`;
    const prior = await this.read(this.tables.changes, targetPk, 'META');
    requireData((prior?.currentDeploymentId ?? null) === release.expectedPriorDeploymentId, 'STALE_TARGET', 'Target changed after IT reviewed the release');
    requireData(!prior?.leaseOwner, 'TARGET_BUSY', 'Prior deployment must be verified/reconciled before another attempt, even when its lease expired');
    const leaseExpiresAt = new Date(this.clock().getTime() + seconds * 1000).toISOString();
    const target = { changeId: targetPk, sk: 'META', tenantId: ctx.tenantId, targetId: release.targetId, currentDeploymentId: prior?.currentDeploymentId ?? null,
      version: (prior?.version ?? 0) + 1, leaseOwner: input.deploymentId, leaseExpiresAt };
    const targetWrite: Write = { Put: { TableName: this.tables.changes, Item: target,
      ConditionExpression: prior ? '#v = :v AND attribute_not_exists(leaseOwner)' : 'attribute_not_exists(changeId)',
      ...(prior ? { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': prior.version } } : {}) } };
    await this.commit([targetWrite, this.metaUpdate(row, { state: 'deploying', activeDeploymentId: input.deploymentId }),
      this.insert(this.tables.changes, { changeId: row.changeId, sk: `DEPLOY#${input.deploymentId}`, tenantId: row.tenantId, deploymentId: input.deploymentId,
        ...release, status: 'in_progress', createdAt: this.stamp() }),
      this.event(row, 'deployment.started', ctx.actorId, { deploymentId: input.deploymentId, targetId: release.targetId })]);
    return { ...release, deploymentId: input.deploymentId, leaseExpiresAt };
  }
  async completeDeployment(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; deploymentId: string; verification: ArtifactRef }): Promise<void> {
    const row = await this.getChange(ctx, input.changeId); this.worker(ctx, row); this.expected(row, input.snapshotHash);
    requireData(row.state === 'deploying' && row.activeDeploymentId === input.deploymentId, 'INVALID_STATE', 'Deployment is not the active claimed attempt');
    const deployment = await this.read(this.tables.changes, row.changeId, `DEPLOY#${input.deploymentId}`);
    requireData(deployment?.status === 'in_progress', 'INVALID_STATE', 'Deployment is already complete or missing');
    const verification = artifactRefSchema.parse(input.verification); const targetPk = `TARGET#${ctx.tenantId}#${deployment.targetId}`;
    await this.commit([this.metaUpdate(row, { state: 'deployed', lastDeploymentId: input.deploymentId }, ['activeDeploymentId']),
      { Update: { TableName: this.tables.changes, Key: { changeId: targetPk, sk: 'META' },
        UpdateExpression: 'SET currentDeploymentId = :id, releaseManifest = :release, #v = #v + :one REMOVE leaseOwner, leaseExpiresAt',
        ConditionExpression: 'leaseOwner = :id', ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':id': input.deploymentId, ':release': { changeId: row.changeId, snapshotHash: row.snapshotHash, buildId: deployment.buildId, artifacts: deployment.artifacts, artifactDigest: deployment.artifactDigest }, ':one': 1 } } },
      { Update: { TableName: this.tables.changes, Key: { changeId: row.changeId, sk: `DEPLOY#${input.deploymentId}` },
        UpdateExpression: 'SET #status = :verified, verification = :proof, completedAt = :now', ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':verified': 'verified', ':pending': 'in_progress', ':proof': verification, ':now': this.stamp() } } },
      this.event(row, 'deployment.verified', ctx.actorId, { deploymentId: input.deploymentId, verification })]);
  }
  async getTarget(ctx: { tenantId: string }, targetId: string): Promise<Item | undefined> {
    idSchema.parse(ctx.tenantId); idSchema.parse(targetId);
    const target = await this.read(this.tables.changes, `TARGET#${ctx.tenantId}#${targetId}`, 'META');
    return target && clean({ targetId: target.targetId, currentDeploymentId: target.currentDeploymentId, releaseManifest: target.releaseManifest, deploymentInProgress: Boolean(target.leaseOwner) });
  }
  /** Trusted deploy worker only: call AFTER verifying rollback/unchanged target in CHT.
   * Timeout alone is never evidence that a deployment failed or did not apply. */
  async reconcileFailedDeployment(ctx: WorkflowContext, input: { changeId: string; snapshotHash: string; deploymentId: string; rollbackVerification: ArtifactRef }): Promise<void> {
    const row = await this.getChange(ctx, input.changeId); this.worker(ctx, row); this.expected(row, input.snapshotHash);
    requireData(row.state === 'deploying' && row.activeDeploymentId === input.deploymentId, 'INVALID_STATE', 'Only the active attempt can be reconciled');
    const deployment = await this.read(this.tables.changes, row.changeId, `DEPLOY#${input.deploymentId}`);
    requireData(deployment?.status === 'in_progress', 'INVALID_STATE', 'Attempt is already reconciled or missing');
    const verification = artifactRefSchema.parse(input.rollbackVerification);
    await this.commit([this.metaUpdate(row, { state: 'deploy_approved' }, ['activeDeploymentId']),
      { Update: { TableName: this.tables.changes, Key: { changeId: `TARGET#${ctx.tenantId}#${deployment.targetId}`, sk: 'META' },
        UpdateExpression: 'SET #v = #v + :one REMOVE leaseOwner, leaseExpiresAt',
        ConditionExpression: 'leaseOwner = :id AND currentDeploymentId = :prior', ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':id': input.deploymentId, ':prior': deployment.expectedPriorDeploymentId, ':one': 1 } } },
      { Update: { TableName: this.tables.changes, Key: { changeId: row.changeId, sk: `DEPLOY#${input.deploymentId}` },
        UpdateExpression: 'SET #status = :failed, rollbackVerification = :proof, completedAt = :now', ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':failed': 'failed_reconciled', ':pending': 'in_progress', ':proof': verification, ':now': this.stamp() } } },
      this.event(row, 'deployment.failure_reconciled', ctx.actorId, { deploymentId: input.deploymentId, rollbackVerification: verification })]);
  }
  async listAudit(ctx: { tenantId: string }, changeId: string, cursor?: Record<string, unknown>): Promise<{ items: Item[]; cursor?: Item }> {
    await this.getChange(ctx, changeId);
    return this.query(this.tables.audit, changeId, undefined, cursor);
  }
  async listDecisions(ctx: { tenantId: string }, changeId: string): Promise<Item[]> {
    await this.getChange(ctx, changeId); const result: Item[] = [];
    for (const gate of ['CONTENT#', 'DEPLOY#']) result.push(...(await this.allPages(this.tables.approvals, changeId, gate)).map(safeDecision));
    return result;
  }
  async listVerifiedReleases(ctx: { tenantId: string }, changeId: string): Promise<Item[]> {
    await this.getChange(ctx, changeId); const rows = await this.allPages(this.tables.changes, changeId, 'DEPLOY#');
    return rows.filter(row => row.status === 'verified');
  }
  private async allPages(table: string, changeId: string, prefix: string): Promise<Item[]> {
    const items: Item[] = []; let cursor: Item | undefined;
    do { const page = await this.query(table, changeId, prefix, cursor); items.push(...page.items); cursor = page.cursor; } while (cursor);
    return items;
  }
  async listInbox(ctx: { tenantId: string }, state: 'content_review' | 'deploy_review', cursor?: Item): Promise<{ items: Item[]; cursor?: Item }> {
    idSchema.parse(ctx.tenantId); requireData(['content_review', 'deploy_review'].includes(state), 'INVALID_STATE', 'Unknown inbox');
    const response = await this.client.send(new QueryCommand({ TableName: this.tables.changes, IndexName: 'ReviewInboxIndex',
      KeyConditionExpression: 'inbox = :inbox', ExpressionAttributeValues: { ':inbox': `${ctx.tenantId}#${state}` },
      Limit: 50, ExclusiveStartKey: cursor, ScanIndexForward: false }));
    return { items: response.Items ?? [], cursor: response.LastEvaluatedKey };
  }
  async query(table: string, changeId: string, prefix?: string, cursor?: Item): Promise<{ items: Item[]; cursor?: Item }> {
    const response = await this.client.send(new QueryCommand({ TableName: table, ConsistentRead: true,
      KeyConditionExpression: `changeId = :id${prefix ? ' AND begins_with(sk, :prefix)' : ''}`,
      ExpressionAttributeValues: { ':id': changeId, ...(prefix ? { ':prefix': prefix } : {}) },
      Limit: 100, ExclusiveStartKey: cursor }));
    return { items: response.Items ?? [], cursor: response.LastEvaluatedKey };
  }
}
