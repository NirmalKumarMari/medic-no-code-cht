import { compileChtProject, expression } from './preview-cht.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ArtifactStore, GuardrailScreen, PromptContextBuilder, SourcePublisher } from '@vera/artifact-storage';
import { WorkflowRepository, canonicalJson, s3SnapshotVerifier, sha256, snapshotBundleSchema, snapshotHash, tablesFromEnvironment } from '@vera/workflow-data';
import { createBedrockConverse, handleIntake } from '@vera/agent-intake';
import { BedrockGuardrail, BedrockModelClient, DraftingAgent, handleDrafting } from '@vera/agent-drafting';
import { createBedrockConverse as plannerConverse, handleChangePlan, runChangePlannerAgent, CHT_CONVENTIONS_PRIMER } from '@vera/agent-change-planner';
import { registerSnapshot } from '@vera/worker-snapshot-registrar';
import { reviewDisplaySchema } from '@vera/review-model/data/display-schema';
import { runChecks } from '@vera/review-model/data/checks';
import { buildPatientGrid, matches } from '@vera/review-model/data/evaluate';

const env = process.env;
const region = env.AWS_REGION ?? 'us-west-2';
const queue = env.REVIEW_WORK_QUEUE_URL;
const tenant = env.REVIEW_DEMO_TENANT;
const targetId = 'vera-preview-artifacts';
const previousChtCompiler = 'vera-preview-cht-6.6.1-v1';
const compilerVersion = 'vera-preview-cht-6.6.1-v2';
const toolchainImageDigest = env.PREVIEW_CHT_IMAGE;
if (!/^sha256:[a-f0-9]{64}$/.test(toolchainImageDigest ?? '')) throw Error('Preview CHT image digest is missing');
const sample = 'Synthetic triage protocol — training only. Page 1, Decision rule: Ask whether the demo signal is present. Record yes or no in demo_signal. Use one conditional rule: if yes, refer urgently. Use the final otherwise rule to give home care advice for every other response. No follow-up task is required.';
const sampleCases = [{ inputs: { demo_signal: 'yes' }, action: 'refer_urgently' }, { inputs: { demo_signal: 'no' }, action: 'home_care_advice' }];
if (!queue || !tenant || !env.REVIEW_PIPELINE_ARN || !env.WORKFLOW_ARTIFACT_BUCKET || !env.KMS_KEY_ARN) throw Error('Preview worker configuration is incomplete');
const executionPrefix = env.REVIEW_PIPELINE_ARN.replace(':stateMachine:', ':execution:') + ':';
const sqs = new SQSClient({ region }), sfn = new SFNClient({ region });
const s3 = new S3Client({ region });
const artifacts = new ArtifactStore(s3, env.WORKFLOW_ARTIFACT_BUCKET, env.KMS_KEY_ARN);
const repo = new WorkflowRepository({
  client: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } }),
  tables: tablesFromEnvironment(),
  verifySnapshot: s3SnapshotVerifier(s3, env.WORKFLOW_ARTIFACT_BUCKET),
});
const screening = new GuardrailScreen(new BedrockRuntimeClient({ region }), env.GUARDRAIL_ID, env.GUARDRAIL_VERSION);
const origin = 'https://d3kk07plry56g2.cloudfront.net';
const publisher = new SourcePublisher(artifacts, screening, [origin]);
// The context evidence is stored in S3 and attached transactionally when the snapshot is registered.
const contexts = new PromptContextBuilder(artifacts, { record: async () => {} }, screening);
const modelId = env.DRAFTING_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const drafter = new DraftingAgent(new BedrockModelClient({ region, modelId }), { guardrail: new BedrockGuardrail({ region, guardrailIdentifier: env.GUARDRAIL_ID, guardrailVersion: env.GUARDRAIL_VERSION }) });
const intake = createBedrockConverse();
const storeJson = (key, data) => artifacts.putArtifact(key, Buffer.from(canonicalJson(data)), 'application/json');
const readJson = async (ref) => JSON.parse(Buffer.from(await artifacts.getArtifactVersion(ref)).toString());
const readText = async (ref) => Buffer.from(await artifacts.getArtifactVersion(ref)).toString('utf8');
const context = (job) => ({ tenantId: tenant, executionArn: job.executionArn, actorId: 'preview-worker' });
const runId = (job) => job.request.changeId;
const goldenCases = job => job.preview.goldenCases ?? (job.preview.document || job.preview.baselineChangeId ? [] : sampleCases);
const matchesCase = (test, actual) => actual?.action === test.action
  && (test.followUp === undefined || canonicalJson(actual.followUp) === canonicalJson(test.followUp));
