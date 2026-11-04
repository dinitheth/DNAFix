import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRepositoryPathAllowed, configuredRepositoryRoots, isLanBindEnabled, isRemoteBind, RepositoryPathError } from "./repository-policy.js";

async function fixture(): Promise<{ root: string; inside: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "dnafix-policy-"));
  const root = path.join(base, "allowed");
  const inside = path.join(root, "repo");
  const outside = path.join(base, "other");
  for (const dir of [inside, outside]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), "{}", "utf8");
  }
  return { root, inside, outside };
}

describe("repository path policy", () => {
  it("parses ;-separated roots so Windows drive letters survive", () => {
    expect(configuredRepositoryRoots({ DNAFIX_ALLOWED_REPOSITORY_ROOTS: "C:\\repos;D:\\work" })).toEqual(["C:\\repos", "D:\\work"]);
    expect(configuredRepositoryRoots({})).toEqual([]);
  });

  it("treats only loopback hosts as local", () => {
    expect(isRemoteBind("127.0.0.1")).toBe(false);
    expect(isRemoteBind("localhost")).toBe(false);
    expect(isRemoteBind("::1")).toBe(false);
    expect(isRemoteBind("0.0.0.0")).toBe(true);
    expect(isRemoteBind("192.168.0.9")).toBe(true);
    expect(isLanBindEnabled({ DNAFIX_ALLOW_LAN_BIND: "TRUE" })).toBe(true);
    expect(isLanBindEnabled({})).toBe(false);
  });

  it("canonicalises an allowed path instead of trusting what the client sent", async () => {
    const { root, inside } = await fixture();
    const messy = path.join(root, "..", path.basename(root), ".", "repo");
    const resolved = await assertRepositoryPathAllowed(`${messy}${path.sep}..${path.sep}repo`, [root]);
    expect(resolved).toBe(await realpath(inside));
  });

  it("rejects a repository outside the configured roots", async () => {
    const { root, outside } = await fixture();
    await expect(assertRepositoryPathAllowed(outside, [root])).rejects.toThrow(RepositoryPathError);
  });

  it("rejects a symlink that points outside the roots", async (ctx) => {
    const { root, inside, outside } = await fixture();
    const escape = path.join(inside, "escape");
    // Creating a symlink on Windows needs developer mode or elevation.
    const created = await symlink(outside, escape).then(
      () => true,
      () => false,
    );
    if (!created) ctx.skip();
    // realpath resolves the link before the containment test, so the escape is
    // judged by its target rather than by the link's location.
    await expect(assertRepositoryPathAllowed(escape, [root])).rejects.toThrow(/outside DNAFIX_ALLOWED_REPOSITORY_ROOTS/);
  });

  it("rejects a path that does not exist", async () => {
    const { root } = await fixture();
    await expect(assertRepositoryPathAllowed(path.join(root, "nope"), [root])).rejects.toThrow(/does not exist/);
  });

  it("rejects UNC paths and embedded NUL bytes", async () => {
    await expect(assertRepositoryPathAllowed("\\\\fileserver\\share\\repo")).rejects.toThrow(/UNC/);
    await expect(assertRepositoryPathAllowed("C:\\repos\0evil")).rejects.toThrow(/NUL/);
  });

  it("allows any existing path when no roots are configured, which only loopback may do", async () => {
    const { outside } = await fixture();
    expect(await assertRepositoryPathAllowed(outside, [])).toBe(await realpath(outside));
  });
});
