import { describe, expect, it } from "vitest";
import {
  detectDocker,
  parseDesktopStatus,
  parseProfileList,
  parseProfileShow,
  parseToolkitFeatures,
  parseVersion,
  resolveDockerExecutable,
  validateProfileId,
  type ExecFn,
  type ExecResult,
} from "./docker.js";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: "", stderr, exitCode, timedOut: false, durationMs: 1 });

interface ExecCall {
  file: string;
  args: string[];
}

/** Route mocked Docker CLI calls by argv. Unknown commands fail loudly. */
function routedExec(routes: Record<string, ExecResult>, calls: ExecCall[] = []): ExecFn {
  return async (file, args) => {
    calls.push({ file, args });
    const key = args.join(" ");
    const value = routes[key];
    if (!value) throw new Error(`unexpected exec: ${file} ${key}`);
    return value;
  };
}

const WINDOWS_ENV: NodeJS.ProcessEnv = { DNAFIX_DOCKER_PATH: "C:\\Program Files\\Docker\\Docker\\docker.exe", PATH: "C:\\Windows" };

const HEALTHY_ROUTES: Record<string, ExecResult> = {
  "--version": ok("Docker version 29.8.2, build 1234"),
  "desktop version": ok("Docker Desktop 4.45.0 (build 1234)"),
  "desktop status --format json": ok(JSON.stringify({ status: "running", engine: { running: true } })),
  "mcp version": ok("Docker MCP CLI version 0.44.1"),
  "mcp feature ls --format json": ok(JSON.stringify([{ name: "mcp-toolkit", enabled: true }])),
  "mcp gateway --help": ok("Usage: docker mcp gateway run [flags]"),
  "mcp profile ls --format json": ok(
    JSON.stringify({
      profiles: [
        { id: "dnafix-dev", name: "DNAFix Dev", description: "read-only tools", servers: ["docker"] },
        { id: "empty", name: "Empty" },
      ],
    }),
  ),
};

describe("docker profile parsing", () => {
  it("parses profiles from object and array payloads and never invents entries", () => {
    const fromObject = parseProfileList(
      JSON.stringify({
        profiles: [
          { id: "dev", name: "Dev", description: "dev profile", servers: ["docker", { name: "filesystem" }] },
          "prod",
        ],
      }),
    );
    expect(fromObject).toEqual([
      { id: "dev", name: "Dev", description: "dev profile", serverNames: ["docker", "filesystem"] },
      { id: "prod", name: "prod", description: null, serverNames: [] },
    ]);

    const fromArray = parseProfileList(JSON.stringify([{ id: "a", name: "A" }, { id: "a", name: "duplicate" }]));
    expect(fromArray).toHaveLength(1);
    expect(fromArray[0]!.id).toBe("a");
    expect(() => parseProfileList(JSON.stringify({ nothing: true }))).toThrow(/profiles array/);
  });

  it("parses profile show server names without mutating anything", () => {
    const shown = parseProfileShow(JSON.stringify({ profile: { id: "dev", name: "Dev", servers: ["docker", "filesystem"] } }));
    expect(shown.profile?.id).toBe("dev");
    expect(shown.serverNames).toEqual(["docker", "filesystem"]);
    expect(parseProfileShow("[]")).toEqual({ profile: null, serverNames: [] });
  });

  it("rejects profile ids that could inject argv or escape the profile namespace", () => {
    for (const bad of ["", "-dev", "dev; rm -rf /", "dev/inject", "dev space", "a".repeat(65), "..", 42, null]) {
      expect(() => validateProfileId(bad)).toThrow(/Profile id is invalid/);
    }
    expect(validateProfileId("dnafix-dev_1.2")).toBe("dnafix-dev_1.2");
  });

  it("keeps version parsing bounded to a real semver token", () => {
    expect(parseVersion("Docker version 29.8.2, build 1234")).toBe("29.8.2");
    expect(parseVersion("v0.44.1")).toBe("0.44.1");
    expect(parseVersion("no version here")).toBeNull();
  });
});

