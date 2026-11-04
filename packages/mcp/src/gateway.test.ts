import { describe, expect, it } from "vitest";
import { buildGatewayArgs, defaultGatewayConnector, gatewayEnvironment } from "./gateway.js";

describe("Docker MCP Gateway launch contract", () => {
  it("builds a fixed, trusted argv with only the validated profile id interpolated", () => {
    expect(buildGatewayArgs("dnafix-dev")).toEqual([
      "mcp",
      "gateway",
      "run",
      "--profile",
      "dnafix-dev",
      "--transport",
      "stdio",
      "--block-secrets",
    ]);
    expect(buildGatewayArgs("dev")).not.toContain("--profile=dev");
    expect(buildGatewayArgs("dev").filter((arg) => arg === "dev")).toHaveLength(1);
  });

  it("never forwards DNAFix model, GitHub, or model credentials to the gateway", () => {
    const env = gatewayEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/dnafix",
        DOCKER_HOST: "unix:///var/run/docker.sock",
        MODEL_API_KEY: "model-secret",
        GITHUB_PRIVATE_KEY: "github-secret",
        GITHUB_APP_CLIENT_SECRET: "client-secret",
        GITHUB_WEBHOOK_SECRET: "webhook-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        RANDOM_SECRET: "nope",
      },
      "linux",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dnafix",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    expect(JSON.stringify(env)).not.toMatch(/secret|MODEL_API_KEY|GITHUB|AWS/);
  });

  it("keeps the Windows environment allowlist limited to host/Docker variables", () => {
    const env = gatewayEnvironment(
      {
        PATH: "C:\\Windows",
        SystemRoot: "C:\\Windows",
        APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
        DOCKER_CONFIG: "C:\\Users\\dev\\.docker",
        MODEL_API_KEY: "secret",
        GITHUB_TOKEN: "secret",
      },
      "win32",
    );
    expect(env.PATH).toBe("C:\\Windows");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.DOCKER_CONFIG).toBe("C:\\Users\\dev\\.docker");
    expect(env.MODEL_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("refuses to spawn a .cmd/.bat shim without a shell", async () => {
    await expect(
      defaultGatewayConnector({
        command: "C:\\Program Files\\Docker\\resources\\bin\\docker.cmd",
        args: buildGatewayArgs("dev"),
        env: { PATH: "C:\\Windows" },
      }),
    ).rejects.toThrow(/Refusing to launch a \.cmd\/\.bat Docker shim/);
  });
});
