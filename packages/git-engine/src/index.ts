import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string = "",
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(" ")} failed: ${e.message}`, e.stderr ?? "");
  }
}

export function assertValidId(id: string, kind: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(id)) throw new GitError(`Invalid ${kind} id: ${JSON.stringify(id)}`);
  return id;
}

/** Resolve candidate inside root, rejecting symlink escapes. Root must exist. */
export async function resolveInside(root: string, candidate: string): Promise<string> {
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, candidate);
  // Resolve the deepest existing ancestor to catch symlinked parents.
  let existing = absolute;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  const realExisting = await realpath(existing).catch(() => existing);
  const rel = path.relative(realRoot, realExisting);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new GitError(`Path escapes its root: ${candidate}`);
  }
  return absolute;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseCommitSha: string;
}

export class GitWorktreeManager {
  constructor(private readonly worktreeRoot: string) {}

  /** Deterministic worktree path for a run/task pair (used for resume after restart). */
  worktreePathFor(runId: string, taskId: string): string {
    assertValidId(runId, "run");
    assertValidId(taskId, "task");
    return path.join(this.worktreeRoot, `${runId}--${taskId}`);
  }

  async headSha(repoPath: string): Promise<string> {
    return (await git(repoPath, ["rev-parse", "HEAD"])).trim();
  }

  async currentBranch(repoPath: string): Promise<string> {
    return (await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  async isGitRepository(repoPath: string): Promise<boolean> {
    try {
      await git(repoPath, ["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  async createWorktree(repoPath: string, runId: string, taskId: string, baseCommitSha: string): Promise<WorktreeInfo> {
    assertValidId(runId, "run");
    assertValidId(taskId, "task");
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommitSha)) throw new GitError(`Invalid base commit: ${baseCommitSha}`);
    await mkdir(this.worktreeRoot, { recursive: true });
    const dirName = `${runId}--${taskId}`;
    const wtPath = await resolveInside(this.worktreeRoot, dirName);
    const branch = `dnafix/${runId}/${taskId}`;
    await git(repoPath, ["worktree", "add", "-b", branch, wtPath, baseCommitSha]);
    return { path: wtPath, branch, baseCommitSha };
  }

  /** Stage everything in the worktree and return the diff against HEAD. */
  async collectDiff(worktreePath: string): Promise<{ diff: string; changedPaths: string[] }> {
    await git(worktreePath, ["add", "-A"]);
    const changedPaths = (await git(worktreePath, ["diff", "--cached", "--name-only"]))
      .split("\n")
      .map((s) => s.trim().replaceAll("\\", "/"))
      .filter(Boolean);
    const diff = await git(worktreePath, ["diff", "--cached", "--no-color"]);
    return { diff, changedPaths };
  }

  async commitAll(worktreePath: string, message: string): Promise<string | null> {
    await git(worktreePath, ["add", "-A"]);
    const status = await git(worktreePath, ["status", "--porcelain"]);
    if (!status.trim()) return null;
    await git(worktreePath, [
      "-c",
      "user.name=DNAFix",
      "-c",
      "user.email=dnafix@localhost",
      "commit",
      "-m",
      message,
    ]);
    return (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
  }

  /**
   * Hard-reset a worktree to a pinned commit and remove untracked files.
   * Only operates on DNAFix-managed worktree paths (direct child of the
   * configured worktree root); anything else is refused.
   */
  async resetToCommit(worktreePath: string, baseCommitSha: string): Promise<void> {
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommitSha)) throw new GitError(`Invalid base commit: ${baseCommitSha}`);
    const root = path.resolve(this.worktreeRoot);
    const resolved = path.resolve(worktreePath);
    if (path.dirname(resolved) !== root || !/^[a-zA-Z0-9][a-zA-Z0-9-_]*--[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(path.basename(resolved))) {
      throw new GitError(`Refusing to reset a path that is not a DNAFix-managed worktree: ${worktreePath}`);
    }
    await git(worktreePath, ["reset", "--hard", baseCommitSha]);
    await git(worktreePath, ["clean", "-fd"]);
  }

  /**
   * Validate that an existing worktree is exactly the one DNAFix expects for
   * (runId, taskId): managed path, registered in `git worktree list`, owned by
   * this repository, on the expected branch, with a verifiable HEAD.
   * Throws GitError on any mismatch — callers must not fall back silently.
   */
  async validateExistingWorktree(repoPath: string, runId: string, taskId: string): Promise<WorktreeInfo> {
    const expectedPath = this.worktreePathFor(runId, taskId);
    const expectedBranch = `dnafix/${runId}/${taskId}`;
    const porcelain = await git(repoPath, ["worktree", "list", "--porcelain"]);
    const entries = porcelain.split(/\r?\n\r?\n/).map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split(/\r?\n/)) {
        const idx = line.indexOf(" ");
        if (idx > 0) fields.set(line.slice(0, idx), line.slice(idx + 1).trim());
      }
      return fields;
    });
    const normalize = (p: string) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
    const entry = entries.find((e) => normalize(e.get("worktree") ?? "") === normalize(expectedPath));
    if (!entry) {
      throw new GitError(`Worktree for ${runId}/${taskId} is not registered in repository ${repoPath} (expected ${expectedPath})`);
    }
    const branchRef = entry.get("branch") ?? "";
    if (branchRef !== `refs/heads/${expectedBranch}`) {
      throw new GitError(`Worktree ${expectedPath} is on branch '${branchRef}', expected 'refs/heads/${expectedBranch}' (ownership mismatch)`);
    }
    const head = entry.get("HEAD") ?? "";
    if (!/^[0-9a-f]{40}$/i.test(head)) throw new GitError(`Worktree ${expectedPath} has no verifiable HEAD commit`);
    return { path: expectedPath, branch: expectedBranch, baseCommitSha: head };
  }

  /**
   * Create a fresh worktree, or — only when creation fails AND an existing
   * worktree validates — reuse the validated one. Unexpected git errors and
   * validation failures propagate; there is no silent fallback.
   */
  async createOrReuseWorktree(repoPath: string, runId: string, taskId: string, baseCommitSha: string): Promise<{ info: WorktreeInfo; reused: boolean }> {
    try {
      return { info: await this.createWorktree(repoPath, runId, taskId, baseCommitSha), reused: false };
    } catch (createErr) {
      let existing: WorktreeInfo;
      try {
        existing = await this.validateExistingWorktree(repoPath, runId, taskId);
      } catch {
        throw createErr; // Not a reusable worktree: surface the original creation error.
      }
      return { info: { ...existing, baseCommitSha }, reused: true };
    }
  }

  /** Cherry-pick a task commit into the integration worktree. Fails loudly on conflict; never discards changes. */
  async integrateCommit(integrationWorktree: string, commitSha: string): Promise<void> {
    if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) throw new GitError(`Invalid commit: ${commitSha}`);
    try {
      await git(integrationWorktree, ["-c", "user.name=DNAFix", "-c", "user.email=dnafix@localhost", "cherry-pick", commitSha]);
    } catch (err) {
      await git(integrationWorktree, ["cherry-pick", "--abort"]).catch(() => undefined);
      throw err;
    }
  }

  async diffRange(worktreePath: string, baseCommitSha: string): Promise<{ diff: string; changedPaths: string[] }> {
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommitSha)) throw new GitError(`Invalid base commit: ${baseCommitSha}`);
    const changedPaths = (await git(worktreePath, ["diff", "--name-only", `${baseCommitSha}..HEAD`]))
      .split("\n")
      .map((s) => s.trim().replaceAll("\\", "/"))
      .filter(Boolean);
    const diff = await git(worktreePath, ["diff", "--no-color", `${baseCommitSha}..HEAD`]);
    return { diff, changedPaths };
  }

  async pushBranch(worktreePath: string, remoteUrlWithToken: string, branch: string): Promise<void> {
    if (!/^dnafix\/[a-zA-Z0-9-_\/]+$/.test(branch)) throw new GitError(`Refusing to push unexpected branch: ${branch}`);
    // Token-bearing URL is passed as an argv value and never logged by this layer.
    await git(worktreePath, ["push", remoteUrlWithToken, `HEAD:refs/heads/${branch}`]);
  }

  /** Push without placing the installation token in the remote URL or argv. */
  async pushBranchWithToken(worktreePath: string, remoteUrl: string, branch: string, token: string): Promise<void> {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(remoteUrl)) throw new GitError(`Refusing to push to non-GitHub or malformed URL: ${remoteUrl}`);
    if (!/^dnafix\/[a-zA-Z0-9-_\/]+$/.test(branch)) throw new GitError(`Refusing to push unexpected branch: ${branch}`);
    if (!token) throw new GitError("Refusing to push without an installation token");
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: header,
    };
    await exec("git", ["push", remoteUrl, `HEAD:refs/heads/${branch}`], { cwd: worktreePath, timeout: 300_000, windowsHide: true, env }).catch(
      (err: Error & { stderr?: string }) => {
        const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
        const redact = (text: string) => text.split(token).join("[redacted]").split(encoded).join("[redacted]");
        throw new GitError(`git push failed: ${redact(err.message)}`, redact(err.stderr ?? ""));
      },
    );
  }

  async removeWorktree(repoPath: string, worktreePath: string, opts: { force?: boolean; hasActiveTask?: boolean } = {}): Promise<void> {
    if (opts.hasActiveTask) throw new GitError("Refusing to delete a worktree with an active task");
    const args = ["worktree", "remove", worktreePath];
    if (opts.force) args.push("--force");
    await git(repoPath, args);
  }

  async listWorktrees(repoPath: string): Promise<string[]> {
    const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
  }
}

export async function cloneRepository(url: string, dest: string, ref?: string): Promise<void> {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(url)) {
    throw new GitError(`Refusing to clone non-GitHub or malformed URL: ${url}`);
  }
  const args = ["clone", "--no-checkout", url, dest];
  await exec("git", args, { timeout: 300_000, windowsHide: true }).catch((err: Error & { stderr?: string }) => {
    throw new GitError(`git clone failed: ${err.message}`, err.stderr ?? "");
  });
  if (ref) await git(dest, ["checkout", ref]);
}

function redactToken(text: string, token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("[redacted]").split(encoded).join("[redacted]");
}

/**
 * Clone a private GitHub repository with an installation access token.
 * The credential is passed through Git's environment-based config so it never
 * appears in argv or in a persisted remote URL, and it is redacted from errors.
 */
export async function cloneRepositoryWithToken(url: string, dest: string, token: string, ref?: string): Promise<void> {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(url)) {
    throw new GitError(`Refusing to clone non-GitHub or malformed URL: ${url}`);
  }
  if (!token) throw new GitError("Refusing to clone a private repository without an installation token");
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: header,
  };
  const args = ["clone", "--no-checkout", url, dest];
  await exec("git", args, { timeout: 300_000, windowsHide: true, env }).catch((err: Error & { stderr?: string }) => {
    const message = redactToken(err.message, token);
    throw new GitError(`git clone failed: ${message}`, redactToken(err.stderr ?? "", token));
  });
  if (ref) await git(dest, ["checkout", ref]);
}
