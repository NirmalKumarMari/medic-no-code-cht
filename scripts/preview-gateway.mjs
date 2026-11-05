import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';

export function gatewayTools({ url, region, credentials }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith(`.gateway.bedrock-agentcore.${region}.amazonaws.com`) || endpoint.pathname !== '/mcp') {
    throw Error('Expected the isolated regional AgentCore Gateway URL');
  }
  const signer = new SignatureV4({ credentials, region, service: 'bedrock-agentcore', sha256: Sha256 });
  async function call(name, args) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `previewtools___${name}`, arguments: args } });
    const request = await signer.sign(new HttpRequest({
      protocol: 'https:', hostname: endpoint.hostname, path: endpoint.pathname, method: 'POST', body,
      headers: { host: endpoint.hostname, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    }));
    const response = await fetch(endpoint, { method: request.method, headers: request.headers, body, signal: AbortSignal.timeout(18000), redirect: 'error' });
    if (!response.ok) throw Error(`AgentCore Gateway returned HTTP ${response.status}`);
    const text = await response.text();
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(value => value.id === 1)
      : JSON.parse(text);
    if (!payload?.result || payload.error || payload.result.isError) throw Error(`AgentCore rejected tool ${name}`);
    const value = payload.result.structuredContent ?? JSON.parse(payload.result.content.find(item => item.type === 'text').text);
    return value;
  }
  return {
    async storeSpec(spec) {
      const result = await call('write_spec_draft', { draftJson: JSON.stringify(spec) });
      if (result.status !== 'draft_stored') throw Error('Spec storage receipt missing');
    },
    getBaselineSnapshot: ({ snapshotHash }, changeId) => call('get_baseline', { snapshotHash, changeId }),
    async writeChangePlanDraft(plan) {
      const result = await call('write_proposal_draft', { draftJson: JSON.stringify(plan) });
      if (result.status !== 'draft_stored' || result.snapshotHash !== plan.snapshotHash || result.snapshotId !== plan.snapshotId) throw Error('Proposal storage receipt mismatch');
    },
  };
}
