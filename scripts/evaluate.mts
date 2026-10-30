/**
 * DNAFix Milestone 2 — controlled pilot: Baseline vs DNA-aware.
 * Design: docs/evaluation/EXPERIMENT_DESIGN.md. Reference: docs/evaluation/BENCHMARK_REFERENCE.md.
 *
 * Both arms: identical prepared repo + base commit, identical issue, identical
 * model (muse-wonder-1.0 for EVERY role), identical pipeline/tools/budgets.
 * Baseline never invokes Project DNA (git-inspection stub on the same port).
 * DNA-aware uses the real ProjectDNAAdapter. Order is randomized and recorded.
 * Requires MODEL_API_KEY + PROJECT_DNA_PATH; otherwise exits 2 without claiming results.
 */
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pipeline, RunService } from "@dnafix/application";
import { EvaluationRunRecordSchema, type EvaluationRunRecord, type RepositoryIntelligenceReport } from "@dnafix/contracts";
import { HostCommandRunner } from "@dnafix/execution";
import { GitWorktreeManager } from "@dnafix/git-engine";
import { GitHubAdapter } from "@dnafix/github";
import { BudgetedModelProvider, MetaModelProvider } from "@dnafix/model-provider";
import { MemoryStore } from "@dnafix/persistence";
import { ProjectDNAAdapter, type RepositoryIntelligence } from "@dnafix/repository-intelligence";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "benchmark-repo");
const ACCEPTANCE_TEST = path.join(REPO_ROOT, "tests", "fixtures", "benchmark-acceptance", "acceptance.test.mjs");

if (!process.env.MODEL_API_KEY) {
  console.error("evaluate BLOCKED: MODEL_API_KEY is not set. No experiment was run and no results are claimed.");
  process.exit(2);
}
if (!process.env.PROJECT_DNA_PATH) {
  console.error("evaluate BLOCKED: PROJECT_DNA_PATH is not set. The DNA-aware arm cannot run without Project DNA.");
  process.exit(2);
}

const ISSUE_TITLE = "Promo codes are accepted but silently ignored";
const ISSUE_BODY = [
  "Customers can submit a promoCode when creating an order (for example WELCOME10), and the API accepts and stores it, but the discount is never applied: discountAmount is always 0 and totals are unchanged.",
  "",
  "Expected behavior:",
  "- A valid promo code applies its percentage discount to the order subtotal, before tax. Valid codes and their percentages are defined in the promo code registry (src/validation/promo-codes.ts), which is the single source of truth.",
  "- Tax is calculated on the discounted subtotal.",
  "- The free-shipping threshold is evaluated on the discounted subtotal.",
  "- Promo codes are case-insensitive.",
  "- An unknown promo code is rejected as a validation error (the API returns 400) and no order is stored.",
  "- Orders without a promo code behave exactly as they do today.",
  "",
  "Acceptance criteria:",
  "- A 120 order with WELCOME10 has discountAmount 12, tax 10.8, free shipping, total 118.8.",
  "- A 105 order with WELCOME10 pays shipping because the discounted subtotal is below the free-shipping threshold.",
  "- Unknown codes return HTTP 400 from the order handler.",
  "- All existing tests continue to pass.",
].join("\n");

const MODEL_ID = process.env.EVAL_MODEL ?? "muse-wonder-1.0";
const MAX_MODEL_CALLS = 12;
const MAX_TOTAL_TOKENS = 250_000;
const MAX_COST_USD = 3.0; // explicit monetary ceiling per arm (eval-v1.1 amendment)
const MAX_OUTPUT_TOKENS_PER_REQUEST = 16384; // per-request cap (raised in eval-v1.2: 8192 starved Wonder patch generation — reasoning shares the cap)
const PRICING = { currency: "USD" as const, inputPerMillion: 4.0, outputPerMillion: 20.0, source: "dev.meta.ai/docs/pricing-rate-limits (Muse Wonder Standard, checked 2026-10-31)" };

const ACCEPTABLE = new Set([
  "src/services/order-service.ts",
  "src/validation/order-validator.ts",
  "src/validation/promo-codes.ts",
  "src/api/order-handler.ts",
]);

