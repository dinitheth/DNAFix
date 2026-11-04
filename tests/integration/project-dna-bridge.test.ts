import { execFile } from "node:child_process";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProjectDNAAdapter, resolveProjectDnaPath } from "@dnafix/repository-intelligence";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "fixtures", "sample-repo");
const dnaPath = resolveProjectDnaPath();

describe.skipIf(!dnaPath)("Project DNA bridge (real analysis, requires the vendor/Project-DNA checkout)", () => {
  it("analyses the fixture repo at the exact base commit and returns impact for a target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-dna-"));
    const repo = path.join(root, "repo");
    await cp(FIXTURE, repo, { recursive: true });
    const git = (args: string[]) => exec("git", args, { cwd: repo });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    await git(["add", "-A"]);
    await git(["commit", "-m", "init"]);
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();

    const adapter = new ProjectDNAAdapter(dnaPath);
    const report = await adapter.analyze({ rootPath: repo, baseCommitSha: sha, targetPaths: ["src/discount.ts"] });
    expect(report.baseCommitSha).toBe(sha);
    expect(report.repositoryId).toBeTruthy();
    expect(report.files).toContain("src/discount.ts");
    const target = report.targets.find((t) => t.targetPath === "src/discount.ts");
    expect(target).toBeDefined();
    // src/cart.ts imports src/discount.ts, so deterministic impact must surface it (path or entity form).
    const impacted = [...(target?.directImpacted ?? []), ...(target?.transitiveImpacted ?? [])].join(" ");
    expect(impacted).toContain("cart");
  }, 600_000);
});
