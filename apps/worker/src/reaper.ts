import path from "node:path";
import { resolveDataRoot } from "@dnafix/application";
import { FileCleanupStore, FileLock, RoleReaper, RunRoleManager, SdkIamOperations, createAwsReaperPorts } from "@dnafix/remote-execution";
import { IAMClient } from "@aws-sdk/client-iam";

/**
 * Orphan role reaper worker.
 * Deployment constraint (explicit): run exactly ONE reaper instance per
 * environment. The file lock prevents overlap on a single host; it is not
 * distributed locking, and DNAFix does not claim multi-instance safety.
 */
export function startRoleReaperWorker(): void {
  const accountId = process.env.AWS_ACCOUNT_ID ?? "";
  const region = process.env.AWS_REGION ?? "ap-southeast-2";
  const bucket = process.env.AWS_ARTIFACT_BUCKET ?? process.env.AWS_ARTIFACTS_BUCKET ?? "";
  if (!accountId || !bucket) {
    console.log("[dnafix-reaper] disabled: AWS_ACCOUNT_ID and AWS_ARTIFACT_BUCKET are required for role reconciliation");
    return;
  }
  const dataDir = resolveDataRoot();
  const manager = new RunRoleManager(new SdkIamOperations(new IAMClient({ region })), {
    bucket,
    region,
    accountId,
    logGroupName: process.env.AWS_CLOUDWATCH_LOG_GROUP ?? "/aws/codebuild/dnafix-build",
    projectName: process.env.AWS_CODEBUILD_PROJECT ?? "dnafix-build",
  });
  const store = new FileCleanupStore(path.join(dataDir, "role-cleanups.json"));
  const lock = new FileLock(path.join(dataDir, "reaper.lock"));
  const ports = createAwsReaperPorts({ region, projectName: process.env.AWS_CODEBUILD_PROJECT ?? "dnafix-build", manager, store });
  const reaper = new RoleReaper(ports, 24 * 60 * 60 * 1000, lock);
  const intervalMs = Number(process.env.REAPER_INTERVAL_MS ?? 15 * 60 * 1000);
  console.log(`[dnafix-reaper] enabled (single-instance constraint; interval ${intervalMs}ms; state ${path.join(dataDir, "role-cleanups.json")})`);
  const tick = () =>
    reaper.reconcile().catch((err: Error) => console.error(`[dnafix-reaper] reconcile failed: ${err.message}`));
  void tick();
  setInterval(tick, intervalMs);
}
