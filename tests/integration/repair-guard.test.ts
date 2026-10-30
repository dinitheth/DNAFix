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

class FakeIntelligence implements RepositoryIntelligence {
  readonly providerName = "fake-intelligence-test-double";
  async analyze(input: { baseCommitSha: string }) {
    return {
      repositoryId: "fixture-repo",
      baseCommitSha: input.baseCommitSha,
      analysisVersion: 1,
      analyzedAt: new Date().toISOString(),
      architecture: { layers: [], patterns: [], summary: "test double" },
      criticalComponents: [],
      risks: [],
      languages: ["TypeScript"],
      files: ["package.json", "src/cart.ts", "src/discount.ts", "test/cart.test.mjs"],
      targets: [],
      workingTree: null,
      complete: true,
      warnings: [],
    };
  }
}

describe("repair deletion guard (eval-v1 finding)", () => {
  it("rejects repair patches that delete core files, audits the rejection, and never commits a deletion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-repair-"));
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
          summary: "s",
          problemDescription: "p",
          expectedBehavior: "e",
          requirements: ["fix discount"],
          acceptanceCriteria: ["tests pass"],
          ambiguities: [],
          assumptions: [],
          riskLevel: "low",
        },
        plan: {
          baseCommitSha: input.baseCommitSha,
          repositorySnapshotId: input.repositorySnapshotId,
          steps: [{ id: "s1", description: "fix" }],
          tasks: [
            {
              id: "fix-discount",
              title: "fix",
              description: "d",
              expectedOutcome: "o",
              fileScope: ["src/discount.ts"],
              dependsOn: [],
              acceptanceCriteria: ["tests pass"],
              testExpectations: [],
              retryLimit: 0,
            },
          ],
          validationPlan: [],
          predictedAffectedPaths: [{ path: "src/discount.ts", source: "model-hypothesis", reason: "bug", evidence: null }],
          unresolvedQuestions: [],
          requiresHumanClarification: false,
        },
        nominatedTargets: [],
      }),
      patch: (input) =>
        input.task.id.startsWith("repair")
          ? // Malicious/broken repair: tries to delete the core source file.
            { summary: "delete the problem file", operations: [{ type: "delete" as const, path: "src/discount.ts" }] }
          : // Correct initial fix; the scripted verifier below forces the repair loop.
            {
              summary: "correct fix",
              operations: [
                {
                  type: "replace" as const,
                  path: "src/discount.ts",
                  search: "  // BUG: subtracts the percentage number as a flat currency amount.\n  return price - percentOff;",
                  replace: "  return price - (price * percentOff) / 100;",
                },
              ],
            },
      // Verifier always requests changes so the bounded repair loop runs.
      review: () => ({
        summary: "requesting changes (test double)",
        verdict: "request-changes" as const,
        criteria: [{ criterion: "tests pass", status: "uncertain" as const, evidence: "test double forces repair" }],
        unintendedChanges: [],
        missingTests: [],
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
    const run = await runs.createRun({ repositoryPath: repo, issueTitle: "discount bug", issueBody: "fix it" });
    await pipeline.process(run.id);
    let current = await deps.store.getRun(run.id);
    expect(current?.state).toBe("AWAITING_PLAN_APPROVAL");
    await runs.transition(current!, "AGENT_EXECUTION");
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);

    // Repair attempts were rejected by the guard; the run blocks honestly instead of deleting the file.
    expect(current?.state).toBe("BLOCKED");
    expect(current?.repairAttempts).toBe(2);
    expect(current?.diff).not.toContain("deleted file mode");
    expect(current?.changedPaths).toContain("src/discount.ts");

    const audit = await deps.store.listAudit(run.id);
    const rejected = audit.filter((a) => a.action === "repair.rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]?.evidence).toMatch(/deny-by-default/);
  }, 180_000);
});
