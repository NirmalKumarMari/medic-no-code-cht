# Requirements Document

## Introduction

This spec covers the AWS platform that the other Vera specs run on: infrastructure as code, network, IAM, security baseline, observability, cost controls, and the deploy/teardown lifecycle (solution design §14, §15, §17, §18, §19, §20 and the README deploy/teardown instructions). It provisions resources and permissions only. The runtime behaviour of each component is owned by the dependent specs listed below and is not restated here.

**Dependent specs (consume resources from this spec):** logic-model-snapshots, authoring-agents, logic-checks-golden-cases, pipeline-orchestrator, review-ui-approvals, cht-config-compiler, build-test-sandbox, cht-deployer, decision-memory-history-check.

## Glossary

- **Platform_IaC**: The single infrastructure-as-code project defined by this spec, written in Terraform (Medic's standard) or CDK in TypeScript.
- **Deploy_Command**: The one documented command that provisions the whole platform into an AWS account in `us-west-2`.
- **Teardown_Command**: The one documented command that removes every resource the Deploy_Command created.
- **Platform_Checks**: The set of scripted, repeatable verification checks defined in Requirement 10.
- **Project_Tag**: The tag key `project` with one configured value, applied to every taggable resource.
- **Platform_KMS_Key**: The customer-managed KMS key used for SSE-KMS on the Artifact_Bucket and for the CHT_Login_Secret.
- **Artifact_Bucket**: The private, versioned, SSE-KMS S3 bucket holding pipeline artifacts under the prefixes `docs/`, `snapshots/`, `builds/`, `reports/`, `proposals/`, `decision-log/` (Decision_Log) and `deploy-records/`.
- **Screening_Guardrail**: The Amazon Bedrock Guardrail that screens inputs for personal data and credentials.
- **Pipeline_Tables**: The DynamoDB tables `Changes`, `Approvals`, `Audit` and `Tokens`, each with partition key `changeId`.
- **State_Machine**: The AWS Step Functions Standard workflow that orchestrates a change.
- **Services_Instance**: The t3.xlarge Ubuntu x86_64 EC2 instance hosting agent containers, deterministic services and orchestrator workers.
- **CHT_Test_Instance**: The t3.large Ubuntu x86_64 EC2 instance running the CHT test server.
- **Platform_VPC**: The VPC containing private subnets for compute and, when the Optional_ALB is enabled, one public subnet.
- **Optional_ALB**: The Application Load Balancer in front of the Review_API, created only when enabled by configuration.
- **Agent_Gateway**: The AgentCore Gateway exposing the Gateway_Tools that the authoring-agents and decision-memory-history-check specs register as MCP tools.
- **Gateway_Policy**: The AgentCore Policy (Cedar) attached to the Agent_Gateway that enforces each agent's allowed-tool list.
- **Workload_Identity**: An AgentCore Identity workload identity assigned to exactly one agent container.
- **Agent_Memory**: The AgentCore Memory resource with a long-term strategy, used for decision-history learning only.
- **Agent_Observability**: AgentCore Observability, exporting agent traces via OpenTelemetry to CloudWatch.
- **Approver_User_Pool**: The Amazon Cognito user pool with groups `program_officer`, `program_reviewer`, `clinician` and `it_deploy`.
- **CHT_Login_Secret**: The Secrets Manager secret holding the CHT_Test_Instance login.
- **Component_Role**: A least-privilege IAM role owned by exactly one component.
- **Deployer_Role**: The Component_Role of the cht-deployer component and the only reader of the CHT_Login_Secret.
- **Decision_Recorder**, **Config_Compiler**, **Sandbox_Runner**, **Review_API**, **Memory_Writer**: Components defined in the dependent specs, each with its own Component_Role.
- **Deterministic_Services**: The non-AI services (for example logic checks) defined in the dependent specs, each with its own Component_Role.
- **Not_Used_List**: AgentCore Runtime, Lambda functions running application logic, Fargate, SageMaker, RDS, Aurora, Kinesis, MSK, and model endpoints outside Amazon Bedrock.
- **Cost_Report**: The script that computes token use and cost per pipeline run from model invocation logs.
- **Build_Hours**: The configured daily window during which EC2 instances run.

## Requirements

### Requirement 1: One-command deploy and teardown

**User Story:** As an operator, I want one deploy command and one teardown command, so that the platform can be stood up in a fresh account and removed with nothing left running or billing.

#### Acceptance Criteria

1. THE Platform_IaC SHALL define every resource in this spec in one project written in either Terraform or CDK in TypeScript.
2. WHEN an operator runs the Deploy_Command with credentials for an AWS account that contains no resource carrying the Project_Tag, THE Platform_IaC SHALL provision every resource in this spec, place every regional resource in `us-west-2` whatever default region the operator's AWS profile sets, and exit with status 0.
3. WHEN an operator runs the Deploy_Command against an already-deployed platform with unchanged source and unchanged configuration values, THE Platform_IaC SHALL report zero resources to create, update or delete and exit with status 0.
4. IF any resource fails to provision during a Deploy_Command run, THEN THE Deploy_Command SHALL exit with a non-zero status and print the name of each failed resource together with the error AWS returned for it.
5. THE Platform_IaC SHALL publish as named outputs, readable after the Deploy_Command exits with status 0, every resource identifier the dependent specs consume, including bucket names, Pipeline_Tables names, the State_Machine ARN, the Agent_Gateway URL, the Approver_User_Pool ID, the Screening_Guardrail ID and version, the Agent_Memory ID and each Component_Role ARN.
6. WHEN an operator runs the Teardown_Command, THE Teardown_Command SHALL delete every resource the Deploy_Command created, including all object versions and delete markers in the Artifact_Bucket, every EBS volume and every CloudWatch Logs log group that platform resources write to.
7. WHEN the Teardown_Command finishes deleting resources, THE Teardown_Command SHALL list every remaining resource in `us-west-2` and in global services that carries the Project_Tag, leaving out the Platform_KMS_Key while it is pending deletion, and exit with status 0 if the list is empty and with a non-zero status otherwise.
8. THE Platform_IaC SHALL provision zero resources of any type on the Not_Used_List.
9. IF a Deploy_Command run exited with a non-zero status after creating some resources, THEN THE Teardown_Command SHALL delete every resource that run created.

### Requirement 2: Artifact storage

**User Story:** As a pipeline component owner, I want private, versioned, encrypted buckets with a fixed prefix layout, so that every artifact is retained and readable only by authorised roles.

#### Acceptance Criteria

1. THE Platform_IaC SHALL provision the Artifact_Bucket with versioning enabled.
2. THE Platform_IaC SHALL set the default encryption of the Artifact_Bucket to SSE-KMS with the Platform_KMS_Key as the encryption key.
3. THE Platform_IaC SHALL enable the four S3 Block Public Access settings `BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy` and `RestrictPublicBuckets` on the Artifact_Bucket.
4. THE Platform_IaC SHALL publish exactly seven Artifact_Bucket prefix outputs, one each for `docs/`, `snapshots/`, `builds/`, `reports/`, `proposals/`, `decision-log/` and `deploy-records/`, with each output value equal to the prefix string including its trailing slash.
5. THE Platform_IaC SHALL deny `s3:DeleteObjectVersion` on the Artifact_Bucket to every principal, including every Component_Role, except the operator principal that runs the Deploy_Command and the Teardown_Command.
6. THE Platform_IaC SHALL grant `kms:Decrypt` and `kms:GenerateDataKey` on the Platform_KMS_Key only to the operator principal that runs the Deploy_Command and the Component_Roles that read or write a bucket or the CHT_Login_Secret.
7. WHEN the Teardown_Command has deleted the Artifact_Bucket and the CHT_Login_Secret, THE Teardown_Command SHALL schedule the Platform_KMS_Key for deletion with the minimum 7-day waiting period and report the key as pending deletion instead of as a remaining resource.
8. THE Platform_IaC SHALL configure the Artifact_Bucket to reject, without storing an object, any object write request that specifies an encryption type other than SSE-KMS or a KMS key other than the Platform_KMS_Key.

### Requirement 3: Guardrail and model access

**User Story:** As the authoring owner, I want the guardrail and model permissions provisioned, so that drafting uses approved Bedrock resources only.

#### Acceptance Criteria

1. THE Platform_IaC SHALL provision the Screening_Guardrail with a sensitive-information filter that blocks every entity type in one configuration list, whose default is NAME, EMAIL, PHONE, ADDRESS, USERNAME, PASSWORD, PIN, AWS_ACCESS_KEY and AWS_SECRET_KEY and does not include AGE.
2. THE Platform_IaC SHALL publish a numbered Screening_Guardrail version whose configuration matches the deployed Screening_Guardrail and output that version number, never `DRAFT`, as the version the dependent specs reference.
3. THE Platform_IaC SHALL limit each Component_Role's model-invocation permission to the ARNs of the `us.` inference profiles that the component's owning spec assigns to it plus the foundation-model ARNs those profiles route to in each destination Region, with no wildcard model ARN and no model-invocation permission for a Component_Role that is assigned no inference profile.
4. IF the Screening_Guardrail entity-type list is empty, THEN THE Deploy_Command SHALL exit with a non-zero status that names that variable before creating or changing any resource.

### Requirement 4: Pipeline state and orchestration resources

**User Story:** As the pipeline-orchestrator owner, I want the state tables and the state machine provisioned, so that changes, approvals, audit records and task tokens persist across restarts and approval waits.

#### Acceptance Criteria

1. THE Platform_IaC SHALL provision exactly four Pipeline_Tables, `Changes`, `Approvals`, `Audit` and `Tokens`, each with partition key `changeId` of type string.
2. THE Platform_IaC SHALL create on each Pipeline_Table only the sort key and secondary indexes that the logic-model-snapshots and pipeline-orchestrator specs declare for that table, with the declared attribute names, attribute types and index projections.
3. THE Platform_IaC SHALL configure every Pipeline_Table with on-demand capacity mode and zero provisioned read or write capacity.
4. THE Platform_IaC SHALL grant no Component_Role any action on the `Audit` table that writes, modifies or deletes items or the table other than `dynamodb:PutItem`, including `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, `dynamodb:BatchWriteItem` and the PartiQL write actions.
5. THE Platform_IaC SHALL provision the State_Machine as a Step Functions workflow of type Standard.
6. THE Platform_IaC SHALL deploy the State_Machine definition supplied by the pipeline-orchestrator spec with no change other than replacing the placeholders that spec declares with the identifiers of resources provisioned by this spec.
7. THE Platform_IaC SHALL set the State_Machine's own Component_Role as the State_Machine execution role.
8. IF a Deploy_Command run against an already-deployed platform would replace or delete a Pipeline_Table or the State_Machine, THEN THE Deploy_Command SHALL exit with a non-zero status naming that resource before changing any resource, so that existing table items and RUNNING executions waiting on task tokens are kept.

### Requirement 5: Network and compute

**User Story:** As the security owner, I want compute in private subnets with Session Manager as the only administrative path, so that no SSH or admin port is reachable and the CHT test server stays inside the VPC.

#### Acceptance Criteria

1. THE Platform_IaC SHALL place every EC2 instance, with no public IPv4 address or Elastic IP address attached, in a Platform_VPC private subnet whose route table contains no route to an internet gateway.
2. WHERE the Optional_ALB is enabled, THE Platform_IaC SHALL create one public subnet, routed to an internet gateway, in each of two Availability Zones and place no resource other than the Optional_ALB in those subnets.
3. THE Platform_IaC SHALL provision exactly one Services_Instance of instance type t3.xlarge and exactly one CHT_Test_Instance of instance type t3.large, both from an Ubuntu x86_64 AMI.
4. THE Platform_IaC SHALL configure every EC2 instance to reject instance metadata requests that lack an IMDSv2 session token and to use a metadata response hop limit of exactly 2.
5. THE Platform_IaC SHALL configure every EC2 instance so that, within 10 minutes of entering the running state, the instance is listed as an online Systems Manager managed node and accepts a Session Manager session started by the principal that ran the Deploy_Command.
6. THE Platform_IaC SHALL create every security group with zero inbound rules that allow traffic on TCP port 22 (SSH), 23 (Telnet), 3389 (RDP), 5900 (VNC), 5985 or 5986 (WinRM), whether through a single-port rule, a port-range rule or an all-traffic rule.
7. THE Platform_IaC SHALL allow inbound traffic to the CHT_Test_Instance only on the one configured CHT HTTPS TCP port, default 443, and only from the Services_Instance security group.
8. THE Platform_IaC SHALL allow inbound traffic to the Services_Instance only on the TCP ports that the dependent specs declare for services hosted on the Services_Instance, including the Review_API port, and only from sources inside the Platform_VPC CIDR block or from security groups in the Platform_VPC.
9. THE Platform_IaC SHALL give every private subnet a network path over which a call from an EC2 instance to the `us-west-2` endpoint of each of at least Systems Manager (including Session Manager), Bedrock, AgentCore, S3, DynamoDB, Step Functions, Secrets Manager, STS and CloudWatch (including CloudWatch Logs) receives a response from that service within 10 seconds.
10. WHERE the Optional_ALB is disabled, THE Platform_IaC SHALL create zero public subnets in the Platform_VPC, where a public subnet is a subnet whose route table contains a route to an internet gateway.

### Requirement 6: AgentCore Gateway, Policy, Identity and Memory

**User Story:** As an agent owner, I want the Gateway, Cedar policy, workload identities and memory provisioned with deny-by-default access, so that each agent can call only the tools on its allowed list.

#### Acceptance Criteria

1. THE Platform_IaC SHALL provision the Agent_Gateway with exactly one MCP tool target for each Gateway_Tool that the authoring-agents and decision-memory-history-check specs register, and no other targets.
2. THE Platform_IaC SHALL attach the Gateway_Policy to the Agent_Gateway in `ENFORCE` mode.
3. THE Platform_IaC SHALL configure the Gateway_Policy to deny every tool call for which no permit statement names both the calling Workload_Identity and the requested tool, including every call from a Workload_Identity whose allowed-tool list is empty.
4. THE Platform_IaC SHALL generate exactly one Gateway_Policy permit statement for each tool on each agent's allowed-tool list declared by the authoring-agents and decision-memory-history-check specs, scoped to that agent's Workload_Identity.
5. IF an allowed-tool list declared by the authoring-agents or decision-memory-history-check spec names a tool that is not an Agent_Gateway MCP tool target, THEN THE Deploy_Command SHALL exit with a non-zero status that names the agent and the unregistered tool.
6. THE Platform_IaC SHALL create exactly one Workload_Identity for each agent container declared by the authoring-agents and decision-memory-history-check specs, with no Workload_Identity shared between two containers.
7. THE Platform_IaC SHALL configure the Agent_Gateway to reject every inbound call that does not present an unexpired token issued for a Workload_Identity created by the Platform_IaC.
8. THE Platform_IaC SHALL provision exactly one Agent_Memory resource with a long-term memory strategy.
9. THE Platform_IaC SHALL grant Agent_Memory write actions to the Memory_Writer's Component_Role and to no other Component_Role or instance-profile role.

### Requirement 7: IAM roles, keys and secrets

**User Story:** As the security owner, I want one least-privilege role per component and secrets held only in Secrets Manager, so that a compromised component cannot reach another component's data or the CHT login.

#### Acceptance Criteria

1. THE Platform_IaC SHALL create exactly one Component_Role, used by no other component, for each agent declared by the authoring-agents and decision-memory-history-check specs, the State_Machine, the Decision_Recorder, each Deterministic_Service, the Config_Compiler, the Sandbox_Runner, the cht-deployer (Deployer_Role), the Review_API and the Memory_Writer.
2. THE Platform_IaC SHALL grant each Component_Role only the IAM actions and resource ARNs declared by that component's owning spec, with no wildcard (`*`) in an action or resource ARN unless the owning spec declares that wildcard.
3. THE Platform_IaC SHALL limit each Component_Role's Artifact_Bucket permissions to object keys and list requests under the prefixes declared by that component's owning spec, giving zero Artifact_Bucket access to a Component_Role whose owning spec declares no prefix.
4. THE Platform_IaC SHALL limit the Services_Instance instance-profile role to Systems Manager managed-node access, writing container logs to the platform's CloudWatch Logs log groups, and `sts:AssumeRole` on only the Component_Roles of components hosted on the Services_Instance.
5. THE Platform_IaC SHALL create zero IAM users and zero IAM access keys.
6. WHEN the Deploy_Command runs in an account where the CHT_Login_Secret does not exist, THE Platform_IaC SHALL create the CHT_Login_Secret, encrypted with the Platform_KMS_Key, holding the CHT_Test_Instance admin username and a password of at least 32 characters generated randomly inside Secrets Manager.
7. THE Platform_IaC SHALL grant `secretsmanager:GetSecretValue` on the CHT_Login_Secret to the Deployer_Role and to no other IAM role the Platform_IaC creates, including both EC2 instance-profile roles.
8. THE Platform_IaC SHALL keep `.env` files out of the source repository and every secret value, including the CHT_Login_Secret password, out of the source repository, IaC templates and state, IaC outputs, Deploy_Command console output and the platform's CloudWatch Logs log groups.
9. WHEN the Teardown_Command runs, THE Teardown_Command SHALL delete the CHT_Login_Secret with no recovery window, so that a Deploy_Command run immediately afterwards can create a secret with the same name.
10. THE Platform_IaC SHALL configure each Component_Role's trust policy to allow role assumption only by the principal that runs that component, which is the Step Functions service for the State_Machine's role, the Services_Instance instance-profile role for components hosted on the Services_Instance, and the principal declared by the owning spec for any other component.

### Requirement 8: Approver sign-in and Review UI access

**User Story:** As an approver, I want to sign in through Cognito, either via the optional ALB or a Session Manager tunnel, so that only authenticated approvers reach the review UI.

#### Acceptance Criteria

1. THE Platform_IaC SHALL provision the Approver_User_Pool with exactly the four groups `program_officer`, `program_reviewer`, `clinician` and `it_deploy` and no other groups.
2. THE Platform_IaC SHALL disable self-service sign-up on the Approver_User_Pool so that users can be created only by an administrator through the Cognito admin create-user action.
3. THE Platform_IaC SHALL provision exactly one Approver_User_Pool app client for the Review_API and publish its client ID as a named output.
4. THE Platform_IaC SHALL create the Optional_ALB only when one boolean configuration variable is set to true and create zero Application Load Balancers when that variable is false.
5. WHERE the Optional_ALB is enabled, THE Platform_IaC SHALL configure the Optional_ALB HTTPS listener to authenticate every request against the Approver_User_Pool app client and to forward to the Review_API only requests that authenticate successfully.
6. WHERE the Optional_ALB is enabled, THE Platform_IaC SHALL configure the Optional_ALB with an HTTPS listener on port 443 using the configured ACM certificate and with no listener that forwards unencrypted HTTP requests to the Review_API.
7. WHERE the Optional_ALB is enabled, THE Platform_IaC SHALL register the Services_Instance on the Review_API port as the only target of the Optional_ALB.
8. WHERE the Optional_ALB is disabled, THE Platform_IaC SHALL publish as a named output a complete Session Manager port-forwarding command, with the Services_Instance ID and Review_API port filled in, that an operator can run without edits to forward a local port to the Review_API port on the Services_Instance.
9. WHERE the Optional_ALB is enabled, IF no ACM certificate is configured, THEN THE Deploy_Command SHALL exit with a non-zero status that names the missing certificate configuration value before provisioning any resource.

### Requirement 9: Observability and cost controls

**User Story:** As the owner of Medic's handover, I want every model call, container and agent step logged and traced and every run costed, so that spend stays inside the $500 sandbox and cost per run can be reported in the README.

#### Acceptance Criteria

1. THE Platform_IaC SHALL enable Bedrock model invocation logging in `us-west-2` for every model invocation, delivered to a CloudWatch Logs log group that the Platform_IaC creates.
2. THE Platform_IaC SHALL configure the Services_Instance so that the stdout and stderr of every container started on it reach a CloudWatch Logs log group created by the Platform_IaC within 60 seconds of being written.
3. THE Platform_IaC SHALL enable Agent_Observability for every agent container and grant each agent's Component_Role permission to export OpenTelemetry traces of agent steps, tool calls and token counts to CloudWatch.
4. THE Platform_IaC SHALL enable State_Machine execution logging at log level `ALL` to a CloudWatch Logs log group that the Platform_IaC creates.
5. THE Platform_IaC SHALL create one AWS Budgets monthly cost budget of $500 USD covering all spend in the AWS account, with actual-spend notifications at $250 and $400 sent to every email address in one configuration variable that holds 1 to 10 addresses.
6. THE Platform_IaC SHALL apply the Project_Tag with its configured value to every resource it creates that supports tags, including the EBS volumes and network interfaces created with each EC2 instance.
7. WHERE Build_Hours are configured as a daily start time, end time and timezone, THE Platform_IaC SHALL schedule the Services_Instance and the CHT_Test_Instance to start within 5 minutes after the Build_Hours start time and to stop within 5 minutes after the Build_Hours end time.
8. WHEN an operator runs the Cost_Report for a time range, THE Cost_Report SHALL output, for the model invocation log records timestamped at or after the range start and before the range end, one row per distinct combination of `agent`, `tenant` and `runId` giving input tokens, output tokens and cost in USD at the per-model token prices set in the Cost_Report configuration, followed by a total row that shows zero when no record falls in the range.
9. IF a model invocation log record lacks an `agent`, `tenant` or `runId` value, THEN THE Cost_Report SHALL add that record's tokens and cost to one row labelled `untagged` instead of any `agent`, `tenant` and `runId` row, and include them in the total row.
10. IF the budget alert email configuration variable holds zero addresses or more than 10 addresses, THEN THE Deploy_Command SHALL exit with a non-zero status naming that variable before creating any resource.

### Requirement 10: Day-1 and baseline verification checks

**User Story:** As an operator, I want the day-1 checks and the security baseline as scripts, so that Gateway connectivity and the baseline are proved before the dependent specs build on the platform.

#### Acceptance Criteria

1. THE Platform_Checks SHALL include a Gateway connectivity check that calls each MCP tool target registered on the Agent_Gateway through the Agent_Gateway and reports pass for a target only if that call returns a successful tool response within 30 seconds, otherwise fail for that target.
2. THE Platform_Checks SHALL include a Gateway policy check that passes only if, for a test Workload_Identity, the Agent_Gateway returns an authorization denial for a call to a tool outside that identity's allowed-tool list and a successful tool response for a call to a tool on that list.
3. THE Platform_Checks SHALL include a not-used check that fails if any resource in `us-west-2` that carries the Project_Tag or was created by the Deploy_Command is of a type on the Not_Used_List.
4. THE Platform_Checks SHALL include a network check that fails if any security group carrying the Project_Tag has an inbound rule, from any source, whose protocol and port range include port 22 or port 3389, counting rules that allow all traffic.
5. THE Platform_Checks SHALL include an instance metadata check that fails if any EC2 instance carrying the Project_Tag, whether running or stopped, does not require IMDSv2 session tokens or has a metadata response hop limit other than 2.
6. THE Platform_Checks SHALL include a storage check that fails if the Artifact_Bucket has a versioning status other than Enabled, a default encryption other than SSE-KMS with the Platform_KMS_Key, or any of the four Block Public Access settings not enabled.
7. IF any Platform_Checks check fails, or a check cannot find the bucket, EC2 instance or Agent_Gateway it inspects, THEN THE Platform_Checks SHALL run every remaining check, print each failed check's name with the identifier of every offending or missing resource, and exit with a non-zero status.

## Open Questions

1. Terraform or CDK in TypeScript? The design allows either; this choice fixes the Deploy_Command and Teardown_Command.
2. The prefix names `decision-log/` and `deploy-records/` are assumed. Do they match what the dependent specs expect?
3. How do private subnets reach the internet and AWS APIs? A NAT gateway costs more but the CHT_Test_Instance needs it for image pulls. VPC endpoints alone cost less.
4. How does the Agent_Gateway reach tools on the Services_Instance in a private subnet? The design says this connectivity is not automatic.
5. With IMDS hop limit 2, every container can read the instance-role credentials. How do we stop one agent container from assuming another agent's Component_Role?
6. How is the CHT_Test_Instance admin login set at bootstrap if only the Deployer_Role can read the CHT_Login_Secret?
7. Should the Optional_ALB be on or off by default? An HTTPS listener also needs a domain for the ACM certificate.
8. Who receives the Budgets alerts, and what are the Build_Hours window and timezone?
9. Do IaC-internal helper Lambdas (for example, CDK custom resources that empty buckets) count as "Lambda for application logic"?
10. **Guardrail entity list.** Requirement 3.1 leaves AGE out of the default entity list so that a public guideline full of children's ages is not blocked. Confirm the default list with Medic.
