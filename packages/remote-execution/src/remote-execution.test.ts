import { describe, expect, it } from "vitest";
import { CodeBuildExecutionProvider, buildspecFor, type CliRunner } from "./index.js";

describe("buildspec generation", () => {
  it("renders argv safely without shell strings", () => {
    const spec = buildspecFor(["pnpm", "test", "--", "a b"]);
    expect(spec).toContain("- pnpm test -- 'a b'");
  });
});

describe("CodeBuildExecutionProvider", () => {
  it("is not configured without a project and bucket, and refuses to run", async () => {
    const provider = new CodeBuildExecutionProvider({ profile: "dnafix-dev", region: "ap-southeast-2", projectName: "", artifactsBucket: "" }, async () => "");
    expect(provider.configured()).toBe(false);
    await expect(provider.runJob({ workspacePath: "C:\\x", argv: ["pnpm", "test"], timeoutMinutes: 5 })).rejects.toThrow(/not configured/);
  });

  it("drives start-build with bounded small compute in the configured region/profile, then polls to completion", async () => {
    const calls: string[][] = [];
    const cli: CliRunner = async (argv) => {
      calls.push(argv);
      const joined = argv.join(" ");
      if (joined.includes("start-build")) return JSON.stringify({ build: { id: "dnafix-proj:abc" } });
      if (joined.includes("batch-get-builds")) {
        return JSON.stringify({ builds: [{ id: "dnafix-proj:abc", buildStatus: "SUCCEEDED", logs: { deepLink: "https://console.aws.amazon.com/cloudwatch" }, artifacts: {} }] });
      }
      return "{}";
    };
    const provider = new CodeBuildExecutionProvider(
      { profile: "dnafix-dev", region: "ap-southeast-2", projectName: "dnafix-build", artifactsBucket: "dnafix-artifacts" },
      cli,
      1,
    );
    const result = await provider.runJob({ workspacePath: process.cwd(), argv: ["pnpm", "test"], timeoutMinutes: 10 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.logsReference).toContain("cloudwatch");
    const start = calls.find((c) => c.includes("start-build"))!.join(" ");
    expect(start).toContain("ap-southeast-2");
    expect(start).toContain("dnafix-dev");
    expect(start).toContain("BUILD_GENERAL1_SMALL");
    expect(start).toContain("--timeout-in-minutes-override");
    expect(start).not.toContain("privileged");
    expect(start).toContain("S3");
    // Input zip is cleaned up by default.
    expect(calls.some((c) => c.join(" ").includes("s3 rm"))).toBe(true);
  });

  it("enforces the cost bound on timeouts", async () => {
    const provider = new CodeBuildExecutionProvider({ profile: "p", region: "ap-southeast-2", projectName: "x", artifactsBucket: "y" }, async () => "{}");
    await expect(provider.runJob({ workspacePath: process.cwd(), argv: ["true"], timeoutMinutes: 500 })).rejects.toThrow(/cost bound/);
  });
});
