import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Pipeline, RunService } from "@dnafix/application";
import { HostCommandRunner } from "@dnafix/execution";
import { GitWorktreeManager } from "@dnafix/git-engine";
import { GitHubAdapter } from "@dnafix/github";
import { ScriptedModelProvider } from "@dnafix/model-provider";
import { MemoryStore } from "@dnafix/persistence";
import type { RepositoryIntelligence } from "@dnafix/repository-intelligence";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "fixtures", "sample-repo");

class FakeIntelligence implements RepositoryIntelligence {
  readonly providerName = "fake-intelligence-test-double";
  async analyze(input: { rootPath: string; baseCommitSha: string; targetPaths: string[] }) {
    return {
      repositoryId: "fixture-repo",
      baseCommitSha: input.baseCommitSha,
      analysisVersion: 1,
      analyzedAt: new Date().toISOString(),
      architecture: { layers: ["domain"], patterns: ["modular"], summary: "test-double architecture summary" },
      criticalComponents: [],
      risks: [],
      languages: ["TypeScript"],
      files: ["package.json", "src/discount.ts"],
      targets: input.targetPaths.map((targetPath) => ({ targetPath, directImpacted: [], transitiveImpacted: [], evidenceReasons: [], truncations: [] })),
      workingTree: null,
      complete: true,
      warnings: [],
    };
  }
}

async function prepareRepo(removeTestScript: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "dnafix-evidence-"));
  const repo = path.join(root, "repo");
  await cp(FIXTURE, repo, { recursive: true });
  if (removeTestScript) {
    const pkgPath = path.join(repo, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    delete pkg.scripts?.test;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
  }
  const git = (args: string[]) => exec("git", args, { cwd: repo });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "init"]);
  return repo;
}

function buildDeps(root: string) {
  const scripted = new ScriptedModelProvider({
    plan: (input) => ({
      analysis: {
        summary: "Percentage discount is subtracted as a flat amount.",
        problemDescription: "applyDiscount subtracts percentOff as currency.",
        expectedBehavior: "applyDiscount(200, 10) === 180.",
        requirements: ["Fix percentage calculation in src/discount.ts"],
        acceptanceCriteria: ["applyDiscount(200, 10) === 180"],
        ambiguities: [],
        assumptions: [],
        riskLevel: "low",
      },
      plan: {
        baseCommitSha: input.baseCommitSha,
        repositorySnapshotId: input.repositorySnapshotId,
        steps: [{ id: "s1", description: "Fix applyDiscount" }],
        tasks: [
          {
            id: "fix-discount",
            title: "Fix percentage discount calculation",
            description: "Correct applyDiscount in src/discount.ts",
            expectedOutcome: "Percentage discounts are proportional.",
            fileScope: ["src/discount.ts"],
            dependsOn: [],
            acceptanceCriteria: ["applyDiscount(200, 10) === 180"],
            testExpectations: ["npm test passes"],
            retryLimit: 1,
          },
        ],
        validationPlan: [{ id: "v1", kind: "test", description: "Run test suite" }],
        predictedAffectedPaths: [{ path: "src/discount.ts", source: "project-dna", reason: "contains buggy function", evidence: "fake-intelligence" }],
        unresolvedQuestions: [],
        requiresHumanClarification: false,
      },
      nominatedTargets: ["src/discount.ts"],
    }),
    patch: () => ({
      summary: "Compute percentage discount proportionally.",
      operations: [
        {
          type: "replace",
          path: "src/discount.ts",
          search: "  // BUG: subtracts the percentage number as a flat currency amount.\n  return price - percentOff;",
          replace: "  return price - (price * percentOff) / 100;",
        },
      ],
    }),
  });
  const deps = {
    store: new MemoryStore(),
    intelligence: new FakeIntelligence(),
    model: scripted,
    worktrees: new GitWorktreeManager(path.join(root, "worktrees")),
    runner: new HostCommandRunner(),
    github: new GitHubAdapter({}),
    dataRoot: root,
    maxRepairAttempts: 2,
    sandboxNote: "host (test)",
  };
  return deps;
}

describe("verification evidence gate", () => {
  it("blocks instead of approving when no check can execute", async () => {
    const repo = await prepareRepo(true);
    const deps = buildDeps(path.dirname(repo));
    const runs = new RunService(deps);
    const pipeline = new Pipeline(deps);
    const run = await runs.createRun({ repositoryPath: repo, issueTitle: "Discount bug", issueBody: "applyDiscount(200, 10) returns 190." });
    await pipeline.process(run.id);
    let current = await deps.store.getRun(run.id);
    await runs.transition(current!, "AGENT_EXECUTION");
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);

    expect(current?.state).toBe("BLOCKED");
    expect(current?.error).toMatch(/No verification check executed/);
    expect(current?.verificationChecks?.every((c) => c.status === "not-executed")).toBe(true);
  }, 180_000);

  it("reaches the PR gate when the bug-reproducing test genuinely fails then passes", async () => {
    const repo = await prepareRepo(false);
    const deps = buildDeps(path.dirname(repo));
    const runs = new RunService(deps);
    const pipeline = new Pipeline(deps);
    const run = await runs.createRun({ repositoryPath: repo, issueTitle: "Discount bug", issueBody: "applyDiscount(200, 10) returns 190." });
    await pipeline.process(run.id);
    let current = await deps.store.getRun(run.id);
    expect(current?.baselineChecks.find((c) => c.kind === "test")?.status).toBe("failed");
    await runs.transition(current!, "AGENT_EXECUTION");
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);

    expect(current?.state).toBe("AWAITING_PR_APPROVAL");
    expect(current?.verificationChecks?.find((c) => c.kind === "test")?.status).toBe("passed");
  }, 180_000);
});
