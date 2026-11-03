function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8082),
  region: required("AWS_REGION", "us-west-2"),
  tables: {
    changes: required("CHANGES_TABLE_NAME", "Changes"),
    approvals: required("APPROVALS_TABLE_NAME", "Approvals"),
    audit: required("AUDIT_TABLE_NAME", "Audit"),
    tokens: required("TOKENS_TABLE_NAME", "Tokens"),
  },
};
