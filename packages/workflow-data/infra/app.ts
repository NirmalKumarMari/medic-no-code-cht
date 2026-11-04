import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App, BootstraplessSynthesizer, CfnOutput, RemovalPolicy, Stack, Tags, aws_dynamodb as dynamodb } from 'aws-cdk-lib';

const app = new App({ outdir: resolve('.artifacts/cdk') });
const stackName = process.env.WORKFLOW_STACK_NAME ?? 'vera-workflow-data';
const prefix = process.env.WORKFLOW_TABLE_PREFIX ?? 'vera-workflow';
if (!/^[a-zA-Z][a-zA-Z0-9-]{0,70}$/.test(stackName) || !/^[a-zA-Z][a-zA-Z0-9-]{0,70}$/.test(prefix)) throw new Error('Invalid resource prefix');
const stack = new Stack(app, stackName, { synthesizer: new BootstraplessSynthesizer(),
  env: { region: process.env.AWS_REGION ?? 'us-west-2', account: process.env.CDK_DEFAULT_ACCOUNT },
  description: 'Vera workflow persistence: four encrypted on-demand DynamoDB tables; no IAM roles or public access.' });
Tags.of(stack).add('Project', 'vera-cht'); Tags.of(stack).add('Component', 'workflow-data'); Tags.of(stack).add('Environment', 'hackathon');
for (const kind of ['Changes', 'Approvals', 'Audit', 'Tokens']) {
  const table = new dynamodb.Table(stack, kind, {
    tableName: `${prefix}-${kind}`, partitionKey: { name: 'changeId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    encryption: dynamodb.TableEncryption.AWS_MANAGED, deletionProtection: true, removalPolicy: RemovalPolicy.RETAIN,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    ...(kind === 'Tokens' ? { timeToLiveAttribute: 'cleanupAt' } : {}),
  });
  if (kind === 'Changes') table.addGlobalSecondaryIndex({ indexName: 'ReviewInboxIndex',
    partitionKey: { name: 'inbox', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'inboxSort', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL });
  if (kind === 'Tokens') table.addGlobalSecondaryIndex({ indexName: 'CallbackDeliveryIndex',
    partitionKey: { name: 'callbackQueue', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'callbackDueAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.KEYS_ONLY });
  new CfnOutput(stack, `${kind}TableName`, { value: table.tableName });
  new CfnOutput(stack, `${kind}TableArn`, { value: table.tableArn });
}
const assembly = app.synth();
const template = assembly.getStackArtifact(stack.artifactId).template;
const resourceTypes = Object.values(template.Resources as Record<string, { Type: string }>).map(v => v.Type);
if (resourceTypes.length !== 4 || resourceTypes.some(v => v !== 'AWS::DynamoDB::Table')) throw new Error('Unexpected infrastructure resource outside database scope');
mkdirSync('.artifacts', { recursive: true });
writeFileSync('.artifacts/vera-workflow-data.template.json', JSON.stringify(template, null, 2) + '\n');
console.log('Synthesized .artifacts/vera-workflow-data.template.json (four DynamoDB tables; no IAM changes).');
