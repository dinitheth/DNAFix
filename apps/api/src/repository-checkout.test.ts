import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutStateFor, withCheckoutState } from "./repository-checkout.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "dnafix-checkout-"));
}

describe("repository checkout state", () => {
  it("separates a git repository from a plain directory and a dead path", async () => {
    const root = await tempRoot();
    const plain = path.join(root, "plain");
    const gitDir = path.join(root, "git-dir");
    const gitFile = path.join(root, "git-worktree");
    await mkdir(plain);
    await mkdir(path.join(gitDir, ".git"), { recursive: true });
    await mkdir(gitFile);
    await writeFile(path.join(gitFile, ".git"), "gitdir: ../elsewhere/.git/worktrees/x\n");

    expect(await checkoutStateFor(plain)).toBe("no-git");
    expect(await checkoutStateFor(gitDir)).toBe("present");
    expect(await checkoutStateFor(gitFile)).toBe("present");
    expect(await checkoutStateFor(path.join(root, "gone"))).toBe("missing");
    expect(await checkoutStateFor(null)).toBe("not-checked-out");
    expect(await checkoutStateFor("   ")).toBe("not-checked-out");
  });

  it("reports a mangled Windows path as missing rather than inventing a state", async () => {
    // What an unescaped "G:\\repo" literal collapses to after JSON round-tripping.
    expect(await checkoutStateFor("G:repo\x0Cixture")).toBe("missing");
  });

  it("keeps the stored record intact and only adds the checked state", async () => {
    const root = await tempRoot();
    const decorated = await withCheckoutState({ id: "local_1", localPath: root });
    expect(decorated).toEqual({ id: "local_1", localPath: root, checkoutState: "no-git" });
  });
});