const bundle = async (ctx, row) => {
  const meta = await repo.getSnapshot(ctx, row.changeId, row.snapshotId);
  const value = snapshotBundleSchema.parse(await readJson(meta.artifact));
  if (snapshotHash(value) !== row.snapshotHash) throw Error('Snapshot hash mismatch');
  return value;
};
async function extractPdf(ref) {
  const bytes = await artifacts.getArtifactVersion(ref);
  const dir = await mkdtemp(join(tmpdir(), 'vera-preview-pdf-'));
  try {
    const pdf = join(dir, 'source.pdf');
    await writeFile(pdf, bytes, { mode: 0o600 });
    const { stdout } = await promisify(execFile)(env.PREVIEW_PDF_PYTHON ?? 'python3', ['-c', 'import sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nif len(r.pages)>30: raise ValueError("Use a PDF excerpt of at most 30 pages")\nfor i,p in enumerate(r.pages,1): print(f"Page {i}\\n{p.extract_text()}")', pdf], { timeout: 20000, maxBuffer: 56 * 1024 });
    if (!stdout.trim() || !stdout.replace(/Page \d+/g, '').trim()) throw Error('The PDF has no extractable text');
    return stdout;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function prepare(job, mode, text, ref) {
  const id = runId(job);
  const sourceId = mode === 'drafting' ? `guide-${id}` : 'vera-preview-primer';
  const bytes = Buffer.from(text);
  const key = sha256(bytes);
  const source = await publisher.publish({ sourceType: mode === 'drafting' ? 'guideline' : 'cht-primer',
    sourceId, version: key.slice(0, 24), section: 'Full text', path: `${sourceId}.txt`, url: `${origin}/vera-preview/`, sourceHash: key,
    public: true, reviewedBy: 'demo-program-officer', reviewedAt: '2026-11-04T00:00:00Z', purpose: 'reference-document' }, bytes, 'txt');
  if (ref) await storeJson(`reports/${id}/source/${key}.json`, { originalPdf: ref, extractedText: source.document });
  return contexts.prepare({ tenantId: tenant, changeId: id, snapshotId: mode, requestId: key.slice(0, 32) }, mode, source);
}
function displayModel(row, raw) {
  return reviewDisplaySchema.parse({ ...raw, snapshotId: row.snapshotId, snapshotHash: row.snapshotHash,
    pathway: typeof raw.pathway === 'string' ? { id: row.pathwayId, title: raw.pathway } : raw.pathway,
    inputs: raw.inputs.map(input => ({ ...input, ...(input.options && !input.choices ? { choices: input.options } : {}) })),
  });
}
function compile(model) {
  const cases = model.rules.map(rule => `if (${expression(rule.when)}) return ${JSON.stringify({ id: rule.id, action: rule.then.action, followUp: rule.followUp ?? null })};`);
  return `(a) => { ${cases.join('\n')} return null; }`;
}
async function finished(ctx, changeId) {
  const row = await repo.getChange(ctx, changeId);
  if (!row.callbackPending) return row;
  const e = Error('Previous approval delivery is still being finalized');
  e.name = 'WorkerBusy';
  throw e;
}
async function handle(job) {
  const id = runId(job), ctx = context(job), body = job.body;
  if (job.operation === 'intakeAgentUrl') {
    return handleIntake(body, { writeSpecDraft: spec => storeJson(`snapshots/${id}/intake/${sha256(canonicalJson(spec))}.json`, spec) }, intake);
  }
  if (job.operation === 'draftContextUrl') {
    const ref = job.preview.document;
    const output = await prepare(job, 'drafting', ref ? await extractPdf(ref) : sample, ref);
    return { ok: true, output };
  }
  if (job.operation === 'draftAgentUrl') return handleDrafting(body, drafter, modelId);
  if (job.operation === 'changePlannerAgentUrl') {
    return handleChangePlan(body, async (spec, revision) => {
      const base = await repo.getChange(ctx, job.preview.baselineChangeId);
      if (!base.contentDecisionKey || base.snapshotHash !== spec.baselineSnapshotHash) throw Error('Approved baseline changed');
      const hashInputs = await bundle(ctx, base);
      const plannerContext = await prepare(job, 'change_planner', CHT_CONVENTIONS_PRIMER);
      const pin = hashInputs.evidenceVersions[0];
      const baseline = { logicModel: hashInputs.spec, snapshotHash: base.snapshotHash, hashInputs, plannerContext,
        guideline: { sourceId: pin.sourceId, version: pin.version, sha256: pin.sha256, text: await readText(pin.sourceS3Ref) } };
      const tools = {
        getBaselineSnapshot: async ({ snapshotHash: hash }) => {
          if (hash !== base.snapshotHash) throw Error('Baseline pin mismatch');
          return baseline;
        },
        writeChangePlanDraft: async (plan) => { await storeJson(`proposals/${id}/${plan.snapshotHash}.json`, plan); },
      };
      return runChangePlannerAgent(spec, tools, plannerConverse(), undefined, revision);
    });
  }
  if (job.operation === 'snapshotRegistrarUrl') {
    return registerSnapshot(body, { repo, artifacts, config: { schemaVersion: '1', goldenCaseVersion: job.preview.goldenCases ? sha256(canonicalJson(job.preview.goldenCases)) : 'synthetic-triage-v1', compilerVersion, toolchainImageDigest } });
  }
  if (job.operation === 'approval') {
    const { gate, snapshotHash: hash } = body;
    const attemptId = sha256(job.token).slice(0, 32);
    const existing = await repo.read(repo.tables.tokens, id, `WAIT#${gate}#${hash}#${attemptId}`);
    if (!existing) {
      const current = gate === 'deploy' ? await repo.getTarget(ctx, targetId) : undefined;
      await repo.openApprovalWait(ctx, { changeId: id, snapshotHash: hash, gate, attemptId, taskToken: job.token,
        expiresAt: new Date(Date.now() + 86300_000).toISOString(), ...(gate === 'deploy' ? { targetId, expectedPriorDeploymentId: current?.currentDeploymentId ?? null } : {}) });
    }
    return;
  }
  const row = await finished(ctx, id);
  const hash = body.snapshot.output.snapshotHash;
  if (row.snapshotHash !== hash) throw Error('This stage names a superseded snapshot');
  if (job.operation === 'logicChecksUrl') {
    const snapshot = await bundle(ctx, row);
    const parsed = reviewDisplaySchema.safeParse({ ...snapshot.spec, snapshotId: row.snapshotId, snapshotHash: hash,
      pathway: { id: row.pathwayId, title: snapshot.spec.pathway },
      inputs: snapshot.spec.inputs.map(input => ({ ...input, ...(input.options ? { choices: input.options } : {}) })),
    });
    const checks = parsed.success ? runChecks(parsed.data) : [{ id: 'display', title: 'Supported logic', status: 'problem', summary: 'The generated rules include conditions the preview cannot safely display.', details: [] }];
    if (parsed.success && [compilerVersion, previousChtCompiler].includes(snapshot.compilerVersion)) {
      const golden = goldenCases(job);
      const failed = golden.flatMap((test, i) => {
        const rule = parsed.data.rules.find(candidate => matches(candidate.when, test.inputs));
        return matchesCase(test, rule && { action: rule.then.action, followUp: rule.followUp ?? null }) ? [] : [i + 1];
      });
      checks.push({ id: 'golden-cases', title: 'Golden cases', status: golden.length && !failed.length ? 'pass' : 'problem',
        summary: golden.length ? `${golden.length - failed.length} of ${golden.length} golden cases passed.` : 'Provide golden cases before requesting content approval.',
        details: failed.map(i => `Case ${i} failed.`) });
    }
    const openAmbiguities = (snapshot.spec.flags ?? []).filter(f => ['ambiguity', 'gap', 'conflict'].includes(f.type)).length;
    const passed = !openAmbiguities && !checks.some(c => c.status === 'problem');
    if (row.state === 'draft') {
      const report = await storeJson(`reports/${id}/${hash}/checks.json`, { snapshotHash: hash, passed, openAmbiguities, checks });
      await repo.recordValidation(ctx, { changeId: id, snapshotHash: hash, passed, openAmbiguities, requiresClinician: true, report });
    }
    return { passed, snapshotHash: hash };
  }
  if (job.operation === 'compileUrl') {
    const buildId = `b-${hash.slice(0, 32)}`;
    if (await repo.read(repo.tables.changes, id, `BUILD#${buildId}`)) return { buildId };
    await repo.assertContentApproved(ctx, id, hash);
    const snapshot = await bundle(ctx, row);
    const model = displayModel(row, snapshot.spec);
    const program = compile(model);
    let chtProject;
    if ([compilerVersion, previousChtCompiler].includes(snapshot.compilerVersion)) {
      let sandbox;
      if (snapshot.compilerVersion === compilerVersion) {
        if (snapshot.toolchainImageDigest !== toolchainImageDigest) throw Error('Pinned CHT build image is unavailable');
        const grid = buildPatientGrid(model);
        const covered = new Set();
        const tests = new Map();
        const add = (inputs, expectedAction) => {
          const index = model.rules.findIndex(rule => matches(rule.when, inputs));
          if (index < 0) throw Error('No expected rule for CHT harness case');
          const rule = model.rules[index];
          covered.add(index);
          tests.set(canonicalJson(inputs), { inputs, rule: `rule_${index + 1}`,
            action: expectedAction ?? rule.then.action, followUp: rule.followUp });
        };
        for (const inputs of grid.patients) {
          const index = model.rules.findIndex(rule => matches(rule.when, inputs));
          if (index >= 0 && !covered.has(index)) add(inputs);
        }
        if (grid.tooLarge || covered.size !== model.rules.length) throw Error('CHT form cannot exercise every rule with complete inputs');
        for (const test of goldenCases(job)) add(test.inputs, test.action);
        sandbox = { image: toolchainImageDigest, cases: [...tests.values()] };
      }
      const zip = await compileChtProject(model, env.PREVIEW_CHT_TOOLCHAIN, sandbox);
      chtProject = await artifacts.putArtifact(`builds/${id}/${buildId}/cht-project.zip`, zip, 'application/zip');
    }
    const release = await storeJson(`builds/${id}/${buildId}/preview.json`, {
      format: 'vera-preview-js-v1', snapshotHash: hash, compilerVersion: snapshot.compilerVersion, model, program, ...(chtProject ? { chtProject } : {}),
    });
    const diff = await storeJson(`reports/${id}/${hash}/preview-build.json`, { snapshotHash: hash, kind: 'preview-artifact', rules: model.rules.length, inputs: model.inputs.length });
    await repo.recordBuild(ctx, { changeId: id, snapshotHash: hash, buildId, buildKind: 'release', compilerVersion: snapshot.compilerVersion, toolchainImageDigest: snapshot.toolchainImageDigest, artifacts: release, artifactDigest: release.sha256, diff });
    return { buildId };
  }
  if (job.operation === 'buildTestUrl') {
    const buildId = body.compile.buildId;
    const prior = await repo.read(repo.tables.changes, id, `TEST#${buildId}#preview-v1`);
    if (prior) return { passed: prior.passed, logicMustChange: !prior.passed };
    const build = await repo.read(repo.tables.changes, id, `BUILD#${buildId}`);
    const { model, program, chtProject } = await readJson(build.artifacts);
    if ([compilerVersion, previousChtCompiler].includes(build.compilerVersion)) await artifacts.getArtifactVersion(chtProject);
    if (compile(model) !== program) throw Error('Stored decision program does not match the compiled model');
    const evaluate = new Script(program).runInNewContext(Object.create(null), { timeout: 1000 });
    const grid = buildPatientGrid(model), covered = new Set();
    let errorCount = 0;
    // The normal input grid covers valid answers. A separate missing-input probe
    // also exercises the mandatory fallback when explicit yes/no rules exhaust the valid domain.
    for (const patient of [...grid.patients, {}]) {
      const expected = model.rules.find(rule => matches(rule.when, patient));
      const actual = evaluate(patient);
      if (!actual || actual.id !== expected?.id || actual.action !== expected?.then.action || canonicalJson(actual.followUp) !== canonicalJson(expected?.followUp ?? null)) errorCount++;
      if (actual) covered.add(actual.id);
    }
    const golden = goldenCases(job);
    const passedGoldenCases = golden.filter(test => matchesCase(test, evaluate(test.inputs))).length;
    const passed = !grid.tooLarge && !errorCount && covered.size === model.rules.length && golden.length > 0 && passedGoldenCases === golden.length;
    const summary = { passed, branchCount: model.rules.length, coveredBranches: covered.size, goldenCaseCount: golden.length, passedGoldenCases, errorCount };
    const report = await storeJson(`reports/${id}/${hash}/preview-tests.json`, { snapshotHash: hash, ...summary });
    await repo.recordTestResult(ctx, { changeId: id, snapshotHash: hash, buildId, attemptId: 'preview-v1', report, summary });
    return { passed, logicMustChange: !passed };
  }
  if (job.operation === 'deployUrl') {
    if (row.state === 'deployed') return { released: true, target: targetId };
    const deploymentId = `r-${id}`;
    const release = row.state === 'deploying'
      ? await repo.read(repo.tables.changes, id, `DEPLOY#${deploymentId}`)
      : await repo.acquireDeployment(ctx, { changeId: id, snapshotHash: hash, deploymentId });
    const build = await repo.read(repo.tables.changes, id, `BUILD#${row.latestBuildId}`);
    const bytes = await artifacts.getArtifactVersion(build.artifacts);
    if (sha256(bytes) !== build.artifactDigest || release.targetId !== targetId) throw Error('Release verification failed');
    const verification = await storeJson(`reports/${id}/${hash}/preview-release.json`, { snapshotHash: hash, buildId: row.latestBuildId, artifactDigest: build.artifactDigest, targetId, releaseType: 'isolated downloadable preview' });
    await repo.completeDeployment(ctx, { changeId: id, snapshotHash: hash, deploymentId, verification });
    return { released: true, target: targetId };
  }
  throw Error('Unknown preview operation');
}

for (;;) {
  try {
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, WaitTimeSeconds: 20, MaxNumberOfMessages: 1 }));
    for (const message of result.Messages ?? []) {
      const job = JSON.parse(message.Body);
      if (!job.executionArn?.startsWith(executionPrefix) || !job.token || !job.request?.changeId || job.runId !== job.request.changeId) throw Error('Invalid queue execution envelope');
      try {
        const run = await sfn.send(new DescribeExecutionCommand({ executionArn: job.executionArn, includedData: 'METADATA_ONLY' }));
        if (run.status === 'RUNNING') {
          const output = await handle(job);
          if (job.operation !== 'approval') await sfn.send(new SendTaskSuccessCommand({ taskToken: job.token, output: JSON.stringify(output) }));
          console.log(JSON.stringify({ operation: job.operation, changeId: runId(job), ok: output?.ok ?? true }));
        }
      } catch (error) {
        if (error.name === 'WorkerBusy' || error.name === 'RegistrarBusy') {
          await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 3 }));
          continue;
        }
        console.error(JSON.stringify({ operation: job.operation, changeId: runId(job), error: error.code ?? error.name }));
        if (!['TaskDoesNotExist', 'TaskTimedOut', 'InvalidToken'].includes(error.name)) {
          try { await sfn.send(new SendTaskFailureCommand({ taskToken: job.token, error: job.operation === 'approval' ? 'ApprovalWaitRefused' : 'PreviewWorkerError', cause: `${job.operation}: ${error.code ?? error.name}` })); }
          catch (callbackError) { if (!['TaskDoesNotExist', 'TaskTimedOut', 'InvalidToken'].includes(callbackError.name)) throw callbackError; }
        }
      }
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle }));
    }
  } catch (error) {
    console.error(JSON.stringify({ queueError: error.name }));
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
