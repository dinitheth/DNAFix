import { execFile } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
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

/** Test double for the RepositoryIntelligence port. The real Project DNA bridge is covered by project-dna-bridge.test.ts. */
class FakeIntelligence implements RepositoryIntelligence {
  readonly providerName = "fake-intelligence-test-double";
  async analyze(input: { rootPath: string; baseCommitSha: string; targetPaths: string[] }) {
    return {
      repositoryId: "fixture-repo",
      baseCommitSha: input.baseCommitSha,
      analysisVersion: 1,
      analyzedAt: new Date().toISOString(),
      architecture: { layers: ["domain"], patterns: ["modular"], summary: "test-double architecture summary" },
      criticalComponents: [{ name: "discount", path: "src/discount.ts", reason: "imported by cart" }],
      risks: [],
      languages: ["TypeScript"],
      files: ["package.json", "src/cart.ts", "src/discount.ts", "test/cart.test.mjs"],
      targets: input.targetPaths.map((targetPath) => ({
        targetPath,
        directImpacted: ["src/cart.ts"],
        transitiveImpacted: [],
        evidenceReasons: ["direct-dependent"],
        truncations: [],
      })),
      workingTree: null,
      complete: true,
      warnings: [],
    };
  }
}

describe("offline end-to-end pipeline (scripted model test double, no Muse claim)", () => {
  it("takes the fixture issue from analysis to a verified local patch with approval gates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-e2e-"));
    const repo = path.join(root, "repo");
    await cp(FIXTURE, repo, { recursive: true });
    const git = (args: string[]) => exec("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await git(["add", "-A"]);
    await git(["commit", "-m", "init"]);

    const scripted = new ScriptedModelProvider({
      plan: (input) => ({
        analysis: {
          summary: "Percentage discount is subtracted as a flat amount.",
          problemDescription: "applyDiscount subtracts percentOff as currency.",
          expectedBehavior: "applyDiscount(200, 10) === 180.",
          requirements: ["Fix percentage calculation in src/discount.ts"],
          acceptanceCriteria: ["applyDiscount(200, 10) === 180", "Existing test suite passes"],
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
    const runs = new RunService(deps);
    const pipeline = new Pipeline(deps);
    const run = await runs.createRun({
      repositoryPath: repo,
      issueTitle: "Percentage discounts are calculated as flat amounts",
      issueBody: "applyDiscount(200, 10) should be 180 but returns 190.",
    });
    expect(run.modelProvider).toContain("scripted-test-double");

    await pipeline.process(run.id);
    let current = await deps.store.getRun(run.id);
    expect(current?.state).toBe("AWAITING_PLAN_APPROVAL");
    // Baseline: the fixture test suite must actually be failing before the fix.
    expect(current?.baselineChecks.find((c) => c.kind === "test")?.status).toBe("failed");
    expect(current?.intelligence?.targets[0]?.directImpacted).toContain("src/cart.ts");
    // Structural analysis records which commit it covered, so the repository view
    // can tell a current snapshot from one an later commit has overtaken.
    const analysedRepository = await deps.store.getRepository(current!.repositoryId);
    expect(analysedRepository?.lastAnalyzedCommitSha).toBe(current?.baseCommitSha);

    await runs.transition(current!, "AGENT_EXECUTION");
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);
    expect(current?.state).toBe("AWAITING_PR_APPROVAL");
    expect(current?.changedPaths).toContain("src/discount.ts");
    expect(current?.verificationChecks?.find((c) => c.kind === "test")?.status).toBe("passed");
    expect(current?.verificationChecks?.find((c) => c.kind === "test")?.result?.exitCode).toBe(0);
    expect(current?.diff).toContain("price * percentOff");

    await runs.transition(current!, "PULL_REQUEST_CREATION");
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);
    expect(current?.state).toBe("COMPLETED");
    expect(current?.pullRequestUrl).toBeNull(); // GitHub not configured: local patch delivery, honestly recorded.

    const audit = await deps.store.listAudit(run.id);
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("plan.created");
    expect(actions).toContain("verification.completed");
    expect(actions).toContain("pull-request.skipped");
  }, 180_000);
});
