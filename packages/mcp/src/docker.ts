import { execFile } from "node:child_process";
import type { McpProfile } from "@dnafix/contracts";
import { sanitizeText } from "./redaction.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  errorCode?: string;
  durationMs: number;
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

/** execFile only: never a shell, never string interpolation, bounded output and time. */
export const execFileSafe: ExecFn = (file, args, options) =>
  new Promise((resolve) => {
    const started = Date.now();
    try {
      execFile(
        file,
        args,
        {
          timeout: options.timeoutMs,
          windowsHide: true,
          shell: false,
          maxBuffer: 2 * 1024 * 1024,
          env: options.env ?? process.env,
        },
        (error, stdout, stderr) => {
          const code = (error as (NodeJS.ErrnoException & { code?: string | number }) | null)?.code;
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            exitCode: error ? (typeof code === "number" ? code : null) : 0,
            timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
            errorCode: typeof code === "string" ? code : undefined,
            durationMs: Date.now() - started,
          });
        },
      );
    } catch (err) {
      resolve({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        timedOut: false,
        errorCode: err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : "SPAWN_ERROR",
        durationMs: Date.now() - started,
      });
    }
  });

export interface DockerCliInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
  /** True when only a .cmd/.bat shim was found; stdio spawning without a shell is unsafe. */
  wrapperOnly: boolean;
}

export interface DockerDesktopInfo {
  pluginAvailable: boolean;
  pluginVersion: string | null;
  running: boolean | null;
  statusDetail: string;
}

export interface DockerFeature {
  name: string;
  enabled: boolean;
}

export interface DockerToolkitInfo {
  available: boolean;
  version: string | null;
  features: DockerFeature[];
  featureDetail: string;
  gatewayAvailable: boolean;
  gatewayDetail: string;
}

export interface DockerDetection {
  platform: NodeJS.Platform;
  hostLabel: string;
  supportedHost: boolean;
  cli: DockerCliInfo;
  desktop: DockerDesktopInfo;
  toolkit: DockerToolkitInfo;
  profiles: McpProfile[] | null;
  profilesError: string | null;
  checkedAt: string;
  summary: string;
  nextAction: string | null;
}

const DEFAULT_TIMEOUT = 6_000;

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export function resolveDockerExecutable(exec: ExecFn, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<{ path: string; error: string | null; wrapperOnly: boolean; resolvedBy: string }> {
  const configured = env.DNAFIX_DOCKER_PATH?.trim();
  if (configured) {
    return Promise.resolve({ path: configured, error: null, wrapperOnly: /\.(cmd|bat)$/i.test(configured), resolvedBy: "DNAFIX_DOCKER_PATH" });
  }
  if (platform === "win32") {
    return exec("where.exe", ["docker"], { timeoutMs: DEFAULT_TIMEOUT }).then((result) => {
      const lines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const exe = lines.find((line) => /docker\.exe$/i.test(line));
      const wrapper = lines.find((line) => /docker\.(cmd|bat)$/i.test(line));
      if (exe) return { path: exe, error: null, wrapperOnly: false, resolvedBy: "where.exe" };
      if (wrapper) return { path: wrapper, error: null, wrapperOnly: true, resolvedBy: "where.exe" };
      return { path: "docker.exe", error: firstLine(result.stderr) || "docker.exe was not found on PATH", wrapperOnly: false, resolvedBy: "none" };
    });
  }
  return exec("/usr/bin/which", ["docker"], { timeoutMs: DEFAULT_TIMEOUT }).then((result) => {
    if (result.exitCode === 0 && firstLine(result.stdout)) {
      return { path: firstLine(result.stdout), error: null, wrapperOnly: false, resolvedBy: "which" };
    }
    return exec("which", ["docker"], { timeoutMs: DEFAULT_TIMEOUT }).then((fallback) => {
      const found = firstLine(fallback.stdout);
      return found
        ? { path: found, error: null, wrapperOnly: false, resolvedBy: "which" }
        : { path: "docker", error: firstLine(fallback.stderr) || "docker was not found on PATH", wrapperOnly: false, resolvedBy: "none" };
    });
  });
}

export function parseVersion(output: string): string | null {
  const match = output.match(/(?:version[:\s]+)?v?(\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)/i);
  return match?.[1] ?? null;
}

function deepValues(value: unknown, keys: Set<string>, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const entry of value) deepValues(entry, keys, out);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(key.toLowerCase())) out.push(entry);
      deepValues(entry, keys, out);
    }
  }
  return out;
}

