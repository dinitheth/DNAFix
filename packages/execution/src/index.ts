import { spawn } from "node:child_process";
import type { CommandResult } from "@dnafix/contracts";

export class CommandPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandPolicyError";
  }
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

const ALLOWED_EXECUTABLES = new Set(["node", "pnpm", "npm", "npx", "git"]);
const GIT_READONLY = new Set(["status", "diff", "log", "rev-parse", "show", "ls-files"]);

/** Validate an argv array. Shell strings are never accepted anywhere in DNAFix. */
export function validateArgv(argv: readonly string[]): string[] {
  if (argv.length === 0) throw new CommandPolicyError("Empty command");
  const [exe, ...rest] = argv as [string, ...string[]];
  const base = exe.replaceAll("\\", "/").split("/").pop()?.replace(/\.cmd$|\.exe$/i, "") ?? "";
  if (!ALLOWED_EXECUTABLES.has(base)) throw new CommandPolicyError(`Executable not allowlisted: ${exe}`);
  for (const arg of rest) {
    if (typeof arg !== "string" || arg.length > 2_000) throw new CommandPolicyError("Invalid command argument");
    if (/[\n\r\0]/.test(arg)) throw new CommandPolicyError("Command argument contains control characters");
    // Arguments must never be able to break out of argv quoting on any platform shell used for .cmd shims.
    if (/["%&|<>^`]/.test(arg)) throw new CommandPolicyError(`Command argument contains shell metacharacters: ${JSON.stringify(arg)}`);
  }
  if (base === "git") {
    const sub = rest.find((a) => !a.startsWith("-"));
    if (!sub || !GIT_READONLY.has(sub)) throw new CommandPolicyError(`git subcommand not allowlisted for sandbox execution: ${sub ?? "(none)"}`);
  }
  return [base, ...rest];
}

const ENV_ALLOWLIST = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC"];

export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "true", DNAFIX_SANDBOX: "1" };
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface CommandRunner {
  readonly mode: "docker" | "host";
  run(argv: readonly string[], opts: RunOptions): Promise<CommandResult>;
}

function spawnCollect(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxChars: number,
  useShell = false,
): Promise<Omit<CommandResult, "sandboxMode" | "argv" | "cwd">> {
  return new Promise((resolve) => {
    const started = Date.now();
    // Windows .cmd shims (npm/pnpm/npx) cannot be spawned without a shell on modern Node.
    // argv has already been validated (allowlisted exe, no shell metacharacters in args),
    // and Node quotes the argv array when shell:true.
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: useShell, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const append = (buf: Buffer, target: "out" | "err") => {
      const text = buf.toString("utf8");
      if (target === "out") stdout = (stdout + text).slice(-maxChars);
      else stderr = (stderr + text).slice(-maxChars);
    };
    child.stdout?.on("data", (b: Buffer) => append(b, "out"));
    child.stderr?.on("data", (b: Buffer) => append(b, "err"));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, durationMs: Date.now() - started, stdoutSummary: stdout, stderrSummary: `${stderr}\n${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, durationMs: Date.now() - started, stdoutSummary: stdout, stderrSummary: stderr });
    });
  });
}

export class HostCommandRunner implements CommandRunner {
  readonly mode = "host" as const;
  async run(argv: readonly string[], opts: RunOptions): Promise<CommandResult> {
    const valid = validateArgv(argv);
    const result = await spawnCollect(valid, opts.cwd, scrubbedEnv(), opts.timeoutMs ?? 300_000, opts.maxOutputChars ?? 8_000, process.platform === "win32");
    return { argv: valid, cwd: opts.cwd, sandboxMode: "host", ...result };
  }
}

export class DockerCommandRunner implements CommandRunner {
  readonly mode = "docker" as const;
  constructor(private readonly image = process.env.SANDBOX_IMAGE ?? "node:22-alpine") {}

  async run(argv: readonly string[], opts: RunOptions): Promise<CommandResult> {
    const valid = validateArgv(argv);
    const dockerArgv = [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=256m",
      "--memory",
      process.env.SANDBOX_MEMORY ?? "1g",
      "--cpus",
      process.env.SANDBOX_CPUS ?? "1",
      "--user",
      "node",
      "-v",
      `${opts.cwd}:/work`,
      "-w",
      "/work",
      this.image,
      ...valid,
    ];
    const result = await spawnCollect(dockerArgv, opts.cwd, scrubbedEnv(), opts.timeoutMs ?? 300_000, opts.maxOutputChars ?? 8_000);
    if (result.exitCode === null || /Cannot connect|docker daemon|error during connect/i.test(result.stderrSummary)) {
      throw new SandboxUnavailableError(`Docker sandbox unavailable: ${result.stderrSummary.slice(0, 500)}`);
    }
    return { argv: valid, cwd: opts.cwd, sandboxMode: "docker", ...result };
  }
}

export function createCommandRunner(mode = process.env.SANDBOX_MODE ?? "docker"): CommandRunner {
  if (mode === "docker") return new DockerCommandRunner();
  if (mode === "host") return new HostCommandRunner();
  throw new CommandPolicyError(`Unknown SANDBOX_MODE: ${mode}`);
}
