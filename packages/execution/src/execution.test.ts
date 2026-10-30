import { describe, expect, it } from "vitest";
import { CommandPolicyError, HostCommandRunner, scrubbedEnv, validateArgv } from "./index.js";

describe("command policy", () => {
  it("accepts allowlisted argv arrays", () => {
    expect(validateArgv(["node", "--version"])).toEqual(["node", "--version"]);
    expect(validateArgv(["git", "status", "--porcelain"])).toEqual(["git", "status", "--porcelain"]);
  });
  it("rejects non-allowlisted executables, shell strings and git writes", () => {
    expect(() => validateArgv(["bash", "-c", "rm -rf /"])).toThrow(CommandPolicyError);
    expect(() => validateArgv(["powershell", "x"])).toThrow(CommandPolicyError);
    expect(() => validateArgv(["git", "push", "origin", "main"])).toThrow(CommandPolicyError);
    expect(() => validateArgv(["node", "a\nb"])).toThrow(CommandPolicyError);
  });
  it("scrubs secrets from the environment", () => {
    process.env.MODEL_API_KEY = "should-not-leak";
    process.env.GITHUB_APP_PRIVATE_KEY = "should-not-leak";
    const env = scrubbedEnv();
    expect(env.MODEL_API_KEY).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    delete process.env.MODEL_API_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });
});

describe("host runner", () => {
  it("executes argv commands and captures exit code and output", async () => {
    const runner = new HostCommandRunner();
    const ok = await runner.run(["node", "-e", "console.log('hello')"], { cwd: process.cwd() });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdoutSummary).toContain("hello");
    const bad = await runner.run(["node", "-e", "process.exit(3)"], { cwd: process.cwd() });
    expect(bad.exitCode).toBe(3);
  });
});