export function parseDesktopStatus(stdout: string, stderr: string): { running: boolean | null; detail: string } {
  const text = `${stdout}\n${stderr}`.trim();
  if (/not running|could not retrieve status|engine is (?:stopped|not running)|docker desktop is stopped/i.test(text)) {
    return { running: false, detail: sanitizeText(firstLine(stderr || stdout) || "Docker Desktop is not running.", 400) };
  }
  try {
    const parsed: unknown = JSON.parse(stdout);
    const values = deepValues(parsed, new Set(["status", "state", "running", "engine"]));
    for (const value of values) {
      if (value === true) return { running: true, detail: "Docker Desktop reports a running engine." };
      if (typeof value === "string" && /^(running|started|ready|healthy|ok)$/i.test(value.trim())) {
        return { running: true, detail: `Docker Desktop status: ${sanitizeText(value, 200)}` };
      }
      if (typeof value === "string" && /^(stopped|not running|paused|starting)$/i.test(value.trim())) {
        return { running: false, detail: `Docker Desktop status: ${sanitizeText(value, 200)}` };
      }
      if (value && typeof value === "object") {
        const running = (value as { running?: unknown }).running;
        if (running === true) return { running: true, detail: "Docker Desktop reports a running engine." };
        if (running === false) return { running: false, detail: "Docker Desktop reports no running engine." };
      }
    }
  } catch {
    /* fall through to text heuristics */
  }
  if (/\b(running|started)\b/i.test(text)) return { running: true, detail: sanitizeText(firstLine(stdout), 300) };
  return { running: null, detail: text ? sanitizeText(firstLine(text), 300) : "Docker Desktop status was not reported." };
}

/**
 * `docker mcp feature ls` accepts no `--format` flag; it prints rows of
 * "<name>    enabled|disabled" under a heading, plus an "Unknown features in
 * configuration" section whose values are not enabled/disabled. Only those rows
 * are reported, so an unrecognised shape yields no features rather than a guess.
 */
export function parseToolkitFeatures(stdout: string): { features: DockerFeature[]; detail: string } {
  const features: DockerFeature[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-z][a-z0-9_-]{0,63})\s+(enabled|disabled)$/i);
    if (match?.[1] && match[2]) features.push({ name: match[1].toLowerCase(), enabled: match[2].toLowerCase() === "enabled" });
  }
  if (features.length === 0) return { features, detail: "Docker MCP feature list reported no recognised features." };
  return { features, detail: sanitizeText(features.map((f) => `${f.name}: ${f.enabled ? "enabled" : "disabled"}`).join(", "), 300) };
}

export function validateProfileId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw)) {
    throw new Error("Profile id is invalid. Only letters, numbers, '.', '_' and '-' are accepted (max 64 characters).");
  }
  return raw;
}

function serverNamesFrom(value: unknown): string[] {
  const names = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") names.add(entry);
      else if (entry && typeof entry === "object") {
        const name = (entry as { name?: unknown; id?: unknown }).name ?? (entry as { id?: unknown }).id;
        if (typeof name === "string" && name.trim()) names.add(name.trim());
      }
    }
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) names.add(key);
  }
  return [...names].sort();
}

function normalizeProfile(entry: unknown): McpProfile | null {
  if (typeof entry === "string") {
    try {
      const id = validateProfileId(entry);
      return { id, name: id, description: null, serverNames: [] };
    } catch {
      return null;
    }
  }
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  const idValue = raw.id ?? raw.profileId ?? raw.profile ?? raw.name;
  if (typeof idValue !== "string") return null;
  let id: string;
  try {
    id = validateProfileId(idValue);
  } catch {
    return null;
  }
  const servers =
    serverNamesFrom(raw.servers).length > 0
      ? serverNamesFrom(raw.servers)
      : serverNamesFrom(raw.serverNames).length > 0
        ? serverNamesFrom(raw.serverNames)
        : serverNamesFrom(raw.mcpServers).length > 0
          ? serverNamesFrom(raw.mcpServers)
          : serverNamesFrom((raw.config as { servers?: unknown } | undefined)?.servers);
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    description: typeof raw.description === "string" ? raw.description.trim() || null : null,
    serverNames: servers,
  };
}

