import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitizeText } from "./redaction.js";

export interface McpToolListing {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpListResult<T> {
  items: T[];
  nextCursor?: string;
}

/** Minimal SDK surface the manager depends on; tests inject a fake implementation. */
export interface McpClientLike {
  getServerVersion(): { name: string; version: string; description?: string } | undefined;
  getServerCapabilities(): Record<string, unknown> | undefined;
  listTools(params?: { cursor?: string }, options?: { timeout?: number; signal?: AbortSignal }): Promise<{ tools: McpToolListing[]; nextCursor?: string }>;
  listResources(params?: { cursor?: string }, options?: { timeout?: number; signal?: AbortSignal }): Promise<{ resources: Array<{ uri: string; name?: string; description?: string }>; nextCursor?: string }>;
  listPrompts(params?: { cursor?: string }, options?: { timeout?: number; signal?: AbortSignal }): Promise<{ prompts: Array<{ name: string; description?: string }>; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, resultSchema?: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export interface GatewayServerInfo {
  name: string;
  version: string;
  description?: string;
}

export interface GatewaySession {
  readonly client: McpClientLike;
  readonly pid: number | null;
  readonly serverInfo: GatewayServerInfo;
  readonly capabilities: Record<string, unknown>;
  readonly closed: boolean;
  stderrTail(): string;
  onClose(listener: (reason: string) => void): void;
  close(reason?: string): Promise<void>;
}

export interface GatewayLaunchOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  handshakeTimeoutMs?: number;
}

export type GatewayConnector = (options: GatewayLaunchOptions) => Promise<GatewaySession>;

/**
 * Gateway environment allowlist. Only host/Docker configuration is inherited —
 * model keys, GitHub tokens and other DNAFix secrets never reach the child.
 */
export function gatewayEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const names =
    platform === "win32"
      ? [
          "PATH",
          "PATHEXT",
          "SystemRoot",
          "SYSTEMROOT",
          "WINDIR",
          "USERPROFILE",
          "HOMEDRIVE",
          "HOMEPATH",
          "APPDATA",
          "LOCALAPPDATA",
          "PROGRAMDATA",
          "PROGRAMFILES",
          "TEMP",
          "TMP",
          "USERNAME",
          "COMPUTERNAME",
          "DOCKER_HOST",
          "DOCKER_CONTEXT",
          "DOCKER_CONFIG",
          "DOCKER_TLS_VERIFY",
          "DOCKER_CERT_PATH",
          "WSLENV",
        ]
      : ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return out;
}

function assertSafeCommand(command: string): void {
  if (!command || command.includes("\0")) throw new Error("Docker executable path is invalid.");
  if (/\.(cmd|bat)$/i.test(command)) {
    throw new Error("Refusing to launch a .cmd/.bat Docker shim without a shell. Use docker.exe or set DNAFIX_DOCKER_PATH.");
  }
}

/** Real stdio gateway connector using the official MCP TypeScript SDK. */
export const defaultGatewayConnector: GatewayConnector = async (options) => {
  assertSafeCommand(options.command);
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...options.args],
    env: options.env,
    stderr: "pipe",
    maxBufferSize: 10 * 1024 * 1024,
  });
  const stderrChunks: string[] = [];
  let stderrSize = 0;
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderrChunks.push(text);
      stderrSize += text.length;
      while (stderrSize > 8_000 && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });
  }

  const client = new Client({ name: "dnafix-mcp-connector", version: "0.1.0" }, { capabilities: {} });
  let closeReason = "Gateway connection closed.";
  let closed = false;
  const listeners: Array<(reason: string) => void> = [];
  const markClosed = (reason: string) => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const listener of listeners) listener(reason);
  };
  client.onclose = () => markClosed("Docker MCP Gateway closed the stdio connection.");
  client.onerror = (error) => markClosed(`Docker MCP Gateway error: ${sanitizeText(error.message, 400)}`);

  try {
    await client.connect(transport, { timeout: options.handshakeTimeoutMs ?? 20_000 });
  } catch (err) {
    await transport.close().catch(() => undefined);
    throw new Error(`MCP initialize handshake failed: ${sanitizeText(err instanceof Error ? err.message : String(err), 800)}`);
  }

  const version = client.getServerVersion();
  if (!version || !version.name) {
    await client.close().catch(() => undefined);
    throw new Error("MCP initialize handshake completed without server identity; the gateway response was malformed.");
  }

  return {
    client: client as unknown as McpClientLike,
    pid: transport.pid,
    serverInfo: { name: version.name, version: version.version, ...(version.description ? { description: version.description } : {}) },
    capabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>,
    get closed() {
      return closed;
    },
    stderrTail: () => sanitizeText(stderrChunks.join("").slice(-4_000), 4_000),
    onClose: (listener) => {
      listeners.push(listener);
      if (closed) listener(closeReason);
    },
    close: async (reason?: string) => {
      markClosed(reason ?? "Disconnected by DNAFix.");
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      await Promise.race([client.close().catch(() => undefined), timeout]);
      const pid = transport.pid;
      if (pid) {
        // The SDK closes the child. As a last resort, verify it is gone and
        // terminate only the process this session owns.
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          process.kill(pid, 0);
          process.kill(pid);
        } catch {
          /* already exited */
        }
      }
    },
  };
};

export function buildGatewayArgs(profileId: string): string[] {
  // Trusted, fixed argv. Only the validated profile id is interpolated.
  return ["mcp", "gateway", "run", "--profile", profileId, "--transport", "stdio", "--block-secrets"];
}
