import { idSchema, requireData, type Tables } from './model.js';

/** Names only; credentials come from the AWS SDK default provider / EC2 task role. */
export function tablesFromEnvironment(env: NodeJS.ProcessEnv = process.env): Tables {
  const prefix = env.WORKFLOW_TABLE_PREFIX ?? 'vera-workflow';
  const names = { changes: env.CHANGES_TABLE ?? `${prefix}-Changes`, approvals: env.APPROVALS_TABLE ?? `${prefix}-Approvals`,
    audit: env.AUDIT_TABLE ?? `${prefix}-Audit`, tokens: env.TOKENS_TABLE ?? `${prefix}-Tokens` };
  for (const name of Object.values(names)) requireData(/^[A-Za-z0-9_.-]{3,255}$/.test(name), 'CONFIGURATION', 'Invalid DynamoDB table name');
  requireData(new Set(Object.values(names)).size === 4, 'CONFIGURATION', 'Four different tables are required');
  return names;
}
export function callbackTenants(env: NodeJS.ProcessEnv = process.env): string[] {
  const tenants = [...new Set((env.WORKFLOW_TENANT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  requireData(tenants.length > 0, 'CONFIGURATION', 'WORKFLOW_TENANT_IDS is required; never discover tenants through a Tokens Scan');
  for (const tenant of tenants) idSchema.parse(tenant);
  return tenants;
}