/** Parse `docker mcp profile ls --format json` without inventing profiles. */
export function parseProfileList(stdout: string): McpProfile[] {
  const parsed: unknown = JSON.parse(stdout);
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) entries = parsed;
  else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.profiles)) entries = obj.profiles;
    else if (Array.isArray(obj.items)) entries = obj.items;
    else if (Array.isArray(obj.data)) entries = obj.data;
    else if (Array.isArray(obj.profile)) entries = obj.profile;
    else throw new Error("Profile list JSON did not contain a profiles array.");
  } else {
    throw new Error("Profile list JSON was not an object or array.");
  }
  const profiles = entries.map(normalizeProfile).filter((p): p is McpProfile => Boolean(p));
  const seen = new Set<string>();
  return profiles.filter((profile) => (seen.has(profile.id) ? false : (seen.add(profile.id), true)));
}

/** Parse `docker mcp profile show <id> --format json`; returns the profile's server names. */
export function parseProfileShow(stdout: string): { profile: McpProfile | null; serverNames: string[] } {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object") return { profile: null, serverNames: [] };
  const obj = parsed as Record<string, unknown>;
  const candidate = obj.profile && typeof obj.profile === "object" ? { ...(obj.profile as Record<string, unknown>), ...obj } : obj;
  const profile = normalizeProfile(candidate);
  const servers =
    serverNamesFrom(candidate.servers).length > 0
      ? serverNamesFrom(candidate.servers)
      : serverNamesFrom(candidate.serverNames);
  return { profile, serverNames: servers };
}

export function supportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux" || platform === "darwin";
}

export function hostLabel(platform: NodeJS.Platform): string {
  return platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
}

