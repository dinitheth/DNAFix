/**
 * Runs one bounded remote job through the CodeBuild execution provider.
 * Requires AWS_CODEBUILD_PROJECT + AWS_ARTIFACTS_BUCKET (see docs/AWS_EXECUTION.md)
 * and an authenticated AWS CLI profile (default dnafix-dev, ap-southeast-2).
 * Usage: tsx scripts/run-remote-check.mts <workspacePath> <argv...>
 * Example: tsx scripts/run-remote-check.mts tests/fixtures/sample-repo node --test test/cart.test.mjs
 */
import { codeBuildProviderFromEnv } from "@dnafix/remote-execution";

const [workspacePath, ...argv] = process.argv.slice(2);
if (!workspacePath || argv.length === 0) {
  console.error("usage: tsx scripts/run-remote-check.mts <workspacePath> <argv...>");
  process.exit(2);
}
const provider = codeBuildProviderFromEnv();
if (!provider.configured()) {
  console.error("remote:check BLOCKED: AWS_CODEBUILD_PROJECT/AWS_ARTIFACTS_BUCKET not set. No remote job was started.");
  process.exit(2);
}
const result = await provider.runJob({ workspacePath, argv, timeoutMinutes: 10 });
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "SUCCEEDED" ? 0 : 1);
