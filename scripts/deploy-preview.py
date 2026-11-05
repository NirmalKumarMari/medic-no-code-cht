"""Deploy the isolated preview. Run from the preview worktree after build and CDK provisioning."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile

import boto3

region = 'us-west-2'
session = boto3.Session(region_name=region)
outputs = json.loads(Path('/tmp/vera-preview-outputs.json').read_text())
account = outputs['Account']
bucket = outputs['ArtifactBucket']
key_arn = outputs['KmsKeyArn']
instance = 'i-04f06fd9fd07305b3'
base_url = 'https://d3kk07plry56g2.cloudfront.net'
app_dir = '/workshop/vera-preview'
stack = 'VeraPreviewPipeline'
outdir = '/tmp/vera-preview-cdk'
subprocess.run(['node_modules/.bin/tsx','infra/preview-app.ts'],check=True,env={**os.environ,
    'CDK_DEFAULT_ACCOUNT':account,'CDK_OUTDIR':outdir,'PREVIEW_BUCKET_ARN':'arn:aws:s3:::'+bucket,
    'PREVIEW_KEY_ARN':key_arn,'PREVIEW_GUARDRAIL_ARN':f"arn:aws:bedrock:{region}:{account}:guardrail/{outputs['GuardrailId']}",
    'PREVIEW_WORKSHOP_ROLE_ARN':f'arn:aws:iam::{account}:role/WSParticipantRole'})
cf = session.client('cloudformation')
try:
    cf.update_stack(StackName=stack,TemplateBody=Path(f'{outdir}/{stack}.template.json').read_text(),Capabilities=['CAPABILITY_IAM'])
    print('Preview workflow update started',flush=True)
except cf.exceptions.ClientError as e:
    if 'No updates are to be performed' not in str(e): raise

with tempfile.TemporaryDirectory() as tmp:
    archive = Path(tmp) / 'runtime.tar.gz'
    paths = [Path('package.json'),Path('package-lock.json'),Path('scripts/preview-worker.mjs'),Path('scripts/preview-cht.mjs'),Path('scripts/preview-cht-harness.cjs'),Path('scripts/serve-review.mjs')]
    for directory in [Path('schemas'),Path('mvp-prototype'),*Path('packages').iterdir(),*Path('agents').iterdir(),*Path('workers').iterdir()]:
        if (directory/'package.json').exists(): paths.extend([directory/'package.json',directory/'dist'])
    with tarfile.open(archive,'w:gz') as tar:
        for path in paths:
            if not path.exists(): raise ValueError(f'Missing build output: {path}')
            tar.add(path,arcname=str(path))
    data = archive.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    key = f'builds/preview-runtime/{digest}.tar.gz'
    s3 = session.client('s3')
    try:
        s3.put_object(Bucket=bucket,Key=key,Body=data,IfNoneMatch='*',ServerSideEncryption='aws:kms',SSEKMSKeyId=key_arn)
    except s3.exceptions.ClientError as e:
        if e.response['Error']['Code'] not in ('PreconditionFailed','412'): raise

env = {
 'AWS_REGION':region,'AWS_PROFILE':'vera-preview-worker','AWS_CONFIG_FILE':f'{app_dir}/aws-config','AWS_SHARED_CREDENTIALS_FILE':'/dev/null',
 'REVIEW_MODE':'aws','REVIEW_HOST':'127.0.0.1','REVIEW_PORT':'3005','REVIEW_AUTH_MODE':'demo','REVIEW_DEMO_TENANT':'vera-preview',
 'REVIEW_ALLOWED_ORIGINS':base_url,'WORKFLOW_TABLE_PREFIX':'vera-preview','WORKFLOW_TENANT_IDS':'vera-preview',
 'WORKFLOW_ARTIFACT_BUCKET':bucket,'KMS_KEY_ARN':key_arn,'GUARDRAIL_ID':outputs['GuardrailId'],'GUARDRAIL_VERSION':outputs['GuardrailVersion'],
 'BEDROCK_GUARDRAIL_ID':outputs['GuardrailId'],'BEDROCK_GUARDRAIL_VERSION':outputs['GuardrailVersion'],
 'REVIEW_PIPELINE_ARN':outputs['StateMachineArn'],'REVIEW_WORK_QUEUE_URL':outputs['WorkQueueUrl'],
 'PREVIEW_PDF_PYTHON':f'{app_dir}/pdf-venv/bin/python3','CHANGEPLAN_PROMPT_CACHING':'false',
}
env['PREVIEW_CHT_TOOLCHAIN'] = f'{app_dir}/cht-toolchain'
env['PREVIEW_CHT_IMAGE'] = os.environ['PREVIEW_CHT_IMAGE']
config = '[profile vera-preview-worker]\nrole_arn='+outputs['WorkerRoleArn']+'\ncredential_source=Ec2InstanceMetadata\nregion='+region+'\n'
release=f'{app_dir}/releases/{digest[:20]}'
lines=['set -euo pipefail',f'install -d -o participant -g participant {release}',
 f'aws s3 cp {shlex.quote(f"s3://{bucket}/{key}")} {release}/runtime.tar.gz --region {region}',
 f'tar xzf {release}/runtime.tar.gz -C {release}',f'chown -R participant:participant {release}',
 f'su -s /bin/bash participant -c "cd {release} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund"',
 f'if [ ! -x {app_dir}/pdf-venv/bin/python3 ]; then su -s /bin/bash participant -c "python3 -m venv {app_dir}/pdf-venv && {app_dir}/pdf-venv/bin/pip -q install pypdf"; fi',
 f'rm -f /workshop/vera-preview-session.json',
 f'ln -sfn {release} {app_dir}/current',
]
def put(path,content): lines.extend([f"cat > {path} <<'VERA_FILE'",content,'VERA_FILE'])
put(f'{app_dir}/runtime.env','\n'.join(f'{k}={v}' for k,v in env.items()))
put(f'{app_dir}/aws-config',config)
lines.append(f'chown participant:participant {app_dir}/runtime.env {app_dir}/aws-config && chmod 600 {app_dir}/runtime.env {app_dir}/aws-config')
for name,command in {'api':'packages/review-api/dist/server.js','queue':'scripts/preview-worker.mjs','callbacks':'packages/workflow-data/dist/scripts/dispatch-callbacks.js','gateway':'scripts/serve-review.mjs'}.items():
    settings=(f'EnvironmentFile={app_dir}/runtime.env' if name!='gateway' else
      f'Environment=REVIEW_UI_DIR={app_dir}/current/mvp-prototype/dist\nEnvironment=REVIEW_UI_BASE=/vera-preview/\nEnvironment=REVIEW_UI_PORT=5175\nEnvironment=REVIEW_API_TARGET=http://127.0.0.1:3005\nEnvironment=AWS_EC2_METADATA_DISABLED=true')
    put(f'/etc/systemd/system/vera-preview-{name}.service',f'[Unit]\nDescription=Vera isolated preview {name}\nAfter=network-online.target\n[Service]\nUser=participant\nWorkingDirectory={app_dir}/current\n{settings}\nExecStart=/usr/bin/node {app_dir}/current/{command}\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nProtectHome=true\n[Install]\nWantedBy=multi-user.target')
lines.extend(['systemctl daemon-reload','systemctl enable vera-preview-{api,queue,callbacks,gateway}','systemctl restart vera-preview-{api,queue,callbacks,gateway}',
 'curl -fsS --retry 12 --retry-delay 1 --retry-connrefused http://127.0.0.1:3005/api/auth/config',
 'curl -fsS http://127.0.0.1:5175/vera-preview/ >/dev/null'])
put('/etc/nginx/vera-preview-location.inc','''location ^~ /vera-preview/ {
    client_max_body_size 51m;
    proxy_read_timeout 70s;
    proxy_pass http://127.0.0.1:5175;
}''')
lines.extend(["python3 - <<'PATCH'",'''from pathlib import Path
config = next(p for p in Path('/etc/nginx/conf.d').glob('*.conf') if 'server_name web-ide;' in p.read_text())
s = config.read_text()
if 'include /etc/nginx/vera-preview-location.inc;' not in s:
    config.write_text(s.replace('    server_name web-ide;', '    server_name web-ide;\\n    include /etc/nginx/vera-preview-location.inc;', 1))
'''.replace('\\\\n','\\n'),'PATCH','nginx -t','systemctl reload nginx','systemctl is-active vera-preview-{api,queue,callbacks,gateway}'])
ssm=session.client('ssm')
response=ssm.send_command(InstanceIds=[instance],DocumentName='AWS-RunShellScript',Parameters={'commands':['\n'.join(lines)],'executionTimeout':['400']},Comment='Install isolated Vera preview services alongside original demo')
command=response['Command']['CommandId']
Path('/tmp/vera-preview-deploy-id').write_text(command)
print('EC2 preview deployment:',command,flush=True)