describe("Docker Desktop status and feature parsing", () => {
  it("recognises a stopped Desktop from CLI output and JSON", () => {
    expect(parseDesktopStatus("", "Could not retrieve status. Is Docker Desktop running?").running).toBe(false);
    expect(parseDesktopStatus(JSON.stringify({ status: "stopped" }), "").running).toBe(false);
    expect(parseDesktopStatus(JSON.stringify({ status: "running", engine: { running: true } }), "").running).toBe(true);
    expect(parseDesktopStatus("", "").running).toBeNull();
  });

  it("reports Toolkit activation only when Docker says so", () => {
    expect(parseToolkitFeatures(JSON.stringify({ features: [{ name: "mcp-toolkit", enabled: true }] })).enabled).toBe(true);
    expect(parseToolkitFeatures(JSON.stringify([{ id: "mcp", status: "disabled" }])).enabled).toBe(false);
    expect(parseToolkitFeatures(JSON.stringify([{ name: "other", enabled: true }])).enabled).toBeNull();
    expect(parseToolkitFeatures("not json").enabled).toBeNull();
  });
});

describe("read-only Docker detection", () => {
  it("uses DNAFIX_DOCKER_PATH without probing PATH", async () => {
    const calls: ExecCall[] = [];
    const exec = routedExec({ ...HEALTHY_ROUTES }, calls);
    const resolved = await resolveDockerExecutable(exec, "win32", WINDOWS_ENV);
    expect(resolved).toMatchObject({
      path: "C:\\Program Files\\Docker\\Docker\\docker.exe",
      wrapperOnly: false,
      resolvedBy: "DNAFIX_DOCKER_PATH",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports an unsupported host without running mutating commands", async () => {
    const calls: ExecCall[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args });
      return fail("not found", 1);
    };
    const detection = await detectDocker({ exec, platform: "aix", env: {} });
    expect(detection.supportedHost).toBe(false);
    expect(detection.summary).toMatch(/not a supported Docker Desktop host/);
    expect(detection.profiles).toBeNull();
    expect(calls.every((call) => call.file === "/usr/bin/which" || call.file === "which")).toBe(true);
  });

  it("reports a missing Docker CLI with explicit guidance", async () => {
    const exec: ExecFn = async (file, args) => {
      if (file === "where.exe") return fail("INFO: Could not find files matching 'docker'.");
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    };
    const detection = await detectDocker({ exec, platform: "win32", env: {} });
    expect(detection.cli.available).toBe(false);
    expect(detection.summary).toMatch(/Docker CLI was not detected/);
    expect(detection.nextAction).toMatch(/will not install or start/);
  });

  it("reports Desktop stopped and does not try to list profiles", async () => {
    const calls: ExecCall[] = [];
    const exec = routedExec(
      {
        ...HEALTHY_ROUTES,
        "desktop status --format json": fail("Could not retrieve status. Is Docker Desktop running?"),
      },
      calls,
    );
    const detection = await detectDocker({ exec, platform: "win32", env: WINDOWS_ENV });
    expect(detection.desktop.running).toBe(false);
    expect(detection.profiles).toBeNull();
    expect(detection.summary).toMatch(/Docker Desktop is not running/);
    expect(detection.nextAction).toMatch(/does not start Docker Desktop/);
    expect(calls.some((call) => call.args.join(" ") === "mcp profile ls --format json")).toBe(false);
  });

  it("lists real profiles when the Toolkit is reachable", async () => {
    const exec = routedExec(HEALTHY_ROUTES);
    const detection = await detectDocker({ exec, platform: "win32", env: WINDOWS_ENV });
    expect(detection.desktop.running).toBe(true);
    expect(detection.toolkit).toMatchObject({ available: true, enabled: true, gatewayAvailable: true, version: "0.44.1" });
    expect(detection.profiles?.map((p) => p.id)).toEqual(["dnafix-dev", "empty"]);
    expect(detection.summary).toMatch(/2 profiles/);
    expect(detection.nextAction).toBeNull();
  });

  it("refuses a .cmd shim because stdio spawning would need a shell", async () => {
    const exec = routedExec({
      ...HEALTHY_ROUTES,
      "docker": ok("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.cmd\n"),
      "mcp profile ls --format json": ok(JSON.stringify([{ id: "dev", name: "Dev" }])),
    });
    const detection = await detectDocker({ exec, platform: "win32", env: {} });
    expect(detection.cli.wrapperOnly).toBe(true);
    expect(detection.summary).toMatch(/refuses to spawn it/);
    expect(detection.nextAction).toMatch(/DNAFIX_DOCKER_PATH/);
  });
});
