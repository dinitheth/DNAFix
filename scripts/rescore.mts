/**
 * Deterministic RE-SCORING of saved evaluation patches (analysis only — does not
 * re-run any experiment arm). Fixes the eval-v1 TAP parser, which matched
 * `# Subtest:` comment lines instead of `ok/not ok` result lines.
 * Usage: tsx scripts/rescore.mts docs/evaluation/runs/<experiment-id>
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EvaluationRunRecordSchema, type EvaluationRunRecord } from "@dnafix/contracts";
import { HostCommandRunner } from "@dnafix/execution";

const exec = promisify(execFile);
const runsDir = process.argv[2];
if (!runsDir) {
  console.error("usage: tsx scripts/rescore.mts docs/evaluation/runs/<experiment-id>");
  process.exit(2);
}
const ACCEPTABLE = new Set(["src/services/order-service.ts", "src/validation/order-validator.ts", "src/validation/promo-codes.ts", "src/api/order-handler.ts"]);

async function rescore(condition: "baseline" | "dna-aware"): Promise<EvaluationRunRecord> {
  const recordPath = path.join(runsDir, `${condition}.json`);
  const record = EvaluationRunRecordSchema.parse(JSON.parse(await readFile(recordPath, "utf8")) as unknown);
  const stamp = await mkdtemp(path.join(tmpdir(), `dnafix-rescore-${condition}-`));
  const repo = path.join(stamp, "repo");
  await cp(path.resolve("tests/fixtures/benchmark-repo"), repo, { recursive: true });
  const git = (args: string[]) => exec("git", args, { cwd: repo });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "eval@dnafix.local"]);
  await git(["config", "user.name", "DNAFix Evaluation"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "base"]);
  const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (sha !== record.repository.baseCommitSha) {
    console.warn(`WARNING ${condition}: rescored base ${sha} != recorded ${record.repository.baseCommitSha} (fixture changed since the run; scores are indicative)`);
  }
  const diff = await readFile(path.join(runsDir, record.outcome.diffPath!), "utf8");
  if (diff.trim()) {
    const patchPath = path.join(stamp, "agent.patch");
    await writeFile(patchPath, diff, "utf8");
    await git(["apply", "--whitespace=nowarn", patchPath]);
  }
  const runner = new HostCommandRunner();
  const regression = await runner.run(["npm", "run", "test"], { cwd: repo, timeoutMs: 120_000 });
  await cp(path.resolve("tests/fixtures/benchmark-acceptance/acceptance.test.mjs"), path.join(repo, "test", "acceptance.test.mjs"));
  const acc = await runner.run(["node", "--test", "test/acceptance.test.mjs"], { cwd: repo, timeoutMs: 120_000 });
  const acceptance = ["A1", "A2", "A3", "A4", "A5"].map((id) => {
    const line = acc.stdoutSummary.split("\n").find((l) => new RegExp(`^(ok|not ok) \\d+ - ${id}:`).test(l.trim()));
    return { id, passed: line ? line.trim().startsWith("ok ") : false, evidence: line?.trim().slice(0, 300) ?? "result line not found (rescored)" };
  });
  const changed = record.outcome.changedFiles;
  const serviceChanged = changed.includes("src/services/order-service.ts");
  const rejectionWorks = acceptance.find((a) => a.id === "A3")?.passed ?? false;
  record.scoring = {
    acceptance,
    regressionPassed: regression.exitCode === 0,
    regressionExitCode: regression.exitCode,
    acceptanceExitCode: acc.exitCode,
    precision: changed.length === 0 ? null : Math.round((changed.filter((p) => ACCEPTABLE.has(p) || p.startsWith("test/")).length / changed.length) * 1000) / 1000,
    recall: (serviceChanged ? 0.5 : 0) + (rejectionWorks ? 0.5 : 0),
    recallDetail: `${record.scoring.recallDetail} [rescored 2026-10-31 with fixed TAP parser; original eval-v1 parser matched '# Subtest:' comment lines]`,
    relevantChanged: changed.filter((p) => ACCEPTABLE.has(p) || p.startsWith("test/")),
    unrelatedChanged: changed.filter((p) => !ACCEPTABLE.has(p) && !p.startsWith("test/")),
    missingRequired: [
      ...(serviceChanged ? [] : ["src/services/order-service.ts (core fix)"]),
      ...(rejectionWorks ? [] : ["unknown-promo rejection behavior (validator/service/handler)"]),
    ],
  };
  await writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
  console.log(`${condition}: acceptance=${acceptance.map((a) => `${a.id}:${a.passed}`).join(",")} regression=${regression.exitCode} precision=${record.scoring.precision} recall=${record.scoring.recall}`);
  return record;
}

const baseline = await rescore("baseline");
const dnaAware = await rescore("dna-aware");
await writeFile(path.join(runsDir, "summary.json"), JSON.stringify({ experimentId: baseline.experimentId, baseCommitSha: baseline.repository.baseCommitSha, rescoredAt: new Date().toISOString(), baseline, dnaAware }, null, 2), "utf8");
console.log("summary.json updated");
