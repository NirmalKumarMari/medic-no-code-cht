import { CfnOutput, CfnParameter, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";

export interface OrchestratorStackProps extends StackProps {
  /**
   * Prefix of the existing workflow tables, `<prefix>-Changes` etc. Must match
   * the `tablePrefix` the root `infra/` WorkflowDataStack was deployed with.
   */
  tablePrefix?: string;
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
    const { tablePrefix = "vera-workflow", ...stackProps } = props;
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
    const changePlannerAgentUrl = workerUrl("changePlannerAgentUrl", "Change Planner Agent endpoint (edit path)");
    const logicChecksUrl = workerUrl("logicChecksUrl", "Deterministic logic-checks service endpoint");
    const compileUrl = workerUrl("compileUrl", "Deterministic compiler service endpoint");
    const buildTestUrl = workerUrl("buildTestUrl", "Build/test sandbox trigger endpoint");
    const deployUrl = workerUrl("deployUrl", "Separate deployer-role service endpoint");

    // ---- Existing workflow tables, owned by infra/workflow-data-stack.ts.
    // Referenced by name only: this stack never creates, updates or deletes them.
    const workflowTable = (kind: "Changes" | "Tokens") =>
      dynamodb.Table.fromTableName(this, `${kind}Table`, `${tablePrefix}-${kind}`);
    const changesTable = workflowTable("Changes");
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
      memorySize: 128,
      environment: { TOKENS_TABLE_NAME: tokensTable.tableName },
    });
    tokensTable.grantWriteData(requestApprovalFn);

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
    const callAgent = (name: string, url: string, payload: unknown, resultPath: string) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: invokeWorkerFn,
        payload: sfn.TaskInput.fromObject({
          workerUrl: url,
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

    // ---- Helper to build an approval-wait task. The Lambda just records
    // the token; the Approvals API (outside this stack) calls
    // SendTaskSuccess once a human actually decides.
    //
    // The run parks here until a person decides in the UI. Whatever the
    // decision callback sends (SendTaskSuccess output) is stored at
    // `resultPath`; the rest of `$` is untouched. The Choice after each gate
    // reads `<resultPath>.decision`, which is "approve" or "reject" in the
    // workflow-data CallbackPayload the UI/DB integration sends.
    //
    // `summary` is deliberately small (it is stored in a DynamoDB item, 400 KB
    // max): it never carries the guideline text or the full `$`.
    const waitForApproval = (
      name: string,
      approvalKind: "content" | "deploy",
      summary: Record<string, unknown>,
      resultPath: string,
    ) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: requestApprovalFn,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({
          taskToken: sfn.JsonPath.taskToken,
          changeId: sfn.JsonPath.stringAt("$.changeId"),
          approvalKind,
          summary,
        }),
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
    // Not on the agent envelope yet: these get the whole `$`, and their reply
    // is stored at the path below.
    //   $.changePlan  Change Planner reply
    //   $.logicChecks { passed: boolean, ... }
    //   $.contentApproval / $.deployApproval  human decision { decision: "approve" | "reject", ... }
    //   $.compile, $.buildTest { passed: boolean, logicMustChange: boolean, ... }, $.deploy
    const changePlanTask = callWorker("ChangePlanTask", changePlannerAgentUrl, "$.changePlan");
    const logicChecksTask = callWorker("LogicChecksTask", logicChecksUrl, "$.logicChecks");
    const approvalSummary = {
      changeId: sfn.JsonPath.stringAt("$.changeId"),
      tenant: sfn.JsonPath.stringAt("$.tenant"),
      requestKind: sfn.JsonPath.stringAt("$.intake.output.requestKind"),
      pathway: sfn.JsonPath.stringAt("$.intake.output.pathway"),
      runId: sfn.JsonPath.stringAt("$$.Execution.Name"),
    };
    const contentApprovalTask = waitForApproval(
      "ContentApprovalTask",
      "content",
      { ...approvalSummary, logicChecks: sfn.JsonPath.objectAt("$.logicChecks") },
      "$.contentApproval",
    );
    const compileTask = callWorker("CompileTask", compileUrl, "$.compile");
    const buildTestTask = callWorker("BuildTestTask", buildTestUrl, "$.buildTest");
    const deployApprovalTask = waitForApproval(
      "DeployApprovalTask",
      "deploy",
      {
        ...approvalSummary,
        logicChecks: sfn.JsonPath.objectAt("$.logicChecks"),
        buildTest: sfn.JsonPath.objectAt("$.buildTest"),
      },
      "$.deployApproval",
    );
    const deployTask = callWorker("DeployTask", deployUrl, "$.deploy");

    const checksFailed = new sfn.Fail(this, "LogicChecksFailed", {
      error: "LogicChecksFailed",
      cause: "Logic checks did not pass; the report is at $.logicChecks in the execution history",
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
    for (const task of [
      intakeTask,
      draftContextTask,
      draftTask,
      redraftTask,
      changePlanTask,
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

    // Route on the StructuredSpec's requestKind (Intake's output, not the envelope):
    // plain_language_edit -> Change Planner, guideline_upload / pathway_pick -> Drafting.
    const routeByRequestKind = new sfn.Choice(this, "RouteByRequestKind")
      .when(sfn.Condition.stringEquals("$.intake.output.requestKind", "plain_language_edit"), changePlanTask)
      .otherwise(draftContextTask);

    // First draft, or a re-draft carrying the rejection? `$.revision` only
    // exists after a human rejected a draft in this run.
    const isRedraft = new sfn.Choice(this, "IsRedraft")
      .when(sfn.Condition.isPresent("$.revision"), redraftTask)
      .otherwise(draftTask);
    draftContextTask.next(okOr("DraftContextOk", "$.draftContext", isRedraft));
    const draftOk = okOr("DraftOk", "$.draft", logicChecksTask);
    draftTask.next(draftOk);
    redraftTask.next(draftOk);
    changePlanTask.next(logicChecksTask);

    const checksPassed = new sfn.Choice(this, "ChecksPassed")
      .when(sfn.Condition.booleanEquals("$.logicChecks.passed", true), contentApprovalTask)
      .otherwise(checksFailed);

    // A decision that is neither "approve" nor "reject" is a broken callback,
    // not a rejection: stop rather than silently re-draft or deploy.
    const invalidDecision = new sfn.Fail(this, "InvalidApprovalDecision", {
      error: "InvalidApprovalDecision",
      cause: "Approval callback did not carry decision \"approve\", or \"reject\" with string notes",
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
      return new sfn.Choice(this, name)
        .when(sfn.Condition.stringEquals(`${resultPath}.decision`, "approve"), onApprove)
        .when(
          sfn.Condition.and(
            sfn.Condition.stringEquals(`${resultPath}.decision`, "reject"),
            sfn.Condition.isString(`${resultPath}.notes`),
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
      timeout: Duration.days(7), // approval waits can span days; this bounds a truly stuck execution
      tracingEnabled: true,
    });

    changesTable.grantReadWriteData(stateMachine);
    tokensTable.grantReadWriteData(stateMachine);

    new CfnOutput(this, "StateMachineArn", { value: stateMachine.stateMachineArn });
    // Table names/ARNs are output by the workflow-data stack that owns them.
  }
}
