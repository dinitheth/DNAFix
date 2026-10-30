import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodingAgent, PatchApplicationError, applyPatchOperations } from "./index.js";
import type { ModelProvider } from "@dnafix/model-provider";

describe("applyPatchOperations", () => {
  it("applies a replace with LF anchors to a CRLF file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-patch-"));
    await writeFile(path.join(dir, "a.ts"), "line1\r\nold\r\nline3\r\n");
    await applyPatchOperations(dir, [{ type: "replace", path: "a.ts", search: "old", replace: "new" }], ["a.ts"]);
    expect(await readFile(path.join(dir, "a.ts"), "utf8")).toContain("new");
  });

  it("refuses ambiguous anchors and out-of-scope paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-patch-"));
    await writeFile(path.join(dir, "a.ts"), "x x");
    await expect(applyPatchOperations(dir, [{ type: "replace", path: "a.ts", search: "x", replace: "y" }], ["a.ts"])).rejects.toBeInstanceOf(PatchApplicationError);
    await expect(applyPatchOperations(dir, [{ type: "create", path: "b.ts", content: "y" }], ["a.ts"])).rejects.toThrow(/outside the task file scope/);
  });

  describe("deletion policy (deny-by-default, exact-path allowlist)", () => {
    it("denies deletion when the permission option is undefined", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "dnafix-patch-"));
      await writeFile(path.join(dir, "a.ts"), "content");
      await expect(applyPatchOperations(dir, [{ type: "delete", path: "a.ts" }], ["a.ts"])).rejects.toThrow(/deny-by-default/);
      expect(await readFile(path.join(dir, "a.ts"), "utf8")).toBe("content");
    });

    it("denies deletion when the allowlist is explicitly empty", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "dnafix-patch-"));
      await writeFile(path.join(dir, "a.ts"), "content");
      await expect(applyPatchOperations(dir, [{ type: "delete", path: "a.ts" }], ["a.ts"], { allowedDeletePaths: [] })).rejects.toThrow(/deny-by-default/);
      expect(await readFile(path.join(dir, "a.ts"), "utf8")).toBe("content");
    });

    it("permits deletion of an exactly allowlisted path", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "dnafix-patch-"));
      await writeFile(path.join(dir, "a.ts"), "content");
      await applyPatchOperations(dir, [{ type: "delete", path: "a.ts" }], ["a.ts"], { allowedDeletePaths: ["a.ts"] });
      await expect(readFile(path.join(dir, "a.ts"), "utf8")).rejects.toThrow();
    });

    it("denies deletion of a path outside the allowlist (including prefix matches)", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "dnafix-patch-"));
      await writeFile(path.join(dir, "a.ts"), "content");
      await writeFile(path.join(dir, "b.ts"), "content");
      await expect(applyPatchOperations(dir, [{ type: "delete", path: "b.ts" }], ["a.ts", "b.ts"], { allowedDeletePaths: ["a.ts"] })).rejects.toThrow(/deny-by-default/);
      await expect(applyPatchOperations(dir, [{ type: "delete", path: "a.ts" }], ["a.ts"], { allowedDeletePaths: ["a"] })).rejects.toThrow(/deny-by-default/);
      expect(await readFile(path.join(dir, "b.ts"), "utf8")).toBe("content");
    });
  });

  it("CodingAgent rejects a repair-style delete of a core file and leaves it untouched", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-patch-"));
    await writeFile(path.join(dir, "core.ts"), "export const core = true;\n");
    const deletingModel: ModelProvider = {
      name: "test-double",
      modelId: "test-double",
      analyzeAndPlan: async () => {
        throw new Error("not used");
      },
      generatePatch: async () => ({ summary: "delete the core file", operations: [{ type: "delete", path: "core.ts" }] }),
      reviewVerification: async () => {
        throw new Error("not used");
      },
    };
    const agent = new CodingAgent(deletingModel);
    await expect(
      agent.execute(
        {
          id: "repair-1",
          title: "repair",
          description: "repair",
          expectedOutcome: "fixed",
          fileScope: ["core.ts"],
          dependsOn: [],
          acceptanceCriteria: ["works"],
          testExpectations: [],
          retryLimit: 0,
          // repair tasks carry no approvedDeletions
        },
        { issueTitle: "i", issueBody: "b", worktreePath: dir },
      ),
    ).rejects.toThrow(/deny-by-default/);
    expect(await readFile(path.join(dir, "core.ts"), "utf8")).toContain("core = true");
  });
});
