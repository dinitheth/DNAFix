import { createHash, randomUUID } from "node:crypto";
import AjvModule, { type ValidateFunction } from "ajv";
import type {
  McpAgentRole,
  McpApprovalRecord,
  McpConnectionRecord,
  McpDiscoveredTool,
  McpInvocationRecord,
  McpPermissionLevel,
  McpProfile,
  McpRunGrantRecord,
  McpServerPermissionRecord,
  McpToolPermissionRecord,
} from "@dnafix/contracts";
import type { Store } from "@dnafix/persistence";
import {
  detectDocker,
  hostLabel,
  parseProfileShow,
  validateProfileId,
  type DockerDetection,
  type ExecFn,
} from "./docker.js";
import {
  buildGatewayArgs,
  defaultGatewayConnector,
  gatewayEnvironment,
  type GatewayConnector,
  type GatewaySession,
  type McpToolListing,
} from "./gateway.js";
import { classifyTool, consequencesFor, describeTarget, parameterSummary, permissionLabel, riskForLevel } from "./policy.js";
import { hashArguments, redactValue, sanitizeText, sanitizeToolResult, stableStringify } from "./redaction.js";

export const DOCKER_MCP_CONNECTION_ID = "docker-desktop-mcp" as const;
const BOTH_AGENTS: McpAgentRole[] = ["coding-agent", "verification-agent"];

/**
 * Ajv ships as CommonJS with an `export default` declaration. Under NodeNext
 * TypeScript resolves the namespace rather than the constructor, so the
 * runtime default export is narrowed explicitly here.
 */
const Ajv = AjvModule as unknown as new (options?: Record<string, unknown>) => {
  compile(schema: object): ValidateFunction;
};

export interface McpToolView extends McpDiscoveredTool {
  enabled: boolean;
  allowedAgents: McpAgentRole[];
  reviewedLevel: McpPermissionLevel | null;
  risk: "low" | "medium" | "high";
  permissionLabel: string;
}

export interface McpServerView {
  name: string;
  description: string | null;
  enabled: boolean;
  allowedAgents: McpAgentRole[];
  toolCount: number;
  health: "reachable" | "no-tools-reported" | "not-connected";
}

export interface McpConnectorView {
  id: typeof DOCKER_MCP_CONNECTION_ID;
  provider: "docker-desktop-mcp";
  state: McpConnectionRecord["state"];
  enabled: boolean;
  reason: string;
  nextAction: string | null;
  profileId: string | null;
  selectedProfile: McpProfile | null;
  profiles: McpProfile[] | null;
  detection: DockerDetection;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastHandshakeAt: string | null;
  gateway: { serverInfo: { name: string; version: string; description?: string }; capabilities: Record<string, unknown> } | null;
  servers: McpServerView[];
  tools: McpToolView[];
  resources: Array<{ uri: string; name: string; description: string | null }>;
  prompts: Array<{ name: string; description: string | null }>;
  serverCount: number;
  toolCount: number;
  enabledToolCount: number;
  inventory: { fetchedAt: string; fingerprint: string; warnings: string[] } | null;
  activity: McpInvocationRecord[];
  approvals: McpApprovalRecord[];
  checkedAt: string;
}

export interface AgentMcpTool {
  modelName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissionLevel: McpPermissionLevel;
  reviewed: boolean;
}

export interface AgentMcpRuntime {
  toolsForAgent(runId: string, agent: McpAgentRole): Promise<AgentMcpTool[]>;
  executeToolCall(input: {
    runId: string;
    repositoryId: string | null;
    agent: McpAgentRole;
    modelId: string;
    tool: AgentMcpTool;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ text: string; isError: boolean; summary: string }>;
}

export interface McpConnectorOptions {
  store: Store;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  connector?: GatewayConnector;
  now?: () => Date;
  detectionTtlMs?: number;
  handshakeTimeoutMs?: number;
  toolCallTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  approvalTimeoutMs?: number;
  maxToolCallsPerRun?: number;
  maxToolsPerAgent?: number;
  autoReconnect?: boolean;
}

export class McpConnectorError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_detected"
      | "not_configured"
      | "disabled"
      | "profile_invalid"
      | "not_connected"
      | "authentication_required"
      | "tool_disabled"
      | "tool_unreviewed"
      | "level_too_low"
      | "invalid_arguments"
      | "approval_denied"
      | "run_limit"
      | "cancelled"
      | "timeout"
      | "connection_error",
  ) {
    super(message);
    this.name = "McpConnectorError";
  }
}

