import { describe, expect, it } from "vitest";
import { ProjectDNAAdapter, RepositoryIntelligenceError } from "./index.js";

describe("ProjectDNAAdapter", () => {
  it("fails explicitly when PROJECT_DNA_PATH is not configured (no fabricated analysis)", async () => {
    const adapter = new ProjectDNAAdapter("");
    await expect(adapter.analyze({ rootPath: "C:\\repo", baseCommitSha: "abc1234", targetPaths: [] })).rejects.toBeInstanceOf(
      RepositoryIntelligenceError,
    );
  });
});
