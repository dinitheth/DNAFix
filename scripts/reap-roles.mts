/**
 * Manual orphan-role reconciliation pass: `pnpm roles:reap`.
 * Discovers abandoned dnafix-run-* roles, quarantines them, and deletes only
 * those past their quarantine deadline with no active build. Requires AWS
 * credentials (SDK default chain) and AWS_ACCOUNT_ID/AWS_ARTIFACT_BUCKET.
 * Safe to run repeatedly (idempotent, locked).
 */
import path from "node:path";
import { IAMClient } from "@aws-sdk/client-iam";
import { FileCleanupStore, FileLock, RoleReaper, RunRoleManager, SdkIamOperations, createAwsReaperPorts } from "@dnafix/remote-execution";

const accountId = process.env.AWS_ACCOUNT_ID ?? "";
const bucket = process.env.AWS_ARTIFACT_BUCKET ?? process.env.AWS_ARTIFACTS_BUCKET ?? "";
if (!accountId || !bucket) {
  console.error("roles:reap BLOCKED: AWS_ACCOUNT_ID and AWS_ARTIFACT_BUCKET are required. Nothing was changed.");
  process.exit(2);
}
const region = process.env.AWS_REGION ?? "ap-southeast-2";
const dataDir = process.env.DNAFIX_DATA_DIR ?? path.resolve(process.cwd(), ".data");
const manager = new RunRoleManager(new SdkIamOperations(new IAMClient({ region })), {
  bucket,
  region,
  accountId,
  logGroupName: process.env.AWS_CLOUDWATCH_LOG_GROUP ?? "/aws/codebuild/dnafix-build",
  projectName: process.env.AWS_CODEBUILD_PROJECT ?? "dnafix-build",
});
const store = new FileCleanupStore(path.join(dataDir, "role-cleanups.json"));
const ports = createAwsReaperPorts({ region, projectName: process.env.AWS_CODEBUILD_PROJECT ?? "dnafix-build", manager, store });
const reaper = new RoleReaper(ports, 24 * 60 * 60 * 1000, new FileLock(path.join(dataDir, "reaper.lock")));
const outcomes = await reaper.reconcile();
console.log(JSON.stringify(outcomes.map((o) => ({ role: o.roleName, action: o.action, reason: o.reason })), null, 2));
