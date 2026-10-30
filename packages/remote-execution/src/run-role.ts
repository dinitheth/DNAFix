import { CreateRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";

/**
 * Per-run scoped execution roles.
 *
 * Threat model: CodeBuild runs untrusted repository scripts, which can extract
 * the build environment's role credentials. A shared role with bucket-wide S3
 * access would let one run's build read every other run's source bundles.
 * Mitigation: for each run, the trusted control plane creates a short-lived
 * IAM role whose policy is scoped to exactly that run's S3 prefixes, passes it
 * to StartBuild via serviceRoleOverride, and deletes it when the build ends.
 * If role creation fails, the job fails — DNAFix never falls back to the
 * shared project role, which would silently weaken isolation.
 */

export function runRoleName(runId: string): string {
  const sanitized = runId.replaceAll(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);
  return `dnafix-run-${sanitized}`.slice(0, 64);
}

export function buildRunRolePolicy(input: { bucket: string; region: string; accountId: string; logGroupName: string; runId: string }): Record<string, unknown> {
  const prefix = `runs/${input.runId}`;
  const logGroupArn = `arn:aws:logs:${input.region}:${input.accountId}:log-group:${input.logGroupName}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RunSourceReadOnly",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: [`arn:aws:s3:::${input.bucket}/${prefix}/source.zip`, `arn:aws:s3:::${input.bucket}/${prefix}/manifest.json`],
      },
      {
        Sid: "RunArtifactsWrite",
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject"],
        Resource: `arn:aws:s3:::${input.bucket}/${prefix}/artifacts/*`,
      },
      {
        Sid: "RunListBucketScoped",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:GetBucketLocation"],
        Resource: `arn:aws:s3:::${input.bucket}`,
        Condition: { StringLike: { "s3:prefix": ["", "runs/", `${prefix}/`, `${prefix}/*`] } },
      },
      {
        Sid: "RunLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: [logGroupArn, `${logGroupArn}:*`],
      },
    ],
  };
}

export const RUN_ROLE_TRUST_POLICY: Record<string, unknown> = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "codebuild.amazonaws.com" }, Action: "sts:AssumeRole" }],
};

export interface IamOperations {
  createRole(input: { roleName: string; trustPolicy: Record<string, unknown>; policyName: string; policy: Record<string, unknown> }): Promise<{ arn: string }>;
  deleteRole(roleName: string, policyName: string): Promise<void>;
}

export class SdkIamOperations implements IamOperations {
  constructor(private readonly client: IAMClient) {}
  async createRole(input: { roleName: string; trustPolicy: Record<string, unknown>; policyName: string; policy: Record<string, unknown> }): Promise<{ arn: string }> {
    const out = await this.client.send(
      new CreateRoleCommand({
        RoleName: input.roleName,
        AssumeRolePolicyDocument: JSON.stringify(input.trustPolicy),
        Description: "DNAFix per-run CodeBuild execution role (short-lived, run-scoped)",
        Tags: [
          { Key: "Project", Value: "DNAFix" },
          { Key: "Ephemeral", Value: "true" },
        ],
      }),
    );
    if (!out.Role?.Arn) throw new Error(`CreateRole for ${input.roleName} returned no ARN`);
    await this.client.send(new PutRolePolicyCommand({ RoleName: input.roleName, PolicyName: input.policyName, PolicyDocument: JSON.stringify(input.policy) }));
    return { arn: out.Role.Arn };
  }
  async deleteRole(roleName: string, policyName: string): Promise<void> {
    await this.client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName })).catch(() => undefined);
    await this.client.send(new DeleteRoleCommand({ RoleName: roleName }));
  }
}

export class RunRoleManager {
  readonly policyName = "dnafix-run-scoped";
  constructor(
    private readonly iam: IamOperations,
    private readonly scope: { bucket: string; region: string; accountId: string; logGroupName: string },
    private readonly propagationDelayMs = 8_000,
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async createRunRole(runId: string): Promise<{ roleName: string; arn: string }> {
    const roleName = runRoleName(runId);
    const { arn } = await this.iam.createRole({
      roleName,
      trustPolicy: RUN_ROLE_TRUST_POLICY,
      policyName: this.policyName,
      policy: buildRunRolePolicy({ ...this.scope, runId }),
    });
    // IAM is eventually consistent; give the new role a moment to propagate before CodeBuild assumes it.
    if (this.propagationDelayMs > 0) await this.sleepFn(this.propagationDelayMs);
    return { roleName, arn };
  }

  async deleteRunRole(roleName: string): Promise<boolean> {
    try {
      await this.iam.deleteRole(roleName, this.policyName);
      return true;
    } catch {
      return false;
    }
  }
}
