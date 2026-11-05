"""AgentCore Lambda target for bounded draft-only storage and a pinned baseline read."""
import hashlib
import json
import os
import re

import boto3
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
bucket = os.environ['ARTIFACT_BUCKET']
kms = os.environ['KMS_KEY_ARN']


def identifier(value, pattern):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError('Invalid artifact identity')
    return value


def put(key, data):
    body = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    if len(body) > 160_000:
        raise ValueError('Draft tool payload exceeds limit')
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType='application/json',
                      ServerSideEncryption='aws:kms', SSEKMSKeyId=kms, IfNoneMatch='*')
    except ClientError as e:
        if e.response['Error']['Code'] != 'PreconditionFailed':
            raise
        if s3.get_object(Bucket=bucket, Key=key)['Body'].read() != body:
            raise ValueError('Draft write conflicts with an existing immutable artifact') from None


def handler(event, context):
    tool = context.client_context.custom['bedrockAgentCoreToolName'].split('___')[-1]
    uuid_pattern = r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
    if tool == 'get_baseline':
        change = identifier(event['changeId'], uuid_pattern)
        snapshot = identifier(event['snapshotHash'], r'[a-f0-9]{64}')
        key = f'proposals/gateway-input/{change}/{snapshot}.json'
        return json.loads(s3.get_object(Bucket=bucket, Key=key)['Body'].read())
    if tool == 'write_spec_draft':
        spec = json.loads(event['draftJson'])
        change = identifier(spec['changeId'], uuid_pattern)
        digest = hashlib.sha256(event['draftJson'].encode()).hexdigest()
        put(f'snapshots/{change}/intake/{digest}.json', spec)
        return {'status': 'draft_stored'}
    if tool == 'write_proposal_draft':
        plan = json.loads(event['draftJson'])
        change = identifier(plan['changeId'], uuid_pattern)
        snapshot = identifier(plan['snapshotHash'], r'[a-f0-9]{64}')
        if plan['approvalStatus'] != 'unapproved':
            raise ValueError('Only unapproved drafts may be stored')
        put(f'proposals/gateway-output/{change}/{snapshot}.json', plan)
        return {'status': 'draft_stored', 'snapshotId': plan['snapshotId'], 'snapshotHash': snapshot}
    raise ValueError('Unknown tool')
