import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectDNAAdapter, RepositoryIntelligenceError, projectDnaRuntime, resolveProjectDnaPath } from "./index.js";

const submoduleEntry = path.resolve(process.cwd(), "vendor", "Project-DNA", "packages", "dna-core", "src", "index.ts");

describe("resolveProjectDnaPath", () => {
  it("prefers an explicit path and trims surrounding whitespace", () => {
    expect(resolveProjectDnaPath("  D:\\tools\\Project-DNA  ")).toBe("D:\\tools\\Project-DNA");
  });

  it("finds the vendor submodule even when the process started in an app directory", () => {
    if (!existsSync(submoduleEntry)) return;
    const cwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      expect(resolveProjectDnaPath("")).toMatch(/vendor[\\/]Project-DNA$/);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("projectDnaRuntime", () => {
  it("uses an isolated runtime when pinned, otherwise the one DNAFix runs on", () => {
    const previous = process.env.PROJECT_DNA_NODE_PATH;
    process.env.PROJECT_DNA_NODE_PATH = " D:\\tools\\node-22.23.2\\node.exe ";
    try {
      expect(projectDnaRuntime()).toBe("D:\\tools\\node-22.23.2\\node.exe");
    } finally {
      if (previous === undefined) delete process.env.PROJECT_DNA_NODE_PATH;
      else process.env.PROJECT_DNA_NODE_PATH = previous;
    }
    expect(projectDnaRuntime()).toBe(process.execPath);
  });
});

describe("ProjectDNAAdapter", () => {
  it("reports the resolved checkout so readiness matches what the pipeline will use", () => {
    expect(new ProjectDNAAdapter("D:\\x\\Project-DNA").location).toBe("D:\\x\\Project-DNA");
    expect(new ProjectDNAAdapter("").location).toBeNull();
  });

  it("fails explicitly when PROJECT_DNA_PATH is not configured (no fabricated analysis)", async () => {
    const adapter = new ProjectDNAAdapter("");
    await expect(adapter.analyze({ rootPath: "C:\\repo", baseCommitSha: "abc1234", targetPaths: [] })).rejects.toBeInstanceOf(
      RepositoryIntelligenceError,
    );
  });
});
