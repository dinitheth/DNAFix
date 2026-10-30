import { RepoPathSchema, type FilePatchOperation } from "@dnafix/contracts";

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

/** Normalize a candidate path to POSIX repo-relative form, rejecting traversal/absolute forms. */
export function normalizeRepoPath(input: string): string {
  const posix = input.replaceAll("\\", "/");
  const parsed = RepoPathSchema.safeParse(posix);
  if (!parsed.success) throw new ScopeViolationError(`Unsafe repository path: ${JSON.stringify(input)}`);
  return parsed.data;
}

export function isPathInScope(path: string, scope: readonly string[]): boolean {
  const normalized = normalizeRepoPath(path);
  return scope.some((entry) => {
    const s = normalizeRepoPath(entry);
    return normalized === s || normalized.startsWith(`${s}/`);
  });
}

export function assertOperationsInScope(operations: readonly FilePatchOperation[], scope: readonly string[]): void {
  for (const op of operations) {
    if (!isPathInScope(op.path, scope)) {
      throw new ScopeViolationError(`Patch path '${op.path}' is outside the task file scope [${scope.join(", ")}]`);
    }
  }
}