export function defaultMcpConnection(now = new Date().toISOString()): McpConnectionRecord {
  return {
    id: DOCKER_MCP_CONNECTION_ID,
    provider: "docker-desktop-mcp",
    profileId: null,
    enabled: false,
    state: "not-connected",
    lastError: null,
    lastConnectedAt: null,
    lastHandshakeAt: null,
    inventory: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function modelToolName(serverName: string, toolName: string): string {
  const slug = `${serverName}_${toolName}`
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 44);
  const hash = createHash("sha256").update(`${serverName}\u0000${toolName}`).digest("hex").slice(0, 8);
  return `mcp_${slug}_${hash}`.slice(0, 64);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function serverFromTool(tool: McpToolListing, profileServers: string[], fallback: string): string {
  const meta = tool._meta ?? {};
  for (const key of ["server", "serverName", "mcp/server", "dnafix/server"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return sanitizeText(value, 128);
  }
  const normalizedTool = normalizeName(tool.name);
  let best: string | null = null;
  for (const server of profileServers) {
    const normalizedServer = normalizeName(server);
    if (!normalizedServer) continue;
    if (normalizedTool === normalizedServer || normalizedTool.startsWith(`${normalizedServer}_`)) {
      if (!best || normalizedServer.length > normalizeName(best).length) best = server;
    }
  }
  return best ?? fallback;
}

function cloneSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object", properties: {} };
  try {
    const parsed = JSON.parse(JSON.stringify(value)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return { type: "object", properties: {} };
}

function schemaFingerprint(tools: McpDiscoveredTool[], resources: unknown[], prompts: unknown[]): string {
  return createHash("sha256")
    .update(
      stableStringify({
        tools: [...tools]
          .sort((a, b) => `${a.serverName}/${a.name}`.localeCompare(`${b.serverName}/${b.name}`))
          .map((t) => ({ server: t.serverName, name: t.name, description: t.description, schema: t.inputSchema })),
        resources,
        prompts,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

/**
 * Owns the real Docker Desktop MCP connection, discovery cache, permissions,
 * approvals and invocation audit. Product code never fabricates a connection:
 * `state: connected` requires a live session whose initialize handshake passed.
 */
export class McpConnectorService implements AgentMcpRuntime {
  private readonly store: Store;
  private readonly exec: ExecFn | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly connector: GatewayConnector;
  private readonly now: () => Date;
  private readonly detectionTtlMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly toolCallTimeoutMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly approvalTimeoutMs: number;
  private readonly maxToolCallsPerRun: number;
  private readonly maxToolsPerAgent: number;
  private readonly autoReconnect: boolean;

  private detection: DockerDetection | null = null;
  private detectionAt = 0;
  private initialized: Promise<void> | null = null;
  private connection: McpConnectionRecord | null = null;
  private session: GatewaySession | null = null;
  private connectPromise: Promise<McpConnectorView> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly runControllers = new Map<string, AbortController>();
  private readonly validators = new Map<string, ValidateFunction | null>();
  private readonly ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true, validateFormats: false });

  constructor(options: McpConnectorOptions) {
    this.store = options.store;
    this.exec = options.exec;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.connector = options.connector ?? defaultGatewayConnector;
    this.now = options.now ?? (() => new Date());
    this.detectionTtlMs = options.detectionTtlMs ?? 10_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 20_000;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? 30_000;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 20_000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000;
    this.maxToolCallsPerRun = options.maxToolCallsPerRun ?? 24;
    this.maxToolsPerAgent = options.maxToolsPerAgent ?? 48;
    this.autoReconnect = options.autoReconnect ?? true;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        const existing = await this.store.getMcpConnection(DOCKER_MCP_CONNECTION_ID);
        if (!existing) {
          this.connection = defaultMcpConnection(this.iso());
          await this.store.saveMcpConnection(this.connection);
          return;
        }
        this.connection = existing;
        if (existing.state === "connected" || existing.state === "connecting") {
          existing.state = "not-connected";
          existing.lastError = "The DNAFix backend restarted. Reconnect to perform a new MCP initialize handshake.";
          existing.updatedAt = this.iso();
          await this.store.saveMcpConnection(existing);
        }
        if (existing.enabled && existing.state === "disabled") existing.state = "not-connected";
      })();
    }
    await this.initialized;
  }

  private async record(): Promise<McpConnectionRecord> {
    await this.ensureInitialized();
    return this.connection!;
  }

  private async saveRecord(record: McpConnectionRecord): Promise<void> {
    record.updatedAt = this.iso();
    this.connection = record;
    await this.store.saveMcpConnection(record);
  }

  private async audit(
    runId: string | null,
    repositoryId: string | null,
    actor: "user" | "coding-agent" | "verification-agent" | "mcp-orchestrator" | "system",
    action: string,
    result: "ok" | "error" | "info",
    evidence: string | null,
  ): Promise<void> {
    await this.store.appendAudit({
      id: `evt_${randomUUID().slice(0, 12)}`,
      runId,
      repositoryId,
      actor,
      action,
      result,
      evidence: evidence ? sanitizeText(evidence, 2_000) : null,
      createdAt: this.iso(),
    });
  }

  async detect(force = false): Promise<DockerDetection> {
    const now = Date.now();
    if (!force && this.detection && now - this.detectionAt < this.detectionTtlMs) return this.detection;
    this.detection = await detectDocker({
      exec: this.exec,
      platform: this.platform,
      env: this.env,
      now: this.now,
    });
    this.detectionAt = now;
    return this.detection;
  }

  private effectiveState(record: McpConnectionRecord): McpConnectionRecord["state"] {
    if (this.session && !this.session.closed) return "connected";
    if (this.connectPromise) return "connecting";
    if (!record.enabled) return "disabled";
    if (this.detection && !this.detection.cli.available) return "not-detected";
    if (record.state === "connection-error" || record.state === "authentication-required") return record.state;
    if (!record.profileId) return "not-configured";
    return "not-connected";
  }

  private async toolViews(record: McpConnectionRecord): Promise<McpToolView[]> {
    const inventory = record.inventory;
    if (!inventory) return [];
    const [toolPermissions, serverPermissions] = await Promise.all([
      this.store.listMcpToolPermissions(DOCKER_MCP_CONNECTION_ID),
      this.store.listMcpServerPermissions(DOCKER_MCP_CONNECTION_ID),
    ]);
    const toolMap = new Map(toolPermissions.map((p) => [`${p.serverName}\u0000${p.toolName}`, p]));
    const serverMap = new Map(serverPermissions.map((p) => [p.serverName, p]));
    return inventory.tools.map((tool) => {
      const serverPermission = serverMap.get(tool.serverName);
      const permission = toolMap.get(`${tool.serverName}\u0000${tool.name}`);
      const reviewedLevel = permission?.reviewedLevel ?? null;
      const reviewed = tool.reviewed || reviewedLevel !== null;
      const allowedAgents = permission?.allowedAgents ?? BOTH_AGENTS;
      const serverEnabled = serverPermission?.enabled ?? true;
      const enabled = Boolean(permission?.enabled) && serverEnabled && reviewed && allowedAgents.length > 0;
      return {
        ...tool,
        permissionLevel: reviewedLevel ?? tool.permissionLevel,
        reviewed,
        enabled,
        allowedAgents,
        reviewedLevel,
        risk: riskForLevel(reviewedLevel ?? tool.permissionLevel),
        permissionLabel: permissionLabel(reviewedLevel ?? tool.permissionLevel),
      };
    });
  }

  private async view(): Promise<McpConnectorView> {
    const record = await this.record();
    const detection = await this.detect();
    const tools = await this.toolViews(record);
    const [serverPermissions, activity, approvals] = await Promise.all([
      this.store.listMcpServerPermissions(DOCKER_MCP_CONNECTION_ID),
      this.store.listMcpInvocations({ limit: 20 }),
      this.store.listMcpApprovals({}),
    ]);
    const serverMap = new Map(serverPermissions.map((p) => [p.serverName, p]));
    const serverNames = new Set<string>([
      ...(record.inventory?.profileServers ?? []),
      ...tools.map((t) => t.serverName),
    ]);
    const servers: McpServerView[] = [...serverNames].sort().map((name) => {
      const serverPermission = serverMap.get(name);
      const serverTools = tools.filter((t) => t.serverName === name);
      return {
        name,
        description: null,
        enabled: serverPermission?.enabled ?? true,
        allowedAgents: serverPermission?.allowedAgents ?? BOTH_AGENTS,
        toolCount: serverTools.length,
        health: !this.session || this.session.closed ? "not-connected" : serverTools.length > 0 ? "reachable" : "no-tools-reported",
      };
    });
    const state = this.effectiveState(record);
    const selectedProfile = record.profileId
      ? detection.profiles?.find((p) => p.id === record.profileId) ?? {
          id: record.profileId,
          name: record.profileId,
          description: null,
          serverNames: record.inventory?.profileServers ?? [],
        }
      : null;
    let reason = "";
    let nextAction: string | null = detection.nextAction;
    if (state === "connected") {
      reason = `MCP initialize handshake completed with ${this.session!.serverInfo.name} ${this.session!.serverInfo.version}.`;
      nextAction = record.enabled
        ? tools.some((t) => t.enabled)
          ? null
          : "Enable individual tools (and the agents allowed to use them) before starting an analysis."
        : "Enable this connector for DNAFix to expose approved tools to agents.";
    } else if (state === "connecting") {
      reason = "Launching the Docker MCP Gateway and waiting for the MCP initialize handshake.";
      nextAction = null;
    } else if (state === "disabled") {
      reason = "The connector is temporarily disabled for DNAFix. No MCP tools are offered to agents.";
      nextAction = "Enable the connector for DNAFix, then connect the selected profile.";
    } else if (state === "not-detected") {
      reason = detection.summary;
    } else if (state === "not-configured") {
      reason = record.profileId ? "A profile is selected but there is no live MCP session." : "No Docker MCP profile has been selected.";
      nextAction = record.profileId ? "Connect to perform the MCP initialize handshake." : detection.nextAction ?? "Select a Docker MCP profile.";
    } else if (state === "authentication-required") {
      reason = record.lastError ?? "The MCP server requires authentication in Docker Desktop.";
      nextAction = "Complete the server's OAuth/authentication flow in Docker Desktop MCP Toolkit, then reconnect.";
    } else if (state === "connection-error") {
      reason = record.lastError ?? "The Docker MCP Gateway connection failed.";
      nextAction = "Check Docker Desktop and the selected profile, then reconnect.";
    } else {
      reason = record.lastError ?? "No live Docker MCP Gateway session.";
      if (detection.desktop.running === false) nextAction = detection.nextAction;
    }

    return {
      id: DOCKER_MCP_CONNECTION_ID,
      provider: "docker-desktop-mcp",
      state,
      enabled: record.enabled,
      reason,
      nextAction,
      profileId: record.profileId,
      selectedProfile,
      profiles: detection.profiles,
      detection,
      lastError: record.lastError,
      lastConnectedAt: record.lastConnectedAt,
      lastHandshakeAt: record.lastHandshakeAt,
      gateway: this.session && !this.session.closed ? { serverInfo: this.session.serverInfo, capabilities: this.session.capabilities } : null,
      servers,
      tools,
      resources: (record.inventory?.resources ?? []).map((r) => ({ ...r, description: r.description ?? null })),
      prompts: (record.inventory?.prompts ?? []).map((p) => ({ ...p, description: p.description ?? null })),
      serverCount: servers.length,
      toolCount: tools.length,
      enabledToolCount: tools.filter((t) => t.enabled).length,
      inventory: record.inventory ? { fetchedAt: record.inventory.fetchedAt, fingerprint: record.inventory.fingerprint, warnings: record.inventory.warnings } : null,
      activity,
      approvals: approvals.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, 20),
      checkedAt: detection.checkedAt,
    };
  }

  async getOverview(forceDetect = false): Promise<McpConnectorView> {
    if (forceDetect) await this.detect(true);
    return this.view();
  }

  async listProfiles(force = true): Promise<{ profiles: McpProfile[]; detection: DockerDetection }> {
    const detection = await this.detect(force);
    if (!detection.cli.available) throw new McpConnectorError(detection.summary, "not_detected");
    if (detection.profiles === null) throw new McpConnectorError(detection.profilesError ?? "Docker MCP profiles could not be listed.", "not_configured");
    return { profiles: detection.profiles, detection };
  }

  async selectProfile(profileId: string): Promise<McpConnectorView> {
    let validated: string;
    try {
      validated = validateProfileId(profileId);
    } catch (err) {
      throw new McpConnectorError(err instanceof Error ? err.message : String(err), "profile_invalid");
    }
    const { profiles } = await this.listProfiles(true);
    const profile = profiles.find((p) => p.id === validated);
    if (!profile) throw new McpConnectorError(`Profile '${validated}' is not present in Docker Desktop. Select one of: ${profiles.map((p) => p.id).join(", ") || "(none)"}.`, "profile_invalid");
    const record = await this.record();
    if (record.profileId && record.profileId !== validated && this.session) await this.disconnect("Profile selection changed.");
    if (record.profileId !== validated) {
      record.profileId = validated;
      record.inventory = null;
      record.state = "not-connected";
      record.lastError = null;
      await this.saveRecord(record);
      await this.audit(null, null, "user", "mcp.profile.selected", "ok", `profile=${validated} servers=${profile.serverNames.join(",") || "unknown"}`);
    }
    return this.view();
  }

  private async inspectProfile(profileId: string): Promise<string[]> {
    const detection = await this.detect();
    if (!detection.cli.path) return [];
    const { execFileSafe } = await import("./docker.js");
    const exec = this.exec ?? execFileSafe;
    const result = await exec(detection.cli.path, ["mcp", "profile", "show", profileId, "--format", "json"], {
      timeoutMs: 8_000,
      env: this.env,
    });
    if (result.exitCode !== 0) return [];
    try {
      return parseProfileShow(result.stdout).serverNames;
    } catch {
      return [];
    }
  }

  async connect(profileId?: string): Promise<McpConnectorView> {
    await this.ensureInitialized();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal(profileId).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectInternal(profileId?: string): Promise<McpConnectorView> {
    const record = await this.record();
    if (!record.enabled) {
      throw new McpConnectorError("This connector is disabled for DNAFix. Enable it before connecting.", "disabled");
    }
    const detection = await this.detect(true);
    if (!detection.supportedHost) throw new McpConnectorError(detection.summary, "not_detected");
    if (!detection.cli.available || !detection.cli.path) throw new McpConnectorError(detection.summary, "not_detected");
    if (!detection.toolkit.available) throw new McpConnectorError(detection.summary, "not_detected");
    if (detection.cli.wrapperOnly) throw new McpConnectorError(detection.summary, "not_detected");
    if (detection.desktop.running === false) throw new McpConnectorError(detection.summary, "not_detected");
    const requestedProfile = profileId ?? record.profileId;
    if (!requestedProfile) throw new McpConnectorError("No Docker MCP profile is selected. Choose a profile before connecting.", "not_configured");
    let id: string;
    try {
      id = validateProfileId(requestedProfile);
    } catch (err) {
      throw new McpConnectorError(err instanceof Error ? err.message : String(err), "profile_invalid");
    }
    if (detection.profiles === null) throw new McpConnectorError(detection.profilesError ?? "Docker MCP profiles are unavailable.", "not_configured");
    const profile = detection.profiles.find((p) => p.id === id);
    if (!profile) throw new McpConnectorError(`Profile '${id}' is not present in Docker Desktop.`, "profile_invalid");

    if (this.session && !this.session.closed && record.profileId === id) {
      record.state = "connected";
      return this.view();
    }
    if (this.session) {
      const old = this.session;
      this.session = null;
      await old.close("Reconnecting with the selected profile.").catch(() => undefined);
    }

    record.profileId = id;
    record.state = "connecting";
    record.lastError = null;
    await this.saveRecord(record);
    await this.audit(null, null, "user", "mcp.connect.started", "info", `profile=${id}`);

    let session: GatewaySession;
    try {
      session = await this.connector({
        command: detection.cli.path,
        args: buildGatewayArgs(id),
        env: gatewayEnvironment(this.env, this.platform),
        handshakeTimeoutMs: this.handshakeTimeoutMs,
      });
    } catch (err) {
      const message = sanitizeText(err instanceof Error ? err.message : String(err), 1_000);
      record.state = "connection-error";
      record.lastError = message;
      record.lastHandshakeAt = null;
      await this.saveRecord(record);
      await this.audit(null, null, "mcp-orchestrator", "mcp.connect.failed", "error", message);
      throw new McpConnectorError(message, "connection_error");
    }

    this.session = session;
    this.reconnectAttempts = 0;
    const handshakeAt = this.iso();
    record.state = "connected";
    record.lastHandshakeAt = handshakeAt;
    record.lastConnectedAt = handshakeAt;
    record.lastError = null;
    await this.saveRecord(record);
    session.onClose((reason) => {
      if (this.session !== session) return;
      this.session = null;
      const message = sanitizeText(reason || "Docker MCP Gateway process exited.", 1_000);
      void (async () => {
        const current = await this.record();
        current.state = "connection-error";
        current.lastError = message;
        await this.saveRecord(current);
        await this.audit(null, null, "mcp-orchestrator", "mcp.disconnected.unexpected", "error", message);
        this.scheduleReconnect();
      })();
    });
    await this.audit(null, null, "user", "mcp.connected", "ok", `profile=${id} gateway=${session.serverInfo.name}@${session.serverInfo.version} pid=${session.pid ?? "unknown"}`);

    const inspectedServers = await this.inspectProfile(id).catch(() => [] as string[]);
    const profileServers = inspectedServers.length > 0 ? inspectedServers : profile.serverNames;
    await this.refreshInventory(session, profileServers).catch(async (err: Error) => {
      const message = sanitizeText(`Handshake succeeded, but tool discovery failed: ${err.message}`, 1_000);
      record.lastError = message;
      await this.saveRecord(record);
      await this.audit(null, null, "mcp-orchestrator", "mcp.discovery.failed", "error", message);
    });
    return this.view();
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.reconnectTimer) return;
    const record = this.connection;
    if (!record?.enabled || !record.profileId) return;
    if (this.reconnectAttempts >= 3) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(10_000, 1_000 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(record.profileId!).catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async disconnect(reason = "Disconnected by the user."): Promise<McpConnectorView> {
    const record = await this.record();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const session = this.session;
    this.session = null;
    if (session) await session.close(reason).catch(() => undefined);
    record.state = record.enabled ? "not-connected" : "disabled";
    record.lastError = null;
    await this.saveRecord(record);
    await this.audit(null, null, "user", "mcp.disconnected", "ok", reason);
    return this.view();
  }

  async setEnabled(enabled: boolean): Promise<McpConnectorView> {
    const record = await this.record();
    if (!enabled && this.session) await this.disconnect("Connector disabled for DNAFix.");
    record.enabled = enabled;
    record.state = enabled ? (record.profileId ? "not-connected" : "not-configured") : "disabled";
    record.lastError = null;
    await this.saveRecord(record);
    await this.audit(null, null, "user", "mcp.enabled.changed", "info", `enabled=${enabled}`);
    return this.view();
  }

  private compileSchema(schema: Record<string, unknown>): ValidateFunction | null {
    const key = stableStringify(schema);
    if (this.validators.has(key)) return this.validators.get(key)!;
    let validator: ValidateFunction | null = null;
    try {
      validator = this.ajv.compile(schema);
    } catch {
      validator = null;
    }
    this.validators.set(key, validator);
    return validator;
  }

  private validateArguments(tool: McpDiscoveredTool, args: Record<string, unknown>): void {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new McpConnectorError("Tool arguments must be a JSON object.", "invalid_arguments");
    }
    if (!tool.schemaValid) throw new McpConnectorError(`Tool ${tool.serverName}/${tool.name} has an invalid input schema; it cannot be executed.`, "invalid_arguments");
    const validator = this.compileSchema(tool.inputSchema);
    if (!validator) throw new McpConnectorError(`Tool ${tool.serverName}/${tool.name} input schema could not be compiled.`, "invalid_arguments");
    if (!validator(args)) {
      const detail = (validator.errors ?? [])
        .slice(0, 4)
        .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
        .join("; ");
      throw new McpConnectorError(`Invalid arguments for ${tool.serverName}/${tool.name}: ${detail}`, "invalid_arguments");
    }
  }

  private async refreshInventory(session: GatewaySession, profileServers: string[]): Promise<McpConnectorView> {
    const warnings: string[] = [];
    const tools: McpDiscoveredTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (pages < 20) {
      const result = await session.client.listTools(cursor ? { cursor } : undefined, { timeout: this.discoveryTimeoutMs });
      for (const raw of result.tools) {
        if (tools.length >= 500) {
          warnings.push("Tool inventory exceeded 500 entries; the remainder was not loaded.");
          break;
        }
        if (!raw || typeof raw.name !== "string" || !raw.name.trim()) continue;
        const inputSchema = cloneSchema(raw.inputSchema);
        const schemaValid = Boolean(this.compileSchema(inputSchema));
        const serverName = serverFromTool(raw, profileServers, session.serverInfo.name);
        const classification = classifyTool(serverName, raw.name, raw.annotations as never);
        tools.push({
          serverName,
          name: raw.name.slice(0, 200),
          description: sanitizeText(raw.description, 2_000),
          modelName: modelToolName(serverName, raw.name),
          inputSchema,
          parameterSummary: parameterSummary(inputSchema),
          annotations: raw.annotations ?? null,
          permissionLevel: classification.level,
          reviewed: classification.reviewed,
          schemaValid,
        });
      }
      pages += 1;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    const resources: Array<{ uri: string; name: string; description: string | null }> = [];
    const prompts: Array<{ name: string; description: string | null }> = [];
    const capabilities = session.capabilities;
    if (capabilities.resources) {
      try {
        let resourceCursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const result = await session.client.listResources(resourceCursor ? { cursor: resourceCursor } : undefined, { timeout: this.discoveryTimeoutMs });
          for (const resource of result.resources) {
            resources.push({
              uri: sanitizeText(resource.uri, 1_000),
              name: sanitizeText(resource.name ?? resource.uri, 300),
              description: resource.description ? sanitizeText(resource.description, 1_000) : null,
            });
          }
          if (!result.nextCursor) break;
          resourceCursor = result.nextCursor;
        }
      } catch (err) {
        warnings.push(`Resources could not be listed: ${sanitizeText(err instanceof Error ? err.message : String(err), 300)}`);
      }
    }
    if (capabilities.prompts) {
      try {
        let promptCursor: string | undefined;
        for (let page = 0; page < 10; page += 1) {
          const result = await session.client.listPrompts(promptCursor ? { cursor: promptCursor } : undefined, { timeout: this.discoveryTimeoutMs });
          for (const prompt of result.prompts) {
            prompts.push({ name: sanitizeText(prompt.name, 300), description: prompt.description ? sanitizeText(prompt.description, 1_000) : null });
          }
          if (!result.nextCursor) break;
          promptCursor = result.nextCursor;
        }
      } catch (err) {
        warnings.push(`Prompts could not be listed: ${sanitizeText(err instanceof Error ? err.message : String(err), 300)}`);
      }
    }
    if (!capabilities.tools) warnings.push("Gateway did not advertise the tools capability; the tool list may be empty.");

    const record = await this.record();
    const previous = record.inventory;
    const fingerprint = schemaFingerprint(tools, resources, prompts);
    const previousKeys = new Set((previous?.tools ?? []).map((t) => `${t.serverName}/${t.name}`));
    const currentKeys = new Set(tools.map((t) => `${t.serverName}/${t.name}`));
    const added = [...currentKeys].filter((key) => !previousKeys.has(key));
    const removed = [...previousKeys].filter((key) => !currentKeys.has(key));
    const inventoryChanged = previous !== null && previous.fingerprint !== fingerprint;

    record.inventory = {
      gateway: {
        name: session.serverInfo.name,
        version: session.serverInfo.version,
        instructions: session.serverInfo.description ? sanitizeText(session.serverInfo.description, 4_000) : null,
        capabilities: capabilities as Record<string, unknown>,
      },
      tools,
      resources,
      prompts,
      profileServers,
      fetchedAt: this.iso(),
      fingerprint,
      warnings,
    };
    record.state = "connected";
    await this.saveRecord(record);
    await this.audit(null, null, "mcp-orchestrator", "mcp.inventory.discovered", "ok", `tools=${tools.length} resources=${resources.length} prompts=${prompts.length} fingerprint=${fingerprint}`);
    if (inventoryChanged) {
      await this.audit(
        null,
        null,
        "mcp-orchestrator",
        "mcp.inventory.changed",
        "info",
        `added=${added.slice(0, 30).join(",") || "none"} removed=${removed.slice(0, 30).join(",") || "none"}`,
      );
    }
    return this.view();
  }

  async refresh(): Promise<McpConnectorView> {
    const session = await this.ensureSession();
    const record = await this.record();
    const profileServers = record.inventory?.profileServers ?? [];
    return this.refreshInventory(session, profileServers);
  }

  private async ensureSession(): Promise<GatewaySession> {
    const record = await this.record();
    if (!record.enabled) throw new McpConnectorError("The Docker MCP connector is disabled for DNAFix.", "disabled");
    if (this.session && !this.session.closed) return this.session;
    if (!record.profileId) throw new McpConnectorError("No Docker MCP profile is selected.", "not_configured");
    await this.connect(record.profileId);
    if (!this.session || this.session.closed) throw new McpConnectorError("Docker MCP Gateway could not be reconnected.", "connection_error");
    return this.session;
  }

  private async permissionMaps(): Promise<{
    tools: Map<string, McpToolPermissionRecord>;
    servers: Map<string, McpServerPermissionRecord>;
  }> {
    const [tools, servers] = await Promise.all([
      this.store.listMcpToolPermissions(DOCKER_MCP_CONNECTION_ID),
      this.store.listMcpServerPermissions(DOCKER_MCP_CONNECTION_ID),
    ]);
    return {
      tools: new Map(tools.map((p) => [`${p.serverName}\u0000${p.toolName}`, p])),
      servers: new Map(servers.map((p) => [p.serverName, p])),
    };
  }

  async updatePermission(update: {
    serverName: string;
    toolName?: string;
    enabled: boolean;
    allowedAgents?: McpAgentRole[];
    reviewedLevel?: McpPermissionLevel;
  }): Promise<McpConnectorView> {
    const record = await this.record();
    if (!record.inventory) throw new McpConnectorError("Connect and discover a profile before configuring permissions.", "not_connected");
    const serverExists = record.inventory.tools.some((t) => t.serverName === update.serverName) || record.inventory.profileServers.includes(update.serverName);
    if (!serverExists) throw new McpConnectorError(`Unknown MCP server '${update.serverName}'.`, "invalid_arguments");
    const maps = await this.permissionMaps();
    const now = this.iso();
    if (!update.toolName) {
      const current = maps.servers.get(update.serverName);
      const allowedAgents = update.allowedAgents ?? current?.allowedAgents ?? BOTH_AGENTS;
      if (update.enabled && allowedAgents.length === 0) throw new McpConnectorError("Select at least one agent role for this server.", "invalid_arguments");
      const permission: McpServerPermissionRecord = {
        connectionId: DOCKER_MCP_CONNECTION_ID,
        serverName: update.serverName,
        enabled: update.enabled,
        allowedAgents,
        updatedAt: now,
      };
      await this.store.saveMcpServerPermission(permission);
      await this.audit(null, null, "user", "mcp.server.permission", "info", `server=${update.serverName} enabled=${update.enabled} agents=${allowedAgents.join(",")}`);
      return this.view();
    }

    const tool = record.inventory.tools.find((t) => t.serverName === update.serverName && t.name === update.toolName);
    if (!tool) throw new McpConnectorError(`Unknown MCP tool '${update.serverName}/${update.toolName}'.`, "invalid_arguments");
    const current = maps.tools.get(`${update.serverName}\u0000${update.toolName}`);
    const reviewedLevel = update.reviewedLevel ?? current?.reviewedLevel ?? null;
    if (update.enabled && !tool.reviewed && reviewedLevel === null) {
      throw new McpConnectorError(
        `Tool '${tool.name}' is not covered by the reviewed policy. Review the tool and choose an explicit permission level before enabling it.`,
        "tool_unreviewed",
      );
    }
    // A tool the policy already covers cannot be talked down by a later edit;
    // a reviewer may make it stricter, never looser. For tools outside the
    // policy the reviewer's level is the only level, so it replaces the
    // conservative default instead of being floored by it.
    if (reviewedLevel !== null && tool.reviewed && reviewedLevel < tool.permissionLevel) {
      throw new McpConnectorError(
        `Tool '${tool.name}' is classified ${permissionLabel(tool.permissionLevel)} by the reviewed policy. Choose that level or a stricter one.`,
        "level_too_low",
      );
    }
    const allowedAgents = update.allowedAgents ?? current?.allowedAgents ?? BOTH_AGENTS;
    if (update.enabled && allowedAgents.length === 0) throw new McpConnectorError("Select at least one agent role for this tool.", "invalid_arguments");
    const serverPermission = maps.servers.get(update.serverName);
    if (update.enabled && serverPermission && !serverPermission.enabled) {
      throw new McpConnectorError(`Server '${update.serverName}' is disabled. Enable the server before enabling its tools.`, "tool_disabled");
    }
    const permission: McpToolPermissionRecord = {
      connectionId: DOCKER_MCP_CONNECTION_ID,
      serverName: update.serverName,
      toolName: update.toolName,
      enabled: update.enabled,
      allowedAgents,
      reviewedLevel,
      reviewedAt: update.reviewedLevel ? now : (current?.reviewedAt ?? null),
      updatedAt: now,
    };
    await this.store.saveMcpToolPermission(permission);
    await this.audit(
      null,
      null,
      "user",
      "mcp.tool.permission",
      "info",
      `tool=${update.serverName}/${update.toolName} enabled=${update.enabled} level=${reviewedLevel ?? tool.permissionLevel} reviewed=${tool.reviewed || reviewedLevel !== null} agents=${allowedAgents.join(",")}`,
    );
    return this.view();
  }

  async toolsForAgent(runId: string, agent: McpAgentRole): Promise<AgentMcpTool[]> {
    const record = await this.record();
    if (!record.enabled) return [];
    if (!this.session || this.session.closed) return [];
    const views = await this.toolViews(record);
    return views
      .filter((tool) => tool.enabled && tool.allowedAgents.includes(agent) && tool.schemaValid)
      .filter((tool) => (agent === "verification-agent" ? tool.permissionLevel === 1 : true))
      .sort((a, b) => a.permissionLevel - b.permissionLevel || `${a.serverName}/${a.name}`.localeCompare(`${b.serverName}/${b.name}`))
      .slice(0, this.maxToolsPerAgent)
      .map((tool) => ({
        modelName: tool.modelName,
        serverName: tool.serverName,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        permissionLevel: tool.permissionLevel,
        reviewed: tool.reviewed,
      }));
  }

  signalForRun(runId: string): AbortSignal {
    let controller = this.runControllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.runControllers.set(runId, controller);
    }
    return controller.signal;
  }

  async cancelRun(runId: string): Promise<void> {
    this.runControllers.get(runId)?.abort(new Error("Run cancelled by the user."));
    const pending = await this.store.listMcpApprovals({ runId, status: "pending" });
    for (const approval of pending) {
      approval.status = "cancelled";
      approval.decidedAt = this.iso();
      approval.decidedBy = "system";
      await this.store.saveMcpApproval(approval);
    }
    if (pending.length > 0) await this.audit(runId, null, "mcp-orchestrator", "mcp.approvals.cancelled", "info", `${pending.length} pending approval(s) cancelled with the run`);
  }

  releaseRun(runId: string): void {
    this.runControllers.delete(runId);
  }

  /**
   * Close out what a driver that died mid-call left behind, before a new driver
   * touches the run: an approval nobody is waiting on any more, and an invocation
   * that was sent to the gateway with no recorded result. The second is reported as
   * unresolved rather than as not-run — DNAFix does not claim a side effect did not
   * happen, and the next loop sees it in the run's history.
   */
  async reconcileInterruptedRun(runId: string): Promise<{ approvalsCancelled: number; invocationsUnresolved: number }> {
    const pending = await this.store.listMcpApprovals({ runId, status: "pending" });
    for (const approval of pending) {
      approval.status = "cancelled";
      approval.decidedAt = this.iso();
      approval.decidedBy = "system";
      await this.store.saveMcpApproval(approval);
    }

    const unresolved = (await this.store.listMcpInvocations({ runId })).filter((invocation) => invocation.executed && !invocation.completedAt);
    for (const invocation of unresolved) {
      invocation.completedAt = this.iso();
      invocation.durationMs = new Date(invocation.completedAt).getTime() - new Date(invocation.startedAt).getTime();
      invocation.success = false;
      invocation.error = "The driver stopped before the gateway returned. This call may have taken effect; it was not repeated by reconciliation.";
      await this.store.saveMcpInvocation(invocation);
    }

    if (pending.length > 0 || unresolved.length > 0) {
      await this.audit(
        runId,
        null,
        "system",
        "mcp.reconciled",
        "info",
        `approvals cancelled=${pending.length} invocations unresolved=${unresolved.length}`,
      );
    }
    return { approvalsCancelled: pending.length, invocationsUnresolved: unresolved.length };
  }

  private async requestApproval(input: {
    runId: string;
    serverName: string;
    toolName: string;
    kind: "per-call" | "run-grant";
    permissionLevel: McpPermissionLevel;
    argumentsRedacted: Record<string, unknown>;
    argumentsHash: string;
    summary: string;
    consequences: string;
    correlationId: string;
  }): Promise<McpApprovalRecord> {
    const requestedAt = this.iso();
    const approval: McpApprovalRecord = {
      id: `apr_${randomUUID().slice(0, 12)}`,
      runId: input.runId,
      connectionId: DOCKER_MCP_CONNECTION_ID,
      serverName: input.serverName,
      toolName: input.toolName,
      kind: input.kind,
      permissionLevel: input.permissionLevel,
      correlationId: input.correlationId,
      argumentsRedacted: input.argumentsRedacted,
      argumentsHash: input.argumentsHash,
      summary: sanitizeText(input.summary, 1_000),
      consequences: sanitizeText(input.consequences, 1_500),
      status: "pending",
      requestedAt,
      expiresAt: new Date(this.now().getTime() + this.approvalTimeoutMs).toISOString(),
      decidedAt: null,
      decidedBy: null,
    };
    await this.store.saveMcpApproval(approval);
    await this.audit(
      input.runId,
      null,
      "mcp-orchestrator",
      input.kind === "run-grant" ? "mcp.approval.grant-requested" : "mcp.approval.requested",
      "info",
      `approval=${approval.id} tool=${input.serverName}/${input.toolName} level=${input.permissionLevel} correlation=${input.correlationId}`,
    );
    return approval;
  }

  private async waitForApproval(approval: McpApprovalRecord, signal?: AbortSignal): Promise<McpApprovalRecord> {
    for (;;) {
      const current = await this.store.getMcpApproval(approval.id);
      if (!current) throw new McpConnectorError("Approval record disappeared before a decision was made.", "approval_denied");
      if (current.status !== "pending") return current;
      if (signal?.aborted) {
        current.status = "cancelled";
        current.decidedAt = this.iso();
        current.decidedBy = "system";
        await this.store.saveMcpApproval(current);
        return current;
      }
      if (this.now().getTime() >= new Date(current.expiresAt).getTime()) {
        current.status = "expired";
        current.decidedAt = this.iso();
        current.decidedBy = "system";
        await this.store.saveMcpApproval(current);
        await this.audit(current.runId, null, "mcp-orchestrator", "mcp.approval.expired", "info", `approval=${current.id}`);
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async decideApproval(runId: string, approvalId: string, decision: "approve" | "deny", decidedBy = "user"): Promise<McpApprovalRecord> {
    const approval = await this.store.getMcpApproval(approvalId);
    if (!approval) throw new McpConnectorError("Approval not found.", "invalid_arguments");
    if (approval.runId !== runId) throw new McpConnectorError("Approval belongs to a different run.", "invalid_arguments");
    if (approval.status !== "pending") throw new McpConnectorError(`Approval is already ${approval.status}. Each decision applies to one invocation only.`, "invalid_arguments");
    approval.status = decision === "approve" ? "approved" : "denied";
    approval.decidedAt = this.iso();
    approval.decidedBy = sanitizeText(decidedBy, 120);
    await this.store.saveMcpApproval(approval);
    if (decision === "approve" && approval.kind === "run-grant") {
      const grant: McpRunGrantRecord = {
        id: `grant_${randomUUID().slice(0, 12)}`,
        runId: approval.runId,
        connectionId: DOCKER_MCP_CONNECTION_ID,
        serverName: approval.serverName,
        toolName: approval.toolName,
        permissionLevel: approval.permissionLevel,
        workspaceScope: "DNAFix run workspace only",
        createdAt: this.iso(),
      };
      await this.store.saveMcpRunGrant(grant);
    }
    await this.audit(
      approval.runId,
      null,
      "user",
      decision === "approve" ? "mcp.approval.approved" : "mcp.approval.denied",
      decision === "approve" ? "ok" : "info",
      `approval=${approval.id} tool=${approval.serverName}/${approval.toolName} kind=${approval.kind} hash=${approval.argumentsHash.slice(0, 12)}`,
    );
    return approval;
  }

  async listRunApprovals(runId: string): Promise<McpApprovalRecord[]> {
    return (await this.store.listMcpApprovals({ runId })).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  async listApprovals(filter: { runId?: string; status?: McpApprovalRecord["status"] } = {}): Promise<McpApprovalRecord[]> {
    return (await this.store.listMcpApprovals(filter)).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  async listActivity(filter: { runId?: string; limit?: number } = {}): Promise<McpInvocationRecord[]> {
    return this.store.listMcpInvocations(filter);
  }

  private async saveInvocation(invocation: McpInvocationRecord): Promise<void> {
    await this.store.saveMcpInvocation(invocation);
  }

  async executeToolCall(input: {
    runId: string;
    repositoryId: string | null;
    agent: McpAgentRole;
    modelId: string;
    tool: AgentMcpTool;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ text: string; isError: boolean; summary: string }> {
    const record = await this.record();
    const correlationId = `cor_${randomUUID().slice(0, 12)}`;
    const redactedArgs = (redactValue(input.arguments) ?? {}) as Record<string, unknown>;
    const startedAt = this.iso();
    const invocation: McpInvocationRecord = {
      id: `inv_${randomUUID().slice(0, 12)}`,
      correlationId,
      runId: input.runId,
      connectionId: DOCKER_MCP_CONNECTION_ID,
      serverName: input.tool.serverName,
      toolName: input.tool.toolName,
      agent: input.agent,
      modelId: input.modelId,
      // Unknown until the trusted level is derived below; a call rejected
      // before that point stays at the conservative default.
      permissionLevel: 3,
      approvalId: null,
      approvalStatus: "not-required",
      executed: false,
      startedAt,
      completedAt: null,
      durationMs: null,
      success: false,
      argumentsRedacted: redactedArgs,
      resultSummary: null,
      error: null,
    };

    const deny = async (message: string, approvalStatus: string, approvalId: string | null = null): Promise<{ text: string; isError: boolean; summary: string }> => {
      invocation.approvalId = approvalId;
      invocation.approvalStatus = approvalStatus;
      invocation.completedAt = this.iso();
      invocation.durationMs = new Date(invocation.completedAt).getTime() - new Date(startedAt).getTime();
      invocation.error = sanitizeText(message, 2_000);
      await this.saveInvocation(invocation);
      await this.audit(input.runId, input.repositoryId, input.agent, `mcp.${input.tool.serverName}.${input.tool.toolName}.rejected`, "error", `correlation=${correlationId} ${message}`);
      return { text: `MCP call rejected: ${message}`, isError: true, summary: message };
    };

    if (!record.enabled) return deny("The Docker MCP connector is disabled for DNAFix.", "not-required");
    if (!this.session || this.session.closed) return deny("No live Docker MCP Gateway session. Reconnect the connector.", "not-required");
    const currentTools = await this.toolsForAgent(input.runId, input.agent);
    const registered = currentTools.find((t) => t.modelName === input.tool.modelName && t.serverName === input.tool.serverName && t.toolName === input.tool.toolName);
    if (!registered) {
      return deny("This tool is not enabled for the current agent/run scope, or the connector is disconnected.", "not-required");
    }
    const discovered = record.inventory?.tools.find((t) => t.serverName === input.tool.serverName && t.name === input.tool.toolName);
    if (!discovered) return deny("The tool is no longer present in the discovered inventory. Refresh the connector.", "not-required");

    try {
      this.validateArguments(discovered, input.arguments);
    } catch (err) {
      return deny(err instanceof Error ? err.message : String(err), "not-required");
    }

    // Authorization uses levels DNAFix derives server-side, never the level on
    // the caller-supplied tool object: a model that mislabels a destructive
    // tool as read-only must not be able to talk its past the approval gate.
    // A policy-covered tool also keeps its floor even if a stored permission
    // record says otherwise; for a tool outside the policy the reviewer's
    // explicit level is the trusted level.
    const fresh = classifyTool(discovered.serverName, discovered.name, discovered.annotations);
    const trustedLevel = (fresh.reviewed ? Math.max(registered.permissionLevel, fresh.level) : registered.permissionLevel) as McpPermissionLevel;
    invocation.permissionLevel = trustedLevel;

    const used = (await this.store.listMcpInvocations({ runId: input.runId })).filter((i) => i.executed).length;
    if (used >= this.maxToolCallsPerRun) {
      return deny(`Maximum MCP tool calls per run reached (${this.maxToolCallsPerRun}).`, "not-required");
    }
    if (input.signal?.aborted) return deny("The run was cancelled before the MCP call started.", "cancelled");

    const argumentsHash = hashArguments(input.arguments);
    let approvalStatus = "not-required";
    let approvalId: string | null = null;
    try {
      if (trustedLevel === 2) {
        const grants = await this.store.listMcpRunGrants(input.runId);
        const granted = grants.some(
          (g) =>
            g.connectionId === DOCKER_MCP_CONNECTION_ID &&
            g.serverName === input.tool.serverName &&
            g.toolName === input.tool.toolName &&
            g.permissionLevel <= 2,
        );
        if (!granted) {
          const approval = await this.requestApproval({
            runId: input.runId,
            serverName: input.tool.serverName,
            toolName: input.tool.toolName,
            kind: "run-grant",
            permissionLevel: 2,
            argumentsRedacted: redactedArgs,
            argumentsHash,
            summary: `${input.agent} wants a run-scoped grant for ${input.tool.serverName}/${input.tool.toolName}. Target: ${describeTarget(input.arguments)}`,
            consequences: consequencesFor(2, discovered),
            correlationId,
          });
          approvalId = approval.id;
          approvalStatus = "pending";
          const decided = await this.waitForApproval(approval, input.signal);
          approvalStatus = decided.status;
          if (decided.status !== "approved") {
            return deny(
              decided.status === "denied" ? "The run-scoped grant was denied by the user." : `The run-scoped grant was ${decided.status}.`,
              approvalStatus,
              approvalId,
            );
          }
        }
      } else if (trustedLevel === 3) {
        const approval = await this.requestApproval({
          runId: input.runId,
          serverName: input.tool.serverName,
          toolName: input.tool.toolName,
          kind: "per-call",
          permissionLevel: 3,
          argumentsRedacted: redactedArgs,
          argumentsHash,
          summary: `${input.agent} wants to run ${input.tool.serverName}/${input.tool.toolName}. Target: ${describeTarget(input.arguments)}`,
          consequences: consequencesFor(3, discovered),
          correlationId,
        });
        approvalId = approval.id;
        approvalStatus = "pending";
        const decided = await this.waitForApproval(approval, input.signal);
        approvalStatus = decided.status;
        if (decided.status !== "approved") {
          return deny(
            decided.status === "denied" ? "The user denied this destructive MCP call." : `The approval was ${decided.status}. The call was not executed.`,
            approvalStatus,
            approvalId,
          );
        }
      }

      invocation.approvalId = approvalId;
      invocation.approvalStatus = approvalStatus;
      const session = await this.ensureSession();
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal?.reason);
      if (input.signal) {
        if (input.signal.aborted) abort();
        else input.signal.addEventListener("abort", abort, { once: true });
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("MCP tool call timed out."));
          reject(new McpConnectorError(`MCP tool call timed out after ${this.toolCallTimeoutMs} ms.`, "timeout"));
        }, this.toolCallTimeoutMs);
      });
      let result: unknown;
      try {
        // Intent before effect: the gateway is about to be asked to change something
        // real, so the row goes to disk first. A process that dies mid-call leaves
        // "executed, no result" behind instead of silence.
        invocation.executed = true;
        await this.saveInvocation(invocation);
        result = await Promise.race([
          session.client.callTool(
            { name: input.tool.toolName, arguments: input.arguments },
            undefined,
            { timeout: this.toolCallTimeoutMs, signal: controller.signal },
          ),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }

      const sanitized = sanitizeToolResult(result);
      invocation.completedAt = this.iso();
      invocation.durationMs = new Date(invocation.completedAt).getTime() - new Date(startedAt).getTime();
      invocation.success = !sanitized.isError;
      invocation.resultSummary = sanitized.summary.slice(0, 4_000);
      invocation.error = sanitized.isError ? sanitized.summary.slice(0, 2_000) : null;
      await this.saveInvocation(invocation);
      await this.audit(
        input.runId,
        input.repositoryId,
        input.agent,
        `mcp.${input.tool.serverName}.${input.tool.toolName}`,
        sanitized.isError ? "error" : "ok",
        `correlation=${correlationId} level=${trustedLevel} approval=${approvalId ?? "none"} durationMs=${invocation.durationMs} result=${sanitized.summary}`,
      );
      return { text: sanitized.text, isError: sanitized.isError, summary: sanitized.summary };
    } catch (err) {
      const message = sanitizeText(err instanceof Error ? err.message : String(err), 1_000);
      invocation.completedAt = this.iso();
      invocation.durationMs = new Date(invocation.completedAt).getTime() - new Date(startedAt).getTime();
      invocation.success = false;
      invocation.error = message;
      invocation.approvalId = approvalId;
      invocation.approvalStatus = approvalStatus;
      await this.saveInvocation(invocation);
      await this.audit(
        input.runId,
        input.repositoryId,
        input.agent,
        `mcp.${input.tool.serverName}.${input.tool.toolName}`,
        "error",
        `correlation=${correlationId} level=${trustedLevel} approval=${approvalId ?? "none"} error=${message}`,
      );
      return { text: `MCP tool call failed: ${message}`, isError: true, summary: message };
    }
  }

  async shutdown(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const session = this.session;
    this.session = null;
    if (session) await session.close("DNAFix API shutting down.").catch(() => undefined);
    for (const controller of this.runControllers.values()) controller.abort(new Error("DNAFix is shutting down."));
    this.runControllers.clear();
  }
}

export function createMcpConnectorService(options: McpConnectorOptions): McpConnectorService {
  return new McpConnectorService(options);
}

export function platformLabel(platform: NodeJS.Platform): string {
  return hostLabel(platform);
}
