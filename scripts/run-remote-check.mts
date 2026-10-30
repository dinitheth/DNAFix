/**
 * Runs one bounded remote job through the CodeBuild execution provider.
 * Requires AWS_CODEBUILD_PROJECT + AWS_ARTIFACT_BUCKET (see docs/AWS_EXECUTION.md)
 * and AWS credentials via the SDK default chain (default profile dnafix-dev, ap-southeast-2).
 * NOTE: starting a build is billable and quota-gated — run only with maintainer approval (Stage C).
 * Usage: tsx scripts/run-remote-check.mts <workspacePath> <argv...>
 * Example: tsx scripts/run-remote-check.mts tests/fixtures/sample-repo node --test test/cart.test.mjs
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codeBuildProviderFromEnv } from "@dnafix/remote-execution";

const exec = promisify(execFile);
const [workspacePath, ...argv] = process.argv.slice(2);
if (!workspacePath || argv.length === 0) {
  console.error("usage: tsx scripts/run-remote-check.mts <workspacePath> <argv...>");
  process.exit(2);
}
const provider = codeBuildProviderFromEnv();
if (!provider.configured()) {
  console.error("remote:check BLOCKED: AWS_CODEBUILD_PROJECT/AWS_ARTIFACT_BUCKET not set. No remote job was started.");
  process.exit(2);
}
const baseCommitSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: workspacePath })).stdout.trim();
const result = await provider.runJob({
  runId: `manual-${Date.now().toString(36)}`,
  workspacePath,
  baseCommitSha,
  commands: [{ id: "check", kind: "custom", argv }],
  timeoutMinutes: 10,
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "SUCCEEDED" ? 0 : 1);
