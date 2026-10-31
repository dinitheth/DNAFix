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

interface ControlPlaneStatement extends PolicyStatement {
  Condition?: Record<string, Record<string, string | string[]>>;
}

/**
 * Least-privilege validation for the DNAFix CONTROL-PLANE identity policy
 * (distinct from the per-run build role). Verifies that IAM role management is
 * confined to dnafix-run-* roles, PassRole is confined to CodeBuild, and
 * CodeBuild/S3/Logs access is confined to the designated project/bucket/group.
 */
export function validateControlPlanePolicy(
  policy: { Statement?: ControlPlaneStatement[] },
  expected: { bucket: string; region: string; accountId: string; logGroupName: string; projectName: string },
): { valid: boolean; findings: string[] } {
  const findings: string[] = [];
  const runRoleArn = `arn:aws:iam::${expected.accountId}:role/dnafix-run-*`;
  const projectArn = `arn:aws:codebuild:${expected.region}:${expected.accountId}:project/${expected.projectName}`;
  const bucketArn = `arn:aws:s3:::${expected.bucket}`;
  const logGroupArn = `arn:aws:logs:${expected.region}:${expected.accountId}:log-group:${expected.logGroupName}`;
  const statements = policy.Statement ?? [];
  let passRoleScoped = false;
  for (const [i, statement] of statements.entries()) {
    if (statement.Effect !== "Allow") continue;
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action ?? ""];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource ?? ""];
    for (const action of actions) {
      if (action === "*" || action.endsWith(":*")) findings.push(`statement ${i}: wildcard action ${action}`);
      // iam:ListRoles cannot be resource-scoped in IAM (documented exception, read-only discovery).
      if (action !== "iam:ListRoles" && action.startsWith("iam:") && !resources.every((r) => r === runRoleArn)) {
        findings.push(`statement ${i}: IAM action ${action} is not confined to ${runRoleArn}`);
      }
      if (action === "iam:PassRole") {
        const passedTo = statement.Condition?.StringEquals?.["iam:PassedToService"];
        if (passedTo === "codebuild.amazonaws.com" && resources.every((r) => r === runRoleArn)) passRoleScoped = true;
        else findings.push(`statement ${i}: iam:PassRole lacks iam:PassedToService=codebuild.amazonaws.com scoped to per-run roles`);
      }
      if (action.startsWith("codebuild:") && !resources.every((r) => r === projectArn || r === "*".replace("*", projectArn))) {
        if (!resources.every((r) => r === projectArn)) findings.push(`statement ${i}: CodeBuild action ${action} is not confined to the designated project`);
      }
      if (action.startsWith("s3:") && !resources.every((r) => r.startsWith(bucketArn))) {
        findings.push(`statement ${i}: S3 action ${action} is not confined to the DNAFix bucket`);
      }
      if (action.startsWith("logs:") && !resources.every((r) => r.startsWith(logGroupArn))) {
        findings.push(`statement ${i}: Logs action ${action} is not confined to the DNAFix log group`);
      }
    }
  }
  if (!passRoleScoped) findings.push("no correctly scoped iam:PassRole statement found");
  return { valid: findings.length === 0, findings };
}