/** Baseline intelligence: git inspection only. Project DNA is never invoked. */
class GitInspectionIntelligence implements RepositoryIntelligence {
  readonly providerName = "baseline-git-inspection (no Project DNA)";
  async analyze(input: { rootPath: string; baseCommitSha: string; targetPaths: string[] }): Promise<RepositoryIntelligenceReport> {
    const files = (await exec("git", ["ls-files"], { cwd: input.rootPath })).stdout
      .split("\n")
      .map((s) => s.trim().replaceAll("\\", "/"))
      .filter(Boolean)
      .sort();
    return {
      repositoryId: "benchmark-baseline",
      baseCommitSha: input.baseCommitSha,
      analysisVersion: null,
      analyzedAt: new Date().toISOString(),
      architecture: { layers: [], patterns: [], summary: "" },
      criticalComponents: [],
      risks: [],
      languages: [],
      files,
      targets: [],
      workingTree: null,
      complete: true,
      warnings: ["Baseline condition: no Project DNA analysis was performed. File inventory from `git ls-files` only."],
    };
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
}

async function prepareBenchmark(stamp: string): Promise<{ repoPath: string; baseCommitSha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), `dnafix-eval-${stamp}-`));
  const repoPath = path.join(root, "repo");
  await cp(FIXTURE, repoPath, { recursive: true });
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "eval@dnafix.local"]);
  await git(repoPath, ["config", "user.name", "DNAFix Evaluation"]);
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-m", "Benchmark fixture: orderflow (frozen eval-v1)"]);
  const baseCommitSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
  return { repoPath, baseCommitSha };
}

interface ArmOutcome {
  record: EvaluationRunRecord;
  diff: string;
}

