import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pipeline, RunService } from "@dnafix/application";
import { GitWorktreeManager } from "@dnafix/git-engine";
import type { RunRecord } from "@dnafix/persistence";
import { pullRequestStageRun, startProcess, workspace } from "./harness.js";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "fixtures", "sample-repo");

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const namesIn = (dir: string) => readdir(dir).catch(() => [] as string[]);

describe("GitWorktreeManager.removeRunWorktrees", () => {
  let root: string;
  let repo: string;
  let worktreeRoot: string;
  let manager: GitWorktreeManager;
  let base: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dnafix-ws-"));
    repo = path.join(root, "repo");
    worktreeRoot = path.join(root, "worktrees");
    await cp(FIXTURE, repo, { recursive: true });
    const git = (args: string[]) => exec("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await git(["add", "-A"]);
    await git(["commit", "-m", "init"]);
    manager = new GitWorktreeManager(worktreeRoot);
    base = await manager.headSha(repo);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("deletes every directory for one run, dirty or not, and leaves the others", async () => {
    const mine = await manager.createWorktree(repo, "run_mine", "fix", base);
    const dirty = await manager.createWorktree(repo, "run_mine", "verify", base);
    const other = await manager.createWorktree(repo, "run_other", "fix", base);
    // A run that FAILED has a dirty tree by definition; the sweep has to survive that.
    await writeFile(path.join(dirty.path, "junk.txt"), "untracked");
    await writeFile(path.join(mine.path, "src", "discount.ts"), "corrupted");

    const removed = await manager.removeRunWorktrees(repo, "run_mine");

    expect([...removed].sort()).toEqual([mine.path, dirty.path].sort());
    expect(await exists(mine.path)).toBe(false);
    expect(await exists(dirty.path)).toBe(false);
    expect(await exists(other.path)).toBe(true);
    // The registry stays consistent with the disk afterwards.
    const listed = await namesIn(worktreeRoot);
    expect(listed).toEqual(["run_other--fix"]);
    // The task commits remain reachable — that is why the branch is not deleted with the directory.
    const keptBranch = await exec("git", ["rev-parse", "--verify", "refs/heads/dnafix/run_mine/fix"], { cwd: repo });
    expect(keptBranch.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("takes back a directory git no longer has registered", async () => {
    const created = await manager.createWorktree(repo, "run_orphan", "fix", base);
    await manager.removeRunWorktrees(repo, "run_orphan");
    // The half-crash this fallback is for: the directory is there, the registry is not.
    await mkdir(created.path, { recursive: true });
    await writeFile(path.join(created.path, "leftover.txt"), "stale");

    expect(await manager.removeRunWorktrees(repo, "run_orphan")).toEqual([created.path]);
    expect(await exists(created.path)).toBe(false);
  });

  it("walks past names it did not create and refuses ids it cannot name a directory with", async () => {
    await mkdir(worktreeRoot, { recursive: true });
    // Leftovers that live under the managed root but are not this run's `<run>--<task>`
    // directories, including one whose run id merely starts with the cleaned run id.
    const unmanaged = path.join(worktreeRoot, "run_prefix-extra");
    const lookalike = path.join(worktreeRoot, "run_prefixx--fix");
    await mkdir(unmanaged, { recursive: true });
    await mkdir(lookalike, { recursive: true });

    expect(await manager.removeRunWorktrees(repo, "run_prefix")).toEqual([]);
    expect(await exists(unmanaged)).toBe(true);
    expect(await exists(lookalike)).toBe(true);
    // Same shape test the reset path applies: a backup copy somebody dropped next to
    // the real worktrees shares the prefix but is not a `<run>--<task>` directory.
    const backup = path.join(worktreeRoot, "run_shape--fix.bak");
    const truncated = path.join(worktreeRoot, "run_shape--");
    await mkdir(backup, { recursive: true });
    await mkdir(truncated, { recursive: true });
    expect(await manager.removeRunWorktrees(repo, "run_shape")).toEqual([]);
    expect(await exists(backup)).toBe(true);
    expect(await exists(truncated)).toBe(true);
    await expect(manager.removeRunWorktrees(repo, "../run_mine")).rejects.toThrow(/Invalid run id/);
    await expect(manager.removeRunWorktrees(repo, "a/b")).rejects.toThrow(/Invalid run id/);
  });

  it("is a no-op over a worktree root that was never created", async () => {
    const absent = new GitWorktreeManager(path.join(root, "no-such-worktree-root"));
    expect(await absent.removeRunWorktrees(repo, "run_mine")).toEqual([]);
  });
});

describe("workspace reclaim around the pipeline", () => {
  it("takes the scratch back when the driver finishes the run", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const run = pullRequestStageRun("run_ws_completed", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);

    expect((await proc.store.getRun(run.id))?.state).toBe("COMPLETED");
    // The integration worktree this drive created is gone, and so is its registry entry.
    expect(await namesIn(path.join(ws.root, "worktrees"))).toEqual([]);
    const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
    expect(actions).toContain("workspace.removed");
    // Deleting the workspace must not touch the evidence the run record carries.
    const after = await proc.store.getRun(run.id);
    expect(after?.pullRequestUrl).toBe("https://github.com/acme/sample/pull/1");
    expect(after?.changedPaths).toEqual(["src/discount.ts"]);
  });

  it("leaves the workspace of every run that is only waiting", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const runs = new RunService(proc.deps);
    const parked: RunRecord["state"][] = ["BLOCKED", "AWAITING_PLAN_APPROVAL", "AWAITING_PR_APPROVAL", "NEEDS_CLARIFICATION", "AGENT_EXECUTION", "QUEUED"];
    for (const state of parked) {
      const run = pullRequestStageRun(`run_ws_${state.toLowerCase()}`, ws.repo, ws.baseCommitSha, { state });
      await proc.store.saveRun(run);
      // Stale scratch from the attempt that this run is about to resume or unblock into.
      const scratch = path.join(ws.root, "worktrees", `${run.id}--integration`);
      await mkdir(scratch, { recursive: true });

      expect(await runs.cleanWorkspace(run.id), state).toEqual([]);
      expect(await exists(scratch), state).toBe(true);
      const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
      expect(actions.filter((action) => action.startsWith("workspace.")), state).toEqual([]);
    }
  });

  it("reclaims on cancellation, which no driver is around to reclaim from", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const runs = new RunService(proc.deps);
    const run = pullRequestStageRun("run_ws_cancelled", ws.repo, ws.baseCommitSha, { state: "AGENT_EXECUTION" });
    await proc.store.saveRun(run);
    const scratch = path.join(ws.root, "worktrees", `${run.id}--integration`);
    await mkdir(scratch, { recursive: true });

    expect((await runs.cancel(run.id))?.state).toBe("CANCELLED");

    expect(await exists(scratch)).toBe(false);
    const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
    expect(actions).toContain("workspace.removed");
  });

  it("defers the reclaim to the process still driving a terminal run", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const runs = new RunService(proc.deps);
    const run = pullRequestStageRun("run_ws_live_lease", ws.repo, ws.baseCommitSha, {
      state: "COMPLETED",
      lease: { owner: "pid-another-process", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    await proc.store.saveRun(run);
    const scratch = path.join(ws.root, "worktrees", `${run.id}--integration`);
    await mkdir(scratch, { recursive: true });

    // Its own driver is on its way out and takes the directory with it; reaching in
    // now would only fail the phase that process is still inside.
    expect(await runs.cleanWorkspace(run.id)).toEqual([]);
    expect(await exists(scratch)).toBe(true);

    // A driver that died holding the lease is not coming back, so the reclaim goes ahead.
    const abandoned = (await proc.store.getRun(run.id))!;
    abandoned.lease = { owner: "pid-another-process", expiresAt: new Date(Date.now() - 1).toISOString() };
    await proc.store.saveRun(abandoned);
    expect(await runs.cleanWorkspace(run.id)).toEqual([scratch]);
    expect(await exists(scratch)).toBe(false);
  });

  it("audits a reclaim that failed instead of reporting an empty workspace", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    // A workspace root that cannot be swept is what a detached drive looks like from
    // here: the run is finished, the directories are still there, and the only honest
    // record left is the failure itself.
    proc.deps.worktrees = {
      removeRunWorktrees: async () => {
        throw new Error("worktree root is unreachable");
      },
    } as unknown as GitWorktreeManager;
    const runs = new RunService(proc.deps);
    const run = pullRequestStageRun("run_ws_cleanup_failed", ws.repo, ws.baseCommitSha, { state: "FAILED" });
    await proc.store.saveRun(run);

    expect(await runs.cleanWorkspace(run.id)).toEqual([]);
    const failed = await proc.store.listAudit(run.id);
    const event = failed.find((entry) => entry.action === "workspace.cleanup-failed");
    expect(event?.evidence).toContain("worktree root is unreachable");
    expect(failed.map((entry) => entry.action)).not.toContain("workspace.removed");
  });
});
