import { CfnOutput, CfnParameter, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";

export interface OrchestratorStackProps extends StackProps {
  /**
   * Prefix of the existing workflow tables, `<prefix>-Changes` etc. Must match
   * the `tablePrefix` the root `infra/` WorkflowDataStack was deployed with.
   */
  tablePrefix?: string;
  /**
   * How long each approval gate waits for a person, in days (default 30).
   * Sets both the workflow-data wait expiry and the Step Functions task
   * timeout, so the two always agree.
   */
  approvalWaitDays?: number;
}

/**
 * The orchestrator: the state machine (design doc section 6/11) and the
 * Lambda glue that connects Step Functions to the worker containers' HTTP
 * endpoints.
 *
 * This stack creates NO tables. It references the four workflow tables
 * (`vera-workflow-Changes`, `-Approvals`, `-Audit`, `-Tokens`) that the root
 * `infra/workflow-data-stack.ts` owns and retains, so there is one copy of
 * pipeline state. Deploy that stack first.
 *
 * Human gates: the run waits for a person in the UI after logic checks
 * (content approval) and before deploy (deploy approval). A rejection at
 * either gate goes back to the drafting phase (Draft, or Change Planner for
 * edits) by team decision. Note this differs from design doc section 6,
 * which re-enters a rejection at LogicChecks with a new snapshot.
 *
 * Also deferred for v1 (Should-Have, first on the cut list per the
 * design doc's own prioritization): the Cross-Check and History-Check
 * states. Both slot in as additional LambdaInvoke tasks once their
 * agents exist — Cross-Check in parallel with/after Draft, History-Check
 * advisory-only before DeployApproval.
 */
export class OrchestratorStack extends Stack {
  constructor(scope: Construct, id: string, props: OrchestratorStackProps = {}) {
    const { tablePrefix = "vera-workflow", approvalWaitDays = 30, ...stackProps } = props;
    // Two gates must fit inside the 365-day execution timeout below.
    if (!Number.isInteger(approvalWaitDays) || approvalWaitDays < 1 || approvalWaitDays > 180) {
      throw new Error("approvalWaitDays must be a whole number from 1 to 180");
    }
    // Same rule as infra/workflow-data-stack.ts, so both stacks agree on names.
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,70}$/.test(tablePrefix)) {
      throw new Error("Invalid workflow table prefix");
    }
    super(scope, id, stackProps);

    // ---- Worker URLs: these point at containers nobody has deployed yet.
    // Filled in at `cdk deploy` time (`--parameters intakeAgentUrl=...`),
    // not baked into the template, per the handover rule that nothing
    // hard-codes an endpoint.
    const workerUrl = (name: string, description: string) =>
      new CfnParameter(this, name, { type: "String", description }).valueAsString;

    const intakeAgentUrl = workerUrl("intakeAgentUrl", "Intake Agent POST /intake endpoint");
    const draftContextUrl = workerUrl(
      "draftContextUrl",
      "Trusted prompt-context worker endpoint (PromptContextBuilder, mode drafting): returns the full guideline text for Drafting",
    );
    const draftAgentUrl = workerUrl("draftAgentUrl", "Drafting / Clinical Review Agent POST /draft endpoint (guideline_upload / pathway_pick path)");
    const changePlannerAgentUrl = workerUrl("changePlannerAgentUrl", "Change Planner Agent POST /change-plan endpoint (plain_language_edit path)");
    // The Change Planner refuses non-loopback calls without its worker Bearer
    // token (WORKER_AUTH_TOKEN). The token lives in Secrets Manager; only this
    // ARN is in the template and the execution, never the token.
    const changePlannerTokenSecretArn = new CfnParameter(this, "changePlannerTokenSecretArn", {
      type: "String",
      description: "Secrets Manager secret ARN whose SecretString is the Change Planner's WORKER_AUTH_TOKEN",
    }).valueAsString;
    const logicChecksUrl = workerUrl("logicChecksUrl", "Deterministic logic-checks service endpoint");
    const compileUrl = workerUrl("compileUrl", "Deterministic compiler service endpoint");
    const buildTestUrl = workerUrl("buildTestUrl", "Build/test sandbox trigger endpoint");
    const deployUrl = workerUrl("deployUrl", "Separate deployer-role service endpoint");
    const snapshotRegistrarUrl = workerUrl(
      "snapshotRegistrarUrl",
      "Snapshot registrar worker POST /register endpoint (workers/snapshot-registrar)",
    );
    const snapshotRegistrarTokenSecretArn = new CfnParameter(this, "snapshotRegistrarTokenSecretArn", {
      type: "String",
      description: "Secrets Manager secret ARN whose SecretString is the snapshot registrar's WORKER_AUTH_TOKEN",
    }).valueAsString;
    // The CHT instance a deploy approval targets (workflow-data openApprovalWait `targetId`).
    const chtTargetId = new CfnParameter(this, "chtTargetId", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$",
      description: "Identifier of the CHT target instance that deploy approvals are bound to",
    }).valueAsString;

    // ---- Existing workflow tables, owned by infra/workflow-data-stack.ts.
    // Referenced by name only: this stack never creates, updates or deletes them.
    const workflowTable = (kind: "Changes" | "Approvals" | "Audit" | "Tokens") =>
      dynamodb.Table.fromTableName(this, `${kind}Table`, `${tablePrefix}-${kind}`);
    const changesTable = workflowTable("Changes");
    const approvalsTable = workflowTable("Approvals");
    const auditTable = workflowTable("Audit");
    const tokensTable = workflowTable("Tokens");

    // ---- Lambda glue (small event glue only — design doc's disallow list
    // explicitly permits this, and nothing else runs application logic here).
    const invokeWorkerFn = new nodejs.NodejsFunction(this, "InvokeWorkerFn", {
      entry: "lambda/invoke-worker/index.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.minutes(2),
      memorySize: 256,
    });

    const requestApprovalFn = new nodejs.NodejsFunction(this, "RequestApprovalFn", {
      entry: "lambda/request-approval/index.ts",
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        // workflow-data `tablesFromEnvironment` resolves the four names from this prefix.
        WORKFLOW_TABLE_PREFIX: tablePrefix,
        APPROVAL_WAIT_SECONDS: String(approvalWaitDays * 24 * 60 * 60),
        CHT_TARGET_ID: chtTargetId,
      },
    });
    // What openApprovalWait needs: read the change/snapshot/build rows and the
    // rejected-rule history, then one transaction that writes the WAIT token,
    // updates the change and appends an audit event.
    // Least privilege: no Scan, no DeleteItem, no write to Approvals.
    changesTable.grant(requestApprovalFn, "dynamodb:GetItem", "dynamodb:UpdateItem");
    tokensTable.grant(requestApprovalFn, "dynamodb:GetItem", "dynamodb:PutItem");
    approvalsTable.grant(requestApprovalFn, "dynamodb:Query");
    auditTable.grant(requestApprovalFn, "dynamodb:PutItem");
    // invoke-worker reads ONLY the workers' Bearer tokens, nothing else.
    secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ChangePlannerTokenSecret",
      changePlannerTokenSecretArn,
    ).grantRead(invokeWorkerFn);
    secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "SnapshotRegistrarTokenSecret",
      snapshotRegistrarTokenSecretArn,
    ).grantRead(invokeWorkerFn);

    // ---- Helper to build a plain worker-call task (no approval wait).
    // The worker gets the whole `$` and its JSON reply is stored at
    // `resultPath`, so it can never drop `$.intake` or earlier results (the
    // reject loop-backs route on `$.intake.output.requestKind`).
    const callWorker = (name: string, url: string, resultPath: string) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: invokeWorkerFn,
        payload: sfn.TaskInput.fromObject({
          workerUrl: url,
          body: sfn.JsonPath.objectAt("$"),
        }),
        payloadResponseOnly: true, // the worker's own JSON, not the Lambda envelope
        resultPath,
      });

    // ---- Helper for an agent-envelope call. The worker gets the shared
    // AgentRequest { changeId, runId, tenant, payload } and answers 200 with an
    // AgentResult { agent, changeId, runId, tenant, ok, output | failure }.
    // The result is stored at `resultPath`, so the execution input
    // (changeId, tenant, request) and earlier results stay in `$`.
    const callAgent = (
      name: string,
      url: string,
      payload: unknown,
      resultPath: string,
      authSecretArn?: string,
    ) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: invokeWorkerFn,
        payload: sfn.TaskInput.fromObject({
          workerUrl: url,
          ...(authSecretArn ? { authSecretArn } : {}),
          body: {
            changeId: sfn.JsonPath.stringAt("$.changeId"),
            runId: sfn.JsonPath.stringAt("$$.Execution.Name"),
            tenant: sfn.JsonPath.stringAt("$.tenant"),
            payload,
          },
        }),
        payloadResponseOnly: true, // the AgentResult itself, not the Lambda envelope
        resultPath,
      });

    // ---- Helper to build an approval-wait task.
    //
    // The run parks here until a person decides in the UI. The Lambda opens the
    // wait through workflow-data `openApprovalWait`, bound to the exact
    // registered snapshotHash ($.snapshot.output.snapshotHash) that the logic
    // checks also reported checking. The UI
    // records the decision with workflow-data `recordDecision`, and the
    // workflow-data callback dispatcher resumes this task with its
    // CallbackPayload { changeId, snapshotHash, gate, decisionId, decision, notes? },
    // which is stored at `resultPath`; the rest of `$` is untouched.
    const waitForApproval = (name: string, gate: "content" | "deploy", resultPath: string) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: requestApprovalFn,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({
          taskToken: sfn.JsonPath.taskToken,
          changeId: sfn.JsonPath.stringAt("$.changeId"),
          tenant: sfn.JsonPath.stringAt("$.tenant"),
          executionArn: sfn.JsonPath.stringAt("$$.Execution.Id"),
          gate,
          snapshotHash: sfn.JsonPath.stringAt("$.snapshot.output.snapshotHash"),
        }),
        // Same length as the workflow-data wait expiry set by the Lambda.
        taskTimeout: sfn.Timeout.duration(Duration.days(approvalWaitDays)),
        resultPath,
      });

    // ---- States.
    //
    // Execution input: { changeId, tenant, request } where `request` is the
    // Intake payload (IntakeRequest). The execution name becomes the runId, so
    // it must match the shared id rule ([A-Za-z0-9][A-Za-z0-9_.-]*); the
    // default UUID names do.
    //
    // Intake -> Drafting bridge, with everything kept in `$`:
    //   $.intake       AgentResult<StructuredSpec>
    //   $.draftContext { ok, output: { text, contextHash, evidenceRef } } from trusted code
    //   $.draft        AgentResult<LogicModel>
    const intakeTask = callAgent(
      "IntakeTask",
      intakeAgentUrl,
      sfn.JsonPath.objectAt("$.request"),
      "$.intake",
    );
    const draftContextTask = callAgent(
      "DraftContextTask",
      draftContextUrl,
      { mode: "drafting", spec: sfn.JsonPath.objectAt("$.intake.output") },
      "$.draftContext",
    );
    const draftTask = callAgent(
      "DraftTask",
      draftAgentUrl,
      {
        spec: sfn.JsonPath.objectAt("$.intake.output"),
        guidelineText: sfn.JsonPath.stringAt("$.draftContext.output.text"),
      },
      "$.draft",
    );
    // Same agent and result path, after a human rejection: also sends the
    // reviewer's notes ($.revision, set by RecordContentRejection /
    // RecordDeployRejection) and the draft they rejected ($.draft.output).
    const redraftTask = callAgent(
      "RedraftTask",
      draftAgentUrl,
      {
        spec: sfn.JsonPath.objectAt("$.intake.output"),
        guidelineText: sfn.JsonPath.stringAt("$.draftContext.output.text"),
        revision: {
          gate: sfn.JsonPath.stringAt("$.revision.gate"),
          notes: sfn.JsonPath.stringAt("$.revision.notes"),
          previousLogicModel: sfn.JsonPath.objectAt("$.draft.output"),
        },
      },
      "$.draft",
    );
    // Change Planner (plain_language_edit path), on the agent envelope:
    //   $.changePlan  AgentResult<ChangePlan>
    // First plan, and a re-plan after a human rejection that also carries the
    // reviewer's notes from $.revision. The planner always re-plans from the
    // authoritative baseline it fetches itself, so no previous plan is sent.
    const changePlanTask = callAgent(
      "ChangePlanTask",
      changePlannerAgentUrl,
      { spec: sfn.JsonPath.objectAt("$.intake.output") },
      "$.changePlan",
      changePlannerTokenSecretArn,
    );
    const replanTask = callAgent(
      "ReplanTask",
      changePlannerAgentUrl,
      {
        spec: sfn.JsonPath.objectAt("$.intake.output"),
        revision: {
          gate: sfn.JsonPath.stringAt("$.revision.gate"),
          notes: sfn.JsonPath.stringAt("$.revision.notes"),
        },
      },
      "$.changePlan",
      changePlannerTokenSecretArn,
    );

    // Not on the agent envelope yet: these get the whole `$`, and their reply
    // is stored at the path below.
    //   $.logicChecks { passed: boolean, ... }
    //   $.contentApproval / $.deployApproval  human decision { decision: "approve" | "reject", ... }
    //   $.compile, $.buildTest { passed: boolean, logicMustChange: boolean, ... }, $.deploy
    // ---- Snapshot registration (workers/snapshot-registrar), after Draft or
    // Change Planner and before Logic_Checks (pipeline-orchestrator Req 2.6).
    // Writes the immutable Snapshot_Bundle to S3 and makes it the change's
    // current snapshot in workflow-data (createDraft, or registerRevision after
    // a rejection), with the requesting program officer as Author.
    //   $.snapshot  { ok: true, output: { snapshotId, snapshotHash, pathwayId, artifact, registration } }
    //            or { ok: false, failure: { code, message } }
    const registerCommon = {
      changeId: sfn.JsonPath.stringAt("$.changeId"),
      runId: sfn.JsonPath.stringAt("$$.Execution.Name"),
      tenant: sfn.JsonPath.stringAt("$.tenant"),
      executionArn: sfn.JsonPath.stringAt("$$.Execution.Id"),
      submittedBy: sfn.JsonPath.objectAt("$.intake.output.submittedBy"),
      pathway: sfn.JsonPath.stringAt("$.intake.output.pathway"),
    };
    const registerTask = (name: string, body: Record<string, unknown>) => {
      const task = new tasks.LambdaInvoke(this, name, {
        lambdaFunction: invokeWorkerFn,
        payload: sfn.TaskInput.fromObject({
          workerUrl: snapshotRegistrarUrl,
          authSecretArn: snapshotRegistrarTokenSecretArn,
          body: { ...registerCommon, ...body },
        }),
        payloadResponseOnly: true,
        resultPath: "$.snapshot",
      });
      // 503: workflow-data is still finalizing the previous decision's callback.
      task.addRetry({ errors: ["WorkerBusy"], interval: Duration.seconds(3), maxAttempts: 5, backoffRate: 2 });
      return task;
    };
    const registerDraftTask = registerTask("RegisterDraftTask", {
      kind: "draft",
      logicModel: sfn.JsonPath.objectAt("$.draft.output"),
      context: {
        source: sfn.JsonPath.objectAt("$.draftContext.output.source"),
        evidenceRef: sfn.JsonPath.objectAt("$.draftContext.output.evidenceRef"),
      },
    });
    const registerPlanTask = registerTask("RegisterPlanTask", {
      kind: "change_plan",
      plan: sfn.JsonPath.objectAt("$.changePlan.output"),
    });

    const logicChecksTask = callWorker("LogicChecksTask", logicChecksUrl, "$.logicChecks");
    const contentApprovalTask = waitForApproval("ContentApprovalTask", "content", "$.contentApproval");
    const compileTask = callWorker("CompileTask", compileUrl, "$.compile");
    const buildTestTask = callWorker("BuildTestTask", buildTestUrl, "$.buildTest");
    const deployApprovalTask = waitForApproval("DeployApprovalTask", "deploy", "$.deployApproval");
    const deployTask = callWorker("DeployTask", deployUrl, "$.deploy");

    const checksFailed = new sfn.Fail(this, "LogicChecksFailed", {
      error: "LogicChecksFailed",
      cause: "Logic checks did not pass for the registered snapshotHash; the report is at $.logicChecks in the execution history",
    });
    const succeeded = new sfn.Succeed(this, "ChangeDeployed");

    // Agent failures (ok: false) end the run with the agent's own failure message
    // for a person to read; nothing is retried or guessed here.
    const agentFailed = (name: string, resultPath: string) =>
      new sfn.Fail(this, name, {
        error: name,
        causePath: sfn.JsonPath.stringAt(`${resultPath}.failure.message`),
      });
    // A non-2xx or unreachable worker (invoke-worker throws) is a service fault, not an agent answer.
    const workerUnavailable = new sfn.Fail(this, "WorkerUnavailable", {
      error: "WorkerUnavailable",
      causePath: sfn.JsonPath.stringAt("$.error.Cause"),
    });
    // Approval gates: catches added first take precedence over WorkerUnavailable.
    // A refusal from openApprovalWait (stale snapshot, prerequisites not passed,
    // open ambiguity, missing prompt-context evidence) is not a service fault.
    const gateRefused = new sfn.Fail(this, "ApprovalGateRefused", {
      error: "ApprovalGateRefused",
      causePath: sfn.JsonPath.stringAt("$.error.Cause"),
    });
    const gateExpired = new sfn.Fail(this, "ApprovalWaitExpired", {
      error: "ApprovalWaitExpired",
      cause: `No decision within ${approvalWaitDays} days; the workflow-data wait has expired`,
    });
    for (const gateTask of [contentApprovalTask, deployApprovalTask]) {
      gateTask.addCatch(gateRefused, { errors: ["ApprovalWaitRefused"], resultPath: "$.error" });
      gateTask.addCatch(gateExpired, { errors: [sfn.Errors.TIMEOUT], resultPath: "$.error" });
    }
    for (const task of [
      intakeTask,
      draftContextTask,
      draftTask,
      redraftTask,
      changePlanTask,
      replanTask,
      registerDraftTask,
      registerPlanTask,
      logicChecksTask,
      contentApprovalTask,
      compileTask,
      buildTestTask,
      deployApprovalTask,
      deployTask,
    ]) {
      task.addCatch(workerUnavailable, { resultPath: "$.error" });
    }

    const okOr = (name: string, resultPath: string, next: sfn.IChainable) =>
      new sfn.Choice(this, name)
        .when(sfn.Condition.booleanEquals(`${resultPath}.ok`, true), next)
        .otherwise(agentFailed(`${name.replace(/Ok$/, "")}Failed`, resultPath));

    // First plan, or a re-plan carrying the rejection? Same rule as IsRedraft.
    // A `needs_clarification` plan still goes on to logic checks: its open
    // flags block content review there (workflow-data recordValidation), and a
    // person resolves them; nothing here applies or approves the plan.
    const isReplan = new sfn.Choice(this, "IsReplan")
      .when(sfn.Condition.isPresent("$.revision"), replanTask)
      .otherwise(changePlanTask);
    for (const task of [changePlanTask, replanTask]) {
      task.addRetry({ errors: ["WorkerBusy"], interval: Duration.seconds(5), maxAttempts: 3, backoffRate: 2 });
    }
    const snapshotOk = new sfn.Choice(this, "SnapshotRegistered")
      .when(sfn.Condition.booleanEquals("$.snapshot.ok", true), logicChecksTask)
      .otherwise(
        new sfn.Fail(this, "SnapshotRegistrationRefused", {
          error: "SnapshotRegistrationRefused",
          causePath: sfn.JsonPath.stringAt("$.snapshot.failure.message"),
        }),
      );
    registerDraftTask.next(snapshotOk);
    registerPlanTask.next(snapshotOk);
    const changePlanOk = okOr("ChangePlanOk", "$.changePlan", registerPlanTask);
    changePlanTask.next(changePlanOk);
    replanTask.next(changePlanOk);

    // Route on the StructuredSpec's requestKind (Intake's output, not the envelope):
    // plain_language_edit -> Change Planner, guideline_upload / pathway_pick -> Drafting.
    const routeByRequestKind = new sfn.Choice(this, "RouteByRequestKind")
      .when(sfn.Condition.stringEquals("$.intake.output.requestKind", "plain_language_edit"), isReplan)
      .otherwise(draftContextTask);

    // First draft, or a re-draft carrying the rejection? `$.revision` only
    // exists after a human rejected a draft in this run.
    const isRedraft = new sfn.Choice(this, "IsRedraft")
      .when(sfn.Condition.isPresent("$.revision"), redraftTask)
      .otherwise(draftTask);
    draftContextTask.next(okOr("DraftContextOk", "$.draftContext", isRedraft));
    const draftOk = okOr("DraftOk", "$.draft", registerDraftTask);
    draftTask.next(draftOk);
    redraftTask.next(draftOk);

    const checksPassed = new sfn.Choice(this, "ChecksPassed")
      // Checks must have passed for the snapshot just registered (Req 3.3, 3.6).
      .when(
        sfn.Condition.and(
          sfn.Condition.booleanEquals("$.logicChecks.passed", true),
          sfn.Condition.isString("$.logicChecks.snapshotHash"),
          sfn.Condition.stringEqualsJsonPath("$.logicChecks.snapshotHash", "$.snapshot.output.snapshotHash"),
        ),
        contentApprovalTask,
      )
      .otherwise(checksFailed);

    // A decision that is neither "approve" nor "reject" is a broken callback,
    // not a rejection: stop rather than silently re-draft or deploy.
    const invalidDecision = new sfn.Fail(this, "InvalidApprovalDecision", {
      error: "InvalidApprovalDecision",
      cause: "Approval callback did not carry decision \"approve\", or \"reject\" with string notes, for the gated snapshotHash",
    });

    // Human gate decisions. A rejection at EITHER gate goes back to the drafting
    // phase through RouteByRequestKind: guideline_upload / pathway_pick re-run
    // DraftContext -> Redraft, plain_language_edit re-runs the Change Planner.
    // The new draft then goes through logic checks and content approval again.
    //
    // Before looping back, the rejection is recorded at `$.revision` so the
    // re-draft gets the reviewer's notes (the Change Planner also receives it,
    // inside the whole `$`). A later rejection overwrites it. A reject without
    // string `notes` is a broken callback: the run stops instead of re-drafting
    // blind.
    const gateDecision = (
      name: string,
      gate: "content" | "deploy",
      resultPath: string,
      onApprove: sfn.IChainable,
    ) => {
      const recordRejection = new sfn.Pass(this, `Record${gate === "content" ? "Content" : "Deploy"}Rejection`, {
        parameters: {
          gate,
          notes: sfn.JsonPath.stringAt(`${resultPath}.notes`),
        },
        resultPath: "$.revision",
      }).next(routeByRequestKind);
      // The decision must name the snapshotHash this gate was opened for
      // (design rule 4, pipeline-orchestrator Req 5.2). workflow-data already
      // binds it; this re-checks it in the workflow before acting.
      const forGatedSnapshot = sfn.Condition.and(
        sfn.Condition.isString(`${resultPath}.snapshotHash`),
        sfn.Condition.stringEqualsJsonPath(`${resultPath}.snapshotHash`, "$.snapshot.output.snapshotHash"),
      );
      return new sfn.Choice(this, name)
        .when(
          sfn.Condition.and(sfn.Condition.stringEquals(`${resultPath}.decision`, "approve"), forGatedSnapshot),
          onApprove,
        )
        .when(
          sfn.Condition.and(
            sfn.Condition.stringEquals(`${resultPath}.decision`, "reject"),
            sfn.Condition.isString(`${resultPath}.notes`),
            forGatedSnapshot,
          ),
          recordRejection,
        )
        .otherwise(invalidDecision);
    };

    const contentApproved = gateDecision("ContentApproved", "content", "$.contentApproval", compileTask);
    const deployApproved = gateDecision("DeployApproved", "deploy", "$.deployApproval", deployTask);

    const buildFailedLogicMustChange = new sfn.Choice(this, "LogicMustChange")
      .when(sfn.Condition.booleanEquals("$.buildTest.logicMustChange", true), routeByRequestKind)
      .otherwise(buildTestTask); // compiler/infra bug, logic unchanged: rebuild the SAME hash (design doc 6/#7)

    const buildPassed = new sfn.Choice(this, "BuildPassed")
      .when(sfn.Condition.booleanEquals("$.buildTest.passed", true), deployApprovalTask)
      .otherwise(buildFailedLogicMustChange);

    intakeTask.next(okOr("IntakeOk", "$.intake", routeByRequestKind));
    logicChecksTask.next(checksPassed);
    contentApprovalTask.next(contentApproved);
    compileTask.next(buildTestTask);
    buildTestTask.next(buildPassed);
    deployApprovalTask.next(deployApproved);
    deployTask.next(succeeded);

    const definition = sfn.Chain.start(intakeTask);

    const stateMachine = new sfn.StateMachine(this, "PipelineStateMachine", {
      stateMachineName: "medic-nocode-pipeline",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      // Step Functions standard maximum; each approval gate has its own shorter timeout.
      timeout: Duration.days(365),
      tracingEnabled: true,
    });

    changesTable.grantReadWriteData(stateMachine);
    tokensTable.grantReadWriteData(stateMachine);

    new CfnOutput(this, "StateMachineArn", { value: stateMachine.stateMachineArn });
    // Table names/ARNs are output by the workflow-data stack that owns them.
  }
}
