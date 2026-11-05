import { access, stat } from "node:fs/promises";
import path from "node:path";

/**
 * A repository record is a fact about a path this host held when an analysis was
 * registered. Runs then block at repository preparation with a filesystem error
 * the operator cannot see from the list, so the list reports what it can check.
 */
export type CheckoutState = "present" | "no-git" | "missing" | "not-checked-out";

export async function checkoutStateFor(localPath: string | null): Promise<CheckoutState> {
  if (!localPath?.trim()) return "not-checked-out";
  const info = await stat(localPath).catch(() => null);
  if (!info?.isDirectory()) return "missing";
  // A submodule-style repository keeps its gitdir in a .git *file*, so only the
  // name's presence is meaningful.
  return (await access(path.join(localPath, ".git")).then(() => true, () => false)) ? "present" : "no-git";
}

export type RepositoryWithCheckoutState<T> = T & { checkoutState: CheckoutState };

export async function withCheckoutState<T extends { localPath: string | null }>(record: T): Promise<RepositoryWithCheckoutState<T>> {
  return { ...record, checkoutState: await checkoutStateFor(record.localPath) };
}
