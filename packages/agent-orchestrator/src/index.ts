import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FilePatchOperation, ImplementationTask } from "@dnafix/contracts";
import { ScopeViolationError, assertOperationsInScope } from "@dnafix/domain";
import { resolveInside } from "@dnafix/git-engine";
import type { ModelProvider } from "@dnafix/model-provider";

export class PatchApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplicationError";
  }
}

const MAX_FILE_CHARS = 60_000;

export interface ApplyOptions {
  /**
   * Deletion policy (deny-by-default, hardened after eval-v1 observed a repair
   * patch deleting a core source file): a `delete` operation is permitted only
   * for exact repository paths listed here. The list comes from the task's
   * plan-approved `approvedDeletions`. Undefined or empty means no deletions.
   */
  allowedDeletePaths?: readonly string[];
}

/**
 * Applies validated patch operations inside a worktree.
 * Defenses: task scope check, worktree containment (symlink-aware), exact-anchor replace.
 */
export async function applyPatchOperations(worktreePath: string, operations: readonly FilePatchOperation[], scope: readonly string[], opts: ApplyOptions = {}): Promise<void> {
  assertOperationsInScope(operations, scope);
  const allowedDeletes = new Set((opts.allowedDeletePaths ?? []).map((p) => p.replaceAll("\\", "/")));
  for (const op of operations) {
    if (op.type === "delete" && !allowedDeletes.has(op.path.replaceAll("\\", "/"))) {
      throw new PatchApplicationError(
        `delete of '${op.path}' denied: path is not in the explicitly approved deletion allowlist [${[...allowedDeletes].join(", ") || "empty"}] (deny-by-default)`,
      );
    }
    const target = await resolveInside(worktreePath, op.path);
    if (op.type === "create") {
      await mkdir(path.dirname(target), { recursive: true });
      const safe = await resolveInside(worktreePath, op.path);
      await writeFile(safe, op.content, { encoding: "utf8", flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") throw new PatchApplicationError(`create: file already exists: ${op.path}`);
        throw err;
      });
    } else if (op.type === "replace") {
      const current = await readFile(target, "utf8").catch(() => {
        throw new PatchApplicationError(`replace: file not found: ${op.path}`);
      });
      let search = op.search;
      let replacement = op.replace;
      let occurrences = current.split(search).length - 1;
      if (occurrences !== 1) {
        // Line-ending tolerance: model anchors are LF; Windows checkouts may be CRLF.
        const eol = current.includes("\r\n") ? "\r\n" : "\n";
        const altSearch = op.search.replaceAll("\r\n", "\n").replaceAll("\n", eol);
        const altOccurrences = current.split(altSearch).length - 1;
        if (altOccurrences === 1) {
          search = altSearch;
          replacement = op.replace.replaceAll("\r\n", "\n").replaceAll("\n", eol);
          occurrences = altOccurrences;
        }
      }
      if (occurrences !== 1) {
        throw new PatchApplicationError(`replace: anchor for ${op.path} occurs ${occurrences} times (expected exactly 1); refusing ambiguous patch`);
      }
      await writeFile(target, current.replace(search, replacement), "utf8");
    } else {
      await rm(target).catch(() => {
        throw new PatchApplicationError(`delete: file not found: ${op.path}`);
      });
    }
  }
}

export async function readScopedFiles(worktreePath: string, scope: readonly string[]): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of scope) {
    const target = await resolveInside(worktreePath, entry).catch(() => null);
    if (!target) continue;
    const content = await readFile(target, "utf8").catch(() => null);
    if (content !== null) files.push({ path: entry, content: content.slice(0, MAX_FILE_CHARS) });
  }
  return files;
}

export interface CodingTaskContext {
  issueTitle: string;
  issueBody: string;
  worktreePath: string;
  failureContext?: string;
}

/** A coding agent: one bounded task, one worktree, declared scope only. It cannot expand its own scope. */
export class CodingAgent {
  constructor(private readonly model: ModelProvider) {}

  async execute(task: ImplementationTask, ctx: CodingTaskContext): Promise<{ summary: string; operations: FilePatchOperation[] }> {
    const files = await readScopedFiles(ctx.worktreePath, task.fileScope);
    const patch = await this.model.generatePatch({
      task,
      issueTitle: ctx.issueTitle,
      issueBody: ctx.issueBody,
      files,
      failureContext: ctx.failureContext,
    });
    // Defense in depth: the orchestrator re-validates scope even though the model was instructed.
    try {
      assertOperationsInScope(patch.operations, task.fileScope);
    } catch (err) {
      if (err instanceof ScopeViolationError) throw new PatchApplicationError(`Model patch rejected: ${err.message}`);
      throw err;
    }
    // Every execution passes the deletion policy explicitly: only the exact
    // paths approved in the (human-approved) implementation plan may be deleted.
    await applyPatchOperations(ctx.worktreePath, patch.operations, task.fileScope, { allowedDeletePaths: task.approvedDeletions ?? [] });
    return { summary: patch.summary, operations: patch.operations };
  }
}

/** Independent verifier: read-only. Deterministic test results remain authoritative. */
export class VerificationAgent {
  constructor(private readonly model: ModelProvider) {}
  async review(input: Parameters<ModelProvider["reviewVerification"]>[0]) {
    return this.model.reviewVerification(input);
  }
}