async function runArm(args: {
  condition: "baseline" | "dna-aware";
  executionOrder: number;
  experimentId: string;
  repoPath: string;
  baseCommitSha: string;
  intelligence: RepositoryIntelligence;
  dataRoot: string;
}): Promise<ArmOutcome> {
  const metered = new BudgetedModelProvider(new MetaModelProvider({ model: MODEL_ID }), {
    maxCalls: MAX_MODEL_CALLS,
    maxTotalTokens: MAX_TOTAL_TOKENS,
    maxCostUsd: MAX_COST_USD,
    maxOutputTokensPerRequest: MAX_OUTPUT_TOKENS_PER_REQUEST,
    pricing: { inputPerMillion: PRICING.inputPerMillion, outputPerMillion: PRICING.outputPerMillion },
  });
  const deps = {
    store: new MemoryStore(),
    intelligence: args.intelligence,
    model: metered,
    subAgentModel: metered, // identical model for every role in both arms
    worktrees: new GitWorktreeManager(path.join(args.dataRoot, "worktrees")),
    runner: new HostCommandRunner(),
    github: new GitHubAdapter({}),
    dataRoot: args.dataRoot,
    maxRepairAttempts: 2,
    sandboxNote: "host (evaluation)",
  };
  const runs = new RunService(deps);
  const pipeline = new Pipeline(deps);
  const started = Date.now();
  const run = await runs.createRun({ repositoryPath: args.repoPath, issueTitle: ISSUE_TITLE, issueBody: ISSUE_BODY });
  await pipeline.process(run.id);
  let current = await deps.store.getRun(run.id);
  if (current?.state === "AWAITING_PLAN_APPROVAL") {
    await runs.transition(current, "AGENT_EXECUTION"); // auto-approval, identical for both arms (documented limitation)
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);
  }
  if (current?.state === "AWAITING_PR_APPROVAL") {
    await runs.transition(current, "PULL_REQUEST_CREATION");
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);
  }
  const durationMs = Date.now() - started;
  const final = current!;
  const totals = metered.totals();
  const estimatedCostUsd =
    totals.inputTokens !== null && totals.outputTokens !== null
      ? Math.round(((totals.inputTokens / 1_000_000) * PRICING.inputPerMillion + (totals.outputTokens / 1_000_000) * PRICING.outputPerMillion) * 10_000) / 10_000
      : null;

  // ── Deterministic scoring in a fresh worktree ──────────────────────────────
  const scoringDir = path.join(args.dataRoot, "scoring");
  await cp(args.repoPath, scoringDir, { recursive: true });
  let regressionExitCode: number | null = null;
  let acceptanceExitCode: number | null = null;
  const acceptance: Array<{ id: string; passed: boolean; evidence: string }> = [];
  if (final.diff.trim()) {
    const patchPath = path.join(args.dataRoot, "agent.patch");
    await writeFile(patchPath, final.diff, "utf8");
    await git(scoringDir, ["apply", "--whitespace=nowarn", patchPath]);
  }
  const runner = new HostCommandRunner();
  const regression = await runner.run(["npm", "run", "test"], { cwd: scoringDir, timeoutMs: 120_000 });
  regressionExitCode = regression.exitCode;
  await cp(ACCEPTANCE_TEST, path.join(scoringDir, "test", "acceptance.test.mjs"));
  const acc = await runner.run(["node", "--test", "test/acceptance.test.mjs"], { cwd: scoringDir, timeoutMs: 120_000 });
  acceptanceExitCode = acc.exitCode;
  for (const id of ["A1", "A2", "A3", "A4", "A5"]) {
    // TAP result lines only (`ok N - A1: ...` / `not ok N - A1: ...`); never `# Subtest:` comments.
    const line = acc.stdoutSummary.split("\n").find((l) => new RegExp(`^(ok|not ok) \\d+ - ${id}:`).test(l.trim()));
    acceptance.push({ id, passed: line ? line.trim().startsWith("ok ") : false, evidence: line?.trim().slice(0, 300) ?? "result line not found in TAP output" });
  }

  const changed = final.changedPaths;
  const relevantChanged = changed.filter((p) => ACCEPTABLE.has(p) || p.startsWith("test/"));
  const unrelatedChanged = changed.filter((p) => !ACCEPTABLE.has(p) && !p.startsWith("test/"));
  const serviceChanged = changed.includes("src/services/order-service.ts");
  const rejectionWorks = acceptance.find((a) => a.id === "A3")?.passed ?? false;
  const missingRequired: string[] = [];
  if (!serviceChanged) missingRequired.push("src/services/order-service.ts (core fix)");
  if (!rejectionWorks) missingRequired.push("unknown-promo rejection behavior (validator/service/handler)");
  const recall = (serviceChanged ? 0.5 : 0) + (rejectionWorks ? 0.5 : 0);
  const precision = changed.length === 0 ? null : Math.round((relevantChanged.length / changed.length) * 1000) / 1000;

  const record: EvaluationRunRecord = {
    experimentId: args.experimentId,
    experimentVersion: "eval-v1.2",
    condition: args.condition,
    executionOrder: args.executionOrder,
    runId: run.id,
    repository: { fixture: "tests/fixtures/benchmark-repo", baseCommitSha: args.baseCommitSha, preparedAt: new Date().toISOString() },
    issue: { title: ISSUE_TITLE, body: ISSUE_BODY },
    configuration: {
      modelId: MODEL_ID,
      subAgentModelId: MODEL_ID,
      transport: process.env.MODEL_TRANSPORT ?? "responses",
      reasoningEffort: process.env.MUSE_REASONING_EFFORT ?? null,
      maxRepairAttempts: 2,
      maxModelCalls: MAX_MODEL_CALLS,
      maxTotalTokens: MAX_TOTAL_TOKENS,
      maxCostUsd: MAX_COST_USD,
      maxOutputTokensPerRequest: MAX_OUTPUT_TOKENS_PER_REQUEST,
      sandboxMode: "host",
      workflowEngine: "in-process-durable",
      intelligenceProvider: args.intelligence.providerName,
    },
    intelligenceSnapshot: final.intelligence
      ? {
          repositoryId: final.intelligence.repositoryId,
          analysisVersion: final.intelligence.analysisVersion,
          snapshotId: final.repositorySnapshotId,
          planningSnapshotId: final.repositorySnapshotId,
          impactSnapshotId: final.impactSnapshotId ?? null,
          baseCommitSha: final.intelligence.baseCommitSha,
          complete: final.intelligence.complete,
          warnings: final.intelligence.warnings,
        }
      : null,
    outcome: {
      finalState: final.state,
      error: final.error,
      durationMs,
      changedFiles: changed,
      diffPath: null, // filled by caller
      repairAttempts: final.repairAttempts,
      tasks: final.tasks.map((t) => ({ taskId: t.taskId, status: t.status, changedPaths: t.changedPaths, attempts: t.attempts, patchSummary: t.patchSummary, error: t.error })),
      plannedScope: [...new Set((final.plan?.tasks ?? []).flatMap((t) => t.fileScope))],
      nominatedTargets: [],
      baselineChecks: final.baselineChecks.map((c) => ({ kind: c.kind, status: c.status, exitCode: c.result?.exitCode ?? null })),
      verificationChecks: (final.verificationChecks ?? []).map((c) => ({ kind: c.kind, status: c.status, exitCode: c.result?.exitCode ?? null })),
      verifierVerdict: final.verifierReview?.verdict ?? null,
    },
    usage: {
      modelCalls: metered.calls.length,
      calls: metered.calls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      budgetExceeded: metered.budgetExceeded,
      pricing: PRICING,
      estimatedCostUsd,
    },
    scoring: {
      acceptance,
      regressionPassed: regressionExitCode === 0,
      regressionExitCode,
      acceptanceExitCode,
      precision,
      recall,
      recallDetail: "recall = 0.5 for changing src/services/order-service.ts + 0.5 for A3 (unknown-code rejection) passing, so alternative validation locations are scored fairly",
      relevantChanged,
      unrelatedChanged,
      missingRequired,
    },
    createdAt: new Date().toISOString(),
  };
  return { record: EvaluationRunRecordSchema.parse(record), diff: final.diff };
}

