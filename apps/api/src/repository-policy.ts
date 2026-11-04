import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem containment for repository paths supplied by a client.
 *
 * A run executes the target repository's own build and test scripts, so an
 * unconstrained path is code execution anywhere on the host. Paths are
 * canonicalised with realpath, which collapses `..` segments and resolves
 * symlinks before the containment test, so neither traversal nor a symlink
 * pointing outside an allowed root can pass it.
 */
export class RepositoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryPathError";
  }
}

/**
 * Roots are `;`-separated because `:` is part of a Windows drive letter.
 * Unset means no containment list, which is only permitted on a loopback bind.
 */
export function configuredRepositoryRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DNAFIX_ALLOWED_REPOSITORY_ROOTS ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isLanBindEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DNAFIX_ALLOW_LAN_BIND ?? "false").trim().toLowerCase() === "true";
}

/** True when `host` is reachable from outside this machine. */
export function isRemoteBind(host: string): boolean {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return false;
  return true;
}

function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Canonicalise a requested repository path and, when roots are configured,
 * reject anything outside them. Also rejects a path that does not exist, so a
 * typo cannot silently create an empty worktree elsewhere.
 */
export async function assertRepositoryPathAllowed(requested: string, roots: string[] = configuredRepositoryRoots()): Promise<string> {
  if (!requested.trim()) throw new RepositoryPathError("Repository path is required.");
  if (requested.includes("\0")) throw new RepositoryPathError("Repository path contains a NUL byte.");
  // A UNC or drive-qualified path is only meaningful on Windows; reject the
  // network forms everywhere so a crafted value cannot reach a remote provider.
  if (/^\\\\[^\\]+\\/.test(requested)) throw new RepositoryPathError("UNC repository paths are not allowed.");

  const real = await realpath(path.resolve(requested)).catch(() => null);
  if (!real) throw new RepositoryPathError(`Repository path does not exist: ${requested}`);
  if (roots.length === 0) return real;

  for (const root of roots) {
    const realRoot = await realpath(path.resolve(root)).catch(() => null);
    if (realRoot && within(realRoot, real)) return real;
  }
  throw new RepositoryPathError(`Repository ${real} is outside DNAFIX_ALLOWED_REPOSITORY_ROOTS (${roots.join(", ")}).`);
}
