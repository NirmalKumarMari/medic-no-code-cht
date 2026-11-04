function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8082),
  region: required("AWS_REGION", "us-west-2"),
  // Defaults are the existing tables from infra/workflow-data-stack.ts.
  tables: {
    changes: required("CHANGES_TABLE_NAME", "vera-workflow-Changes"),
    approvals: required("APPROVALS_TABLE_NAME", "vera-workflow-Approvals"),
    audit: required("AUDIT_TABLE_NAME", "vera-workflow-Audit"),
    tokens: required("TOKENS_TABLE_NAME", "vera-workflow-Tokens"),
  },
};
