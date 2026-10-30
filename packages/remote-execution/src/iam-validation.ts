/**
 * Least-privilege validation for the CodeBuild execution role policy.
 * Pure and offline: given a policy document, verify that every Allow statement
 * uses only the actions the execution role needs and is scoped to the DNAFix
 * bucket / log group. Wildcard resources or extra actions are findings.
 */
export interface PolicyStatement {
  Effect?: string;
  Action?: string | string[];
  Resource?: string | string[];
}

export interface PolicyDocument {
  Statement?: PolicyStatement[];
}

export const EXECUTION_ROLE_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  "logs:CreateLogGroup",
  "logs:CreateLogStream",
  "logs:PutLogEvents",
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "s3:GetObjectVersion",
  "s3:ListBucket",
  "s3:GetBucketLocation",
]);

export function validateExecutionRolePolicy(
  policy: PolicyDocument,
  expected: { bucket: string; region: string; accountId: string; logGroupName: string },
): { valid: boolean; findings: string[] } {
  const findings: string[] = [];
  const bucketArn = `arn:aws:s3:::${expected.bucket}`;
  const logGroupArn = `arn:aws:logs:${expected.region}:${expected.accountId}:log-group:${expected.logGroupName}`;
  const statements = policy.Statement ?? [];
  if (statements.length === 0) findings.push("policy has no statements");
  for (const [i, statement] of statements.entries()) {
    if (statement.Effect !== "Allow") continue;
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action ?? ""];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource ?? ""];
    for (const action of actions) {
      if (!EXECUTION_ROLE_ALLOWED_ACTIONS.has(action)) findings.push(`statement ${i}: action not in execution allowlist: ${action}`);
    }
    for (const resource of resources) {
      if (resource === "*" || resource.endsWith(":*") && !resource.startsWith(bucketArn) && !resource.startsWith(logGroupArn)) {
        findings.push(`statement ${i}: wildcard resource not scoped to DNAFix bucket/log group: ${resource}`);
      } else if (!resource.startsWith(bucketArn) && !resource.startsWith(logGroupArn)) {
        findings.push(`statement ${i}: resource outside DNAFix bucket/log group: ${resource}`);
      }
    }
  }
  return { valid: findings.length === 0, findings };
}

/** Parse an IAM policy document as returned by GetRolePolicy (URL-encoded JSON). */
export function parsePolicyDocument(encoded: string): PolicyDocument {
  return JSON.parse(decodeURIComponent(encoded)) as PolicyDocument;
}
