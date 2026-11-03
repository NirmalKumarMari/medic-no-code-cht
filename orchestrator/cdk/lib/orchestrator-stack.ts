import { CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";

/**
 * The orchestrator: four DynamoDB tables (design doc section 14), the
 * state machine (section 6/11), and the Lambda glue that connects Step
 * Functions to the worker containers' HTTP endpoints.
 *
 * KNOWN SIMPLIFICATION, flagged on purpose rather than silently done:
 * the design doc's reject loop (section 6) says a clinician rejection
 * should re-enter at LogicChecks via a revision step, not re-run the
 * original Drafting agent from scratch. The Change Planner Agent that
 * would do that revision does not exist yet, so v1 loops a rejection
 * back to Draft/ChangePlan instead. Swap the loop target once that
 * agent exists — see the `ContentApproved` choice below.
 *
 * Also deferred for v1 (Should-Have, first on the cut list per the
 * design doc's own prioritization): the Cross-Check and History-Check
 * states. Both slot in as additional LambdaInvoke tasks once their
 * agents exist — Cross-Check in parallel with/after Draft, History-Check
 * advisory-only before DeployApproval.
 */
export class OrchestratorStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---- Worker URLs: these point at containers nobody has deployed yet.
    // Filled in at `cdk deploy` time (`--parameters intakeAgentUrl=...`),
    // not baked into the template, per the handover rule that nothing
    // hard-codes an endpoint.
    const workerUrl = (name: string, description: string) =>
      new CfnParameter(this, name, { type: "String", description }).valueAsString;

    const intakeAgentUrl = workerUrl("intakeAgentUrl", "Intake Agent POST /intake endpoint");
    const draftAgentUrl = workerUrl("draftAgentUrl", "Drafting / Clinical Review Agent endpoint (new_pathway path)");
    const changePlannerAgentUrl = workerUrl("changePlannerAgentUrl", "Change Planner Agent endpoint (edit path)");
    const logicChecksUrl = workerUrl("logicChecksUrl", "Deterministic logic-checks service endpoint");
    const compileUrl = workerUrl("compileUrl", "Deterministic compiler service endpoint");
    const buildTestUrl = workerUrl("buildTestUrl", "Build/test sandbox trigger endpoint");
    const deployUrl = workerUrl("deployUrl", "Separate deployer-role service endpoint");

    // ---- DynamoDB tables (design doc section 14; keys per sections 10-11).
    const tableDefaults: Partial<dynamodb.TableProps> = {
      partitionKey: { name: "changeId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN, // never lose audit/approval history by accident
    };

    const changesTable = new dynamodb.Table(this, "ChangesTable", {
      ...tableDefaults,
      tableName: "Changes",
    });
    const approvalsTable = new dynamodb.Table(this, "ApprovalsTable", {
      ...tableDefaults,
      tableName: "Approvals",
    });
    const auditTable = new dynamodb.Table(this, "AuditTable", {
      ...tableDefaults,
      tableName: "Audit",
    });
    const tokensTable = new dynamodb.Table(this, "TokensTable", {
      ...tableDefaults,
      tableName: "Tokens",
    });

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
    const callWorker = (name: string, url: string) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: invokeWorkerFn,
        payload: sfn.TaskInput.fromObject({
          workerUrl: url,
          body: sfn.JsonPath.objectAt("$"),
        }),
        outputPath: "$.Payload", // downstream states see the worker's own JSON, not the Lambda envelope
      });

    // ---- Helper to build an approval-wait task. The Lambda just records
    // the token; the Approvals API (outside this stack) calls
    // SendTaskSuccess once a human actually decides.
    const waitForApproval = (name: string, approvalKind: "content" | "deploy") =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: requestApprovalFn,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({
          taskToken: sfn.JsonPath.taskToken,
          changeId: sfn.JsonPath.stringAt("$.changeId"),
          approvalKind,
          summary: sfn.JsonPath.objectAt("$"),
        }),
        // No outputPath here on purpose: the state's result, once SendTaskSuccess
        // is called, IS whatever payload the Approvals API sent — not this Lambda's
        // return value. That payload must itself be the full `$` the next state needs.
      });

    // ---- States.
    const intakeTask = callWorker("IntakeTask", intakeAgentUrl);
    const draftTask = callWorker("DraftTask", draftAgentUrl);
    const changePlanTask = callWorker("ChangePlanTask", changePlannerAgentUrl);
    const logicChecksTask = callWorker("LogicChecksTask", logicChecksUrl);
    const contentApprovalTask = waitForApproval("ContentApprovalTask", "content");
    const compileTask = callWorker("CompileTask", compileUrl);
    const buildTestTask = callWorker("BuildTestTask", buildTestUrl);
    const deployApprovalTask = waitForApproval("DeployApprovalTask", "deploy");
    const deployTask = callWorker("DeployTask", deployUrl);

    const checksFailed = new sfn.Fail(this, "LogicChecksFailed", {
      error: "LogicChecksFailed",
      causePath: sfn.JsonPath.stringAt("$.summary"),
    });
    const deployRejected = new sfn.Fail(this, "DeployRejected", {
      error: "DeployRejected",
      causePath: sfn.JsonPath.stringAt("$.notes"),
    });
    const succeeded = new sfn.Succeed(this, "ChangeDeployed");

    // changeType routing right after Intake: new_pathway -> Draft, edit -> ChangePlan.
    const routeByChangeType = new sfn.Choice(this, "RouteByChangeType")
      .when(sfn.Condition.stringEquals("$.changeType", "edit"), changePlanTask)
      .otherwise(draftTask);

    // Both paths converge on logic checks.
    draftTask.next(logicChecksTask);
    changePlanTask.next(logicChecksTask);

    const checksPassed = new sfn.Choice(this, "ChecksPassed")
      .when(sfn.Condition.booleanEquals("$.passed", true), contentApprovalTask)
      .otherwise(checksFailed);

    // KNOWN SIMPLIFICATION (see class doc comment): loops back to Draft/ChangePlan
    // rather than a dedicated revision step, until the Change Planner agent exists.
    const contentApproved = new sfn.Choice(this, "ContentApproved")
      .when(sfn.Condition.booleanEquals("$.approved", true), compileTask)
      .otherwise(routeByChangeType);

    const buildFailedLogicMustChange = new sfn.Choice(this, "LogicMustChange")
      .when(sfn.Condition.booleanEquals("$.logicMustChange", true), routeByChangeType)
      .otherwise(buildTestTask); // compiler/infra bug, logic unchanged: rebuild the SAME hash (design doc 6/#7)

    const buildPassed = new sfn.Choice(this, "BuildPassed")
      .when(sfn.Condition.booleanEquals("$.passed", true), deployApprovalTask)
      .otherwise(buildFailedLogicMustChange);

    const deployApproved = new sfn.Choice(this, "DeployApproved")
      .when(sfn.Condition.booleanEquals("$.approved", true), deployTask)
      .otherwise(deployRejected);

    intakeTask.next(routeByChangeType);
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
    new CfnOutput(this, "ChangesTableName", { value: changesTable.tableName });
    new CfnOutput(this, "ApprovalsTableName", { value: approvalsTable.tableName });
    new CfnOutput(this, "AuditTableName", { value: auditTable.tableName });
    new CfnOutput(this, "TokensTableName", { value: tokensTable.tableName });
  }
}