export interface DetectOptions {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Read-only Docker Desktop detection. Runs no mutating Docker commands and
 * never starts Docker Desktop or enables experimental features.
 */
export async function detectDocker(options: DetectOptions = {}): Promise<DockerDetection> {
  const exec = options.exec ?? execFileSafe;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const now = options.now ?? (() => new Date());
  const checkedAt = now().toISOString();

  const resolved = await resolveDockerExecutable(exec, platform, env);
  const cli: DockerCliInfo = {
    available: false,
    path: resolved.error ? null : resolved.path,
    version: null,
    error: resolved.error,
    wrapperOnly: resolved.wrapperOnly,
  };

  let profiles: McpProfile[] | null = null;
  let profilesError: string | null = null;
  let desktop: DockerDesktopInfo = { pluginAvailable: false, pluginVersion: null, running: null, statusDetail: "" };
  let toolkit: DockerToolkitInfo = { available: false, version: null, features: [], featureDetail: "", gatewayAvailable: false, gatewayDetail: "" };

  if (!resolved.error) {
    const [versionResult, desktopVersion, desktopStatus, mcpVersion, featureResult, gatewayHelp] = await Promise.all([
      exec(resolved.path, ["--version"], { timeoutMs, env }),
      exec(resolved.path, ["desktop", "version"], { timeoutMs, env }),
      exec(resolved.path, ["desktop", "status", "--format", "json"], { timeoutMs, env }),
      exec(resolved.path, ["mcp", "version"], { timeoutMs, env }),
      exec(resolved.path, ["mcp", "feature", "ls"], { timeoutMs, env }),
      exec(resolved.path, ["mcp", "gateway", "--help"], { timeoutMs, env }),
    ]);

    cli.available = versionResult.exitCode === 0;
    if (!cli.available) {
      cli.error = sanitizeText(versionResult.errorCode === "ENOENT" ? "Docker CLI was not found on PATH." : firstLine(versionResult.stderr) || "Docker CLI could not be executed.", 400);
      cli.path = null;
    } else {
      cli.version = parseVersion(firstLine(versionResult.stdout));
    }

    const parsedStatus = parseDesktopStatus(desktopStatus.stdout, desktopStatus.stderr);
    desktop = {
      pluginAvailable: desktopVersion.exitCode === 0,
      pluginVersion: desktopVersion.exitCode === 0 ? parseVersion(firstLine(desktopVersion.stdout)) : null,
      running: parsedStatus.running,
      statusDetail: parsedStatus.detail,
    };

    const toolkitVersion = mcpVersion.exitCode === 0 ? parseVersion(firstLine(mcpVersion.stdout)) : null;
    const features = featureResult.exitCode === 0 ? parseToolkitFeatures(featureResult.stdout) : { features: [], detail: sanitizeText(firstLine(featureResult.stderr) || "Toolkit feature state was unavailable.", 300) };
    toolkit = {
      available: Boolean(toolkitVersion),
      version: toolkitVersion,
      features: features.features,
      featureDetail: features.detail,
      gatewayAvailable: gatewayHelp.exitCode === 0 && /gateway/i.test(`${gatewayHelp.stdout}\n${gatewayHelp.stderr}`),
      gatewayDetail: gatewayHelp.exitCode === 0 ? "Docker MCP Gateway CLI is available." : sanitizeText(firstLine(gatewayHelp.stderr) || "Docker MCP Gateway CLI help failed.", 300),
    };

    if (desktop.running === false) {
      profilesError = desktop.statusDetail || "Docker Desktop is not running.";
    } else if (cli.available) {
      const profileResult = await exec(resolved.path, ["mcp", "profile", "ls", "--format", "json"], { timeoutMs, env });
      if (profileResult.exitCode === 0) {
        desktop.running = true;
        try {
          profiles = parseProfileList(profileResult.stdout);
        } catch (err) {
          profilesError = sanitizeText(err instanceof Error ? err.message : String(err), 400);
        }
      } else {
        const detail = sanitizeText(firstLine(profileResult.stderr) || firstLine(profileResult.stdout) || "Profile discovery failed.", 400);
        profilesError = detail;
        if (/not running|could not retrieve status/i.test(detail)) desktop.running = false;
      }
    }
  }

  const supportedHost = supportedPlatform(platform);
  let summary: string;
  let nextAction: string | null = null;
  if (!supportedHost) {
    summary = `${hostLabel(platform)} is not a supported Docker Desktop host for this connector.`;
    nextAction = "Run DNAFix on Windows, macOS, or Linux with Docker Desktop installed locally.";
  } else if (!cli.available) {
    summary = "Docker CLI was not detected on the DNAFix host.";
    nextAction = "Install Docker Desktop, start it, and ensure the Docker CLI is on PATH. DNAFix will not install or start it for you.";
  } else if (!toolkit.available) {
    summary = `Docker CLI ${cli.version ?? "detected"}, but the MCP Toolkit CLI is not available.`;
    nextAction = "Update Docker Desktop to a version that includes the MCP Toolkit/CLI, then restart Docker Desktop.";
  } else if (desktop.running === false) {
    summary = `Docker Desktop is not running (CLI ${cli.version ?? "detected"}, MCP Toolkit ${toolkit.version ?? "detected"}).`;
    nextAction = "Start Docker Desktop manually, then refresh detection. DNAFix does not start Docker Desktop.";
  } else if (resolved.wrapperOnly) {
    summary = "Only a Docker .cmd/.bat shim was found. DNAFix refuses to spawn it because that would require a shell.";
    nextAction = "Expose docker.exe (Docker Desktop's normal installation) on PATH or set DNAFIX_DOCKER_PATH to the absolute docker.exe path.";
  } else if (profiles === null) {
    summary = `Docker Desktop detected, but profiles could not be listed: ${profilesError ?? "unknown error"}`;
    nextAction = "Open Docker Desktop → MCP Toolkit, confirm the Toolkit is enabled, and create or select a profile.";
  } else if (profiles.length === 0) {
    summary = "Docker Desktop MCP Toolkit is reachable, but no profiles exist.";
    nextAction = "Create a profile in Docker Desktop → MCP Toolkit, add servers there, then refresh. DNAFix never creates profiles or installs servers.";
  } else {
    summary = `Docker Desktop MCP Toolkit is reachable with ${profiles.length} profile${profiles.length === 1 ? "" : "s"}.`;
  }

  return {
    platform,
    hostLabel: hostLabel(platform),
    supportedHost,
    cli,
    desktop,
    toolkit,
    profiles,
    profilesError,
    checkedAt,
    summary,
    nextAction,
  };
}
