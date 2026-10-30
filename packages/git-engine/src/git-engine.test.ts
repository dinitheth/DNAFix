import { execFile } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GitWorktreeManager, resolveInside } from "./index.js";

const exec = promisify(execFile);
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/sample-repo");

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout;
}

describe("GitWorktreeManager", () => {
  it("creates isolated worktrees, collects diffs, commits and integrates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-git-"));
    const repo = path.join(root, "repo");
    await cp(FIXTURE, repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "init"]);

    const manager = new GitWorktreeManager(path.join(root, "worktrees"));
    const base = await manager.headSha(repo);
    const wt = await manager.createWorktree(repo, "run1", "taskA", base);
    expect(wt.branch).toBe("dnafix/run1/taskA");

    await writeFile(path.join(wt.path, "src", "discount.ts"), "export const fixed = true;\n");
    const { changedPaths } = await manager.collectDiff(wt.path);
    expect(changedPaths).toContain("src/discount.ts");
    const sha = await manager.commitAll(wt.path, "task A");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const integration = await manager.createWorktree(repo, "run1", "integration", base);
    await manager.integrateCommit(integration.path, sha!);
    const range = await manager.diffRange(integration.path, base);
    expect(range.changedPaths).toContain("src/discount.ts");
  });

  it("resetToCommit restores a dirty worktree to the pinned base (retry isolation)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-git-"));
    const repo = path.join(root, "repo");
    await cp(FIXTURE, repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "init"]);
    const manager = new GitWorktreeManager(path.join(root, "worktrees"));
    const base = await manager.headSha(repo);
    const wt = await manager.createWorktree(repo, "run2", "taskA", base);
    // Simulate a failed attempt: delete a tracked file and add junk.
    const { rm } = await import("node:fs/promises");
    await rm(path.join(wt.path, "src", "discount.ts"));
    await writeFile(path.join(wt.path, "junk.txt"), "junk");
    await manager.resetToCommit(wt.path, base);
    const status = await git(wt.path, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(wt.path, "src", "discount.ts"), "utf8")).toContain("applyDiscount");
  });

  it("reuses only validated existing worktrees; unexpected git errors propagate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-git-"));
    const repo = path.join(root, "repo");
    await cp(FIXTURE, repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@t"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "init"]);
    const manager = new GitWorktreeManager(path.join(root, "worktrees"));
    const base = await manager.headSha(repo);

    // Fresh creation.
    const created = await manager.createOrReuseWorktree(repo, "run3", "taskA", base);
    expect(created.reused).toBe(false);

    // Dirty the worktree (tracked + untracked), then reuse: validated and reset to the pinned base.
    await writeFile(path.join(created.info.path, "src", "discount.ts"), "corrupted");
    await writeFile(path.join(created.info.path, "junk.txt"), "junk");
    const reused = await manager.createOrReuseWorktree(repo, "run3", "taskA", base);
    expect(reused.reused).toBe(true);
    await manager.resetToCommit(reused.info.path, base);
    expect((await git(reused.info.path, ["status", "--porcelain"])).trim()).toBe("");
    expect(await manager.headSha(reused.info.path)).toBe(base);

    // Unknown task has no registered worktree: validation fails and creation error propagates (no silent fallback).
    await expect(manager.validateExistingWorktree(repo, "run3", "taskB")).rejects.toThrow(/not registered/);
    // Non-git repository: creation failure must propagate, not be treated as reuse.
    const notARepo = path.join(root, "not-a-repo");
    await cp(FIXTURE, notARepo, { recursive: true });
    await expect(manager.createOrReuseWorktree(notARepo, "run3", "taskA", base)).rejects.toThrow(/git worktree add failed|not a git repository|git rev-parse/);
    // Reset refuses non-managed paths.
    await expect(manager.resetToCommit(notARepo, base)).rejects.toThrow(/not a DNAFix-managed worktree/);
  });

  it("rejects path traversal and worktree removal with active tasks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-git-"));
    await expect(resolveInside(root, "../escape")).rejects.toThrow(/escapes/);
    const manager = new GitWorktreeManager(root);
    await expect(manager.removeWorktree(root, root, { hasActiveTask: true })).rejects.toThrow(/active task/);
    await expect(manager.createWorktree(root, "../evil", "t", "abc1234")).rejects.toThrow(/Invalid run id/);
  });
});