// ── Pilot ────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const experimentId = `pilot-${stamp}`;
const outDir = path.join(REPO_ROOT, "docs", "evaluation", "runs", experimentId);
await mkdir(outDir, { recursive: true });
const { repoPath, baseCommitSha } = await prepareBenchmark(stamp);
console.log(`Experiment ${experimentId}\nBenchmark base commit: ${baseCommitSha}`);

const dnaFirst = randomInt(2) === 0;
const order: Array<"baseline" | "dna-aware"> = dnaFirst ? ["dna-aware", "baseline"] : ["baseline", "dna-aware"];
console.log(`Execution order (randomized): ${order.join(" -> ")}`);

const outcomes = new Map<string, ArmOutcome>();
for (const [index, condition] of order.entries()) {
  console.log(`\n=== Running ${condition} (${index + 1}/2) ===`);
  const intelligence = condition === "dna-aware" ? new ProjectDNAAdapter(process.env.PROJECT_DNA_PATH) : new GitInspectionIntelligence();
  const outcome = await runArm({
    condition,
    executionOrder: index + 1,
    experimentId,
    repoPath,
    baseCommitSha,
    intelligence,
    dataRoot: path.join(tmpdir(), `dnafix-eval-${stamp}-${condition}`),
  });
  outcomes.set(condition, outcome);
  console.log(`${condition}: state=${outcome.record.outcome.finalState} tokens=${outcome.record.usage.totalTokens} cost=$${outcome.record.usage.estimatedCostUsd} repairs=${outcome.record.outcome.repairAttempts}`);
}

// Anonymized patches: random A/B assignment, sealed mapping.
const assignA = randomInt(2) === 0 ? "baseline" : "dna-aware";
const assignB = assignA === "baseline" ? "dna-aware" : "baseline";
await writeFile(path.join(outDir, "patch-A.diff"), outcomes.get(assignA)!.diff, "utf8");
await writeFile(path.join(outDir, "patch-B.diff"), outcomes.get(assignB)!.diff, "utf8");
await writeFile(path.join(outDir, "review-mapping.json"), JSON.stringify({ A: assignA, B: assignB, note: "SEALED until blind review is complete" }, null, 2), "utf8");

for (const condition of ["baseline", "dna-aware"] as const) {
  const outcome = outcomes.get(condition)!;
  outcome.record.outcome.diffPath = condition === assignA ? "patch-A.diff" : "patch-B.diff";
  await writeFile(path.join(outDir, `${condition}.json`), JSON.stringify(outcome.record, null, 2), "utf8");
}

const summary = {
  experimentId,
  baseCommitSha,
  executionOrder: order,
  budget: { maxModelCalls: MAX_MODEL_CALLS, maxTotalTokens: MAX_TOTAL_TOKENS, maxCostUsd: MAX_COST_USD, maxOutputTokensPerRequest: MAX_OUTPUT_TOKENS_PER_REQUEST, pricing: PRICING },
  baseline: outcomes.get("baseline")!.record,
  dnaAware: outcomes.get("dna-aware")!.record,
};
await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(`\nArtifacts written to ${outDir}`);
console.log(JSON.stringify({
  baseline: { state: summary.baseline.outcome.finalState, acceptance: summary.baseline.scoring.acceptance.map((a) => `${a.id}:${a.passed}`), precision: summary.baseline.scoring.precision, recall: summary.baseline.scoring.recall, tokens: summary.baseline.usage.totalTokens, costUsd: summary.baseline.usage.estimatedCostUsd, durationMs: summary.baseline.outcome.durationMs },
  dnaAware: { state: summary.dnaAware.outcome.finalState, acceptance: summary.dnaAware.scoring.acceptance.map((a) => `${a.id}:${a.passed}`), precision: summary.dnaAware.scoring.precision, recall: summary.dnaAware.scoring.recall, tokens: summary.dnaAware.usage.totalTokens, costUsd: summary.dnaAware.usage.estimatedCostUsd, durationMs: summary.dnaAware.outcome.durationMs },
}, null, 2));
