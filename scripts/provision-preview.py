import boto3,subprocess,os,json,time,pathlib
s=boto3.Session(region_name='us-west-2'); cf=s.client('cloudformation'); a=s.client('sts').get_caller_identity()['Account']; role=f'arn:aws:iam::{a}:role/WSParticipantRole'; out=pathlib.Path('/tmp/vera-preview-cdk')
env={**os.environ,'CDK_DEFAULT_ACCOUNT':a,'PREVIEW_BUCKET_ARN':'arn:aws:s3:::vera-preview-pending','PREVIEW_KEY_ARN':f'arn:aws:kms:us-west-2:{a}:key/pending','PREVIEW_GUARDRAIL_ARN':f'arn:aws:bedrock:us-west-2:{a}:guardrail/pending','PREVIEW_WORKSHOP_ROLE_ARN':role,'CDK_OUTDIR':str(out)}
def synth(): subprocess.run(['node_modules/.bin/tsx','infra/preview-app.ts'],check=True,env=env)
def create(n):
 existing=cf.list_stacks(StackStatusFilter=['CREATE_IN_PROGRESS','CREATE_COMPLETE','UPDATE_COMPLETE'])['StackSummaries']
 if not any(x['StackName']==n for x in existing):cf.create_stack(StackName=n,TemplateBody=(out/f'{n}.template.json').read_text(),Capabilities=['CAPABILITY_IAM'],OnFailure='ROLLBACK')
 print(n,'submitted',flush=True)
def outputs(n):
 cf.get_waiter('stack_create_complete').wait(StackName=n,WaiterConfig={'Delay':5,'MaxAttempts':45}); return {x['OutputKey']:x['OutputValue'] for x in cf.describe_stacks(StackName=n)['Stacks'][0].get('Outputs',[])}
synth();create('VeraPreviewStorage');create('VeraPreviewData');st=outputs('VeraPreviewStorage');print('Storage ready',flush=True)
env.update(PREVIEW_BUCKET_ARN='arn:aws:s3:::'+st['ArtifactBucket'],PREVIEW_KEY_ARN=st['KmsKeyArn'],PREVIEW_GUARDRAIL_ARN=f"arn:aws:bedrock:us-west-2:{a}:guardrail/{st['GuardrailId']}");synth();create('VeraPreviewPipeline');pi=outputs('VeraPreviewPipeline');outputs('VeraPreviewData');pathlib.Path('/tmp/vera-preview-outputs.json').write_text(json.dumps({**st,**pi,'Account':a}));print('Preview infrastructure ready',flush=True)
