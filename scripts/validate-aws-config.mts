/**
 * Stage B — read-only AWS configuration validation. Makes NO changes and
 * starts NO builds. Verifies identity, region, bucket, project, role policy
 * (against the least-privilege validator), log group and concurrency quota.
 * Usage: tsx scripts/validate-aws-config.mts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateExecutionRolePolicy, type PolicyDocument } from "@dnafix/remote-execution";

const exec = promisify(execFile);
const profile = process.env.AWS_PROFILE ?? "dnafix-dev";
const region = process.env.AWS_REGION ?? "ap-southeast-2";
const bucket = process.env.AWS_ARTIFACT_BUCKET ?? process.env.AWS_ARTIFACTS_BUCKET ?? "dnafix-artifacts-121728644078";
const project = process.env.AWS_CODEBUILD_PROJECT ?? "dnafix-build";
const logGroup = process.env.AWS_CLOUDWATCH_LOG_GROUP ?? "/aws/codebuild/dnafix-build";

async function aws(args: string[]): Promise<unknown> {
  const { stdout } = await exec("aws", [...args, "--profile", profile, "--output", "json"], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout) as unknown;
}

const identity = (await aws(["sts", "get-caller-identity"])) as { Account: string; Arn: string };
const projectInfo = (await aws(["codebuild", "batch-get-projects", "--names", project, "--region", region])) as {
  projects: Array<{ environment: { computeType: string; privilegedMode: boolean }; timeoutInMinutes: number; concurrentBuildLimit: number; serviceRole: string }>;
};
const roleName = projectInfo.projects[0]!.serviceRole.split("/").pop()!;
const policyNames = (await aws(["iam", "list-role-policies", "--role-name", roleName])) as { PolicyNames: string[] };
let iamValidation: unknown = "no inline policies found";
if (policyNames.PolicyNames[0]) {
  const policy = (await aws(["iam", "get-role-policy", "--role-name", roleName, "--policy-name", policyNames.PolicyNames[0]])) as { PolicyDocument: PolicyDocument };
  iamValidation = validateExecutionRolePolicy(policy.PolicyDocument, { bucket, region, accountId: identity.Account, logGroupName: logGroup });
}
const quota = (await aws(["service-quotas", "get-service-quota", "--service-code", "codebuild", "--quota-code", "L-9D07B6EF", "--region", region])) as { Quota: { Value: number } };

console.log(
  JSON.stringify(
    {
      identity: { account: identity.Account, arn: identity.Arn },
      region,
      project: {
        name: project,
        computeType: projectInfo.projects[0]!.environment.computeType,
        privilegedMode: projectInfo.projects[0]!.environment.privilegedMode,
        timeoutInMinutes: projectInfo.projects[0]!.timeoutInMinutes,
        concurrentBuildLimit: projectInfo.projects[0]!.concurrentBuildLimit,
        serviceRole: projectInfo.projects[0]!.serviceRole,
      },
      bucket,
      logGroup,
      iamValidation,
      codebuildConcurrencyQuotaLinuxSmall: quota.Quota.Value,
      note: "Read-only validation only. No builds were started. A quota of 0 means StartBuild will fail with AccountLimitExceededException until AWS approves the pending increase.",
    },
    null,
    2,
  ),
);
