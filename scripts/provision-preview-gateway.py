"""Provision the preview-only IAM AgentCore Gateway and its three storage tools."""
import json
from pathlib import Path
import boto3

outputs_file = Path('/tmp/vera-preview-outputs.json')
out = json.loads(outputs_file.read_text())
account, region = out['Account'], 'us-west-2'
bucket = 'arn:aws:s3:::' + out['ArtifactBucket']
ref = lambda name: {'Ref':name}
att = lambda name, attr='Arn': {'Fn::GetAtt':[name,attr]}

def statement(actions, resources):
    return {'Effect':'Allow','Action':actions,'Resource':resources}

def role(service, rules, managed=None):
    props = {'AssumeRolePolicyDocument':{'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':service},'Action':'sts:AssumeRole'}]},
             'Policies':[{'PolicyName':'PreviewOnly','PolicyDocument':{'Version':'2012-10-17','Statement':rules}}]}
    if managed:props['ManagedPolicyArns']=managed
    return {'Type':'AWS::IAM::Role','Properties':props}

read = [f'{bucket}/proposals/gateway-input/*', f'{bucket}/proposals/gateway-output/*', f'{bucket}/snapshots/*/intake/*']
write = [f'{bucket}/proposals/gateway-output/*', f'{bucket}/snapshots/*/intake/*']
function_name = 'vera-preview-agent-tool-target'
function_arn = f'arn:aws:lambda:{region}:{account}:function:{function_name}'

def tool(name, description, *keys):
    return {'Name':name,'Description':description,'InputSchema':{'Type':'object','Properties':{key:{'Type':'string'} for key in keys},'Required':list(keys)}}

resources = {
 'TargetRole':role('lambda.amazonaws.com', [statement(['s3:GetObject'],read),statement(['s3:PutObject'],write),statement(['kms:Decrypt','kms:GenerateDataKey'],[out['KmsKeyArn']])],['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']),
 'Function':{'Type':'AWS::Lambda::Function','Properties':{'FunctionName':function_name,'Runtime':'python3.12','Handler':'index.handler','Role':att('TargetRole'),'Timeout':15,'Code':{'ZipFile':Path('scripts/preview-agent-tools.py').read_text()},'Environment':{'Variables':{'ARTIFACT_BUCKET':out['ArtifactBucket'],'KMS_KEY_ARN':out['KmsKeyArn']}}}},
 'GatewayRole':role('bedrock-agentcore.amazonaws.com',[statement(['lambda:InvokeFunction'],[function_arn])]),
 'Gateway':{'Type':'AWS::BedrockAgentCore::Gateway','Properties':{'Name':'vera-preview-agent-tools','RoleArn':att('GatewayRole'),'AuthorizerType':'AWS_IAM','ProtocolType':'MCP'}},
 'Target':{'Type':'AWS::BedrockAgentCore::GatewayTarget','Properties':{'Name':'previewtools','GatewayIdentifier':ref('Gateway'),'CredentialProviderConfigurations':[{'CredentialProviderType':'GATEWAY_IAM_ROLE'}],
     'TargetConfiguration':{'Mcp':{'Lambda':{'LambdaArn':att('Function'),'ToolSchema':{'InlinePayload':[
       tool('get_baseline','Read the hash-pinned baseline prepared for this isolated edit run.','changeId','snapshotHash'),
       tool('write_spec_draft','Store one unapproved intake draft.','draftJson'),
       tool('write_proposal_draft','Store one unapproved change proposal.','draftJson'),
     ]}}}}}},
 'WorkerGatewayPolicy':{'Type':'AWS::IAM::Policy','Properties':{'PolicyName':'VeraPreviewInvokeAgentTools','Roles':[out['WorkerRoleArn'].rsplit('/',1)[-1]],'PolicyDocument':{'Version':'2012-10-17','Statement':[statement(['bedrock-agentcore:InvokeGateway'],[att('Gateway','GatewayArn')])]}}},
}
template={'AWSTemplateFormatVersion':'2010-09-09','Resources':resources,'Outputs':{'AgentCoreGatewayUrl':{'Value':att('Gateway','GatewayUrl')},'AgentCoreGatewayArn':{'Value':att('Gateway','GatewayArn')}}}
cf=boto3.client('cloudformation',region_name=region)
stack='VeraPreviewAgentTools'
try:
    cf.describe_stacks(StackName=stack)
except cf.exceptions.ClientError:
    cf.create_stack(StackName=stack,TemplateBody=json.dumps(template),Capabilities=['CAPABILITY_IAM'])
print('AgentCore Gateway stack submitted',flush=True)
cf.get_waiter('stack_create_complete').wait(StackName=stack,WaiterConfig={'Delay':5,'MaxAttempts':30})
values={x['OutputKey']:x['OutputValue'] for x in cf.describe_stacks(StackName=stack)['Stacks'][0]['Outputs']}
outputs_file.write_text(json.dumps({**out,**values}))
print('AgentCore Gateway ready',flush=True)
