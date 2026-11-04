import { describe, expect, it } from "vitest";
import { MemoryStore } from "@dnafix/persistence";
import {
  McpConnectorError,
  McpConnectorService,
  modelToolName,
  type AgentMcpTool,
} from "./index.js";
import type { ExecFn, ExecResult } from "./docker.js";
import {
  buildGatewayArgs,
  type GatewayConnector,
  type GatewayLaunchOptions,
  type GatewaySession,
  type McpClientLike,
  type McpToolListing,
} from "./gateway.js";

const PROFILE_ID = "dnafix-dev";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1 });

const ROUTES: Record<string, ExecResult> = {
  "--version": ok("Docker version 29.8.2, build 1234"),
  "desktop version": ok("Docker Desktop 4.45.0"),
  "desktop status --format json": ok(JSON.stringify({ status: "running", engine: { running: true } })),
  "mcp version": ok("Docker MCP CLI version 0.44.1"),
  "mcp feature ls --format json": ok(JSON.stringify([{ name: "mcp-toolkit", enabled: true }])),
  "mcp gateway --help": ok("Usage: docker mcp gateway run"),
  "mcp profile ls --format json": ok(
    JSON.stringify({
      profiles: [
        { id: PROFILE_ID, name: "DNAFix Dev", servers: ["docker"] },
        { id: "other", name: "Other", servers: ["docker"] },
      ],
    }),
  ),
  [`mcp profile show ${PROFILE_ID} --format json`]: ok(JSON.stringify({ profile: { id: PROFILE_ID, servers: ["docker"] } })),
  "mcp profile show other --format json": ok(JSON.stringify({ profile: { id: "other", servers: ["docker"] } })),
};

const DEFAULT_TOOLS: McpToolListing[] = [
  {
    name: "list_containers",
    description: "List containers",
    inputSchema: { type: "object", properties: { all: { type: "boolean" } }, additionalProperties: false },
    _meta: { server: "docker" },
  },
  {
    name: "inspect_container",
    description: "Inspect one container",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: true },
    _meta: { server: "docker" },
  },
  {
    name: "create_container",
    description: "Create a container",
    inputSchema: { type: "object", properties: { image: { type: "string" } }, required: ["image"], additionalProperties: false },
    _meta: { server: "docker" },
  },
  {
    name: "remove_container",
    description: "Remove a container",
    inputSchema: { type: "object", properties: { container: { type: "string" } }, required: ["container"], additionalProperties: false },
    _meta: { server: "docker" },
  },
  {
    name: "frobnicate_everything",
    description: "Unknown tool that must require human review",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    _meta: { server: "docker" },
  },
];

const LIST_TOOL: McpToolListing = DEFAULT_TOOLS[0]!;
const CREATE_TOOL: McpToolListing = DEFAULT_TOOLS[2]!;
const REMOVE_TOOL: McpToolListing = DEFAULT_TOOLS[3]!;

interface Page {
  tools: McpToolListing[];
  nextCursor?: string;
}

class FakeClient implements McpClientLike {
  readonly callToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  result: unknown = { content: [{ type: "text", text: "ok" }] };
  private pages: Page[];

  constructor(pages: Page[]) {
    this.pages = pages;
  }

  setPages(pages: Page[]): void {
    this.pages = pages;
  }

  getServerVersion() {
    return { name: "docker-mcp-gateway", version: "0.44.1" };
  }

  getServerCapabilities() {
    return { tools: {}, resources: {}, prompts: {} };
  }

  async listTools(params?: { cursor?: string }) {
    const index = params?.cursor ? Number(params.cursor.replace("page-", "")) : 0;
    return this.pages[index] ?? { tools: [] };
  }

  async listResources() {
    return { resources: [{ uri: "docker://containers", name: "containers", description: "Container list" }] };
  }

  async listPrompts() {
    return { prompts: [{ name: "triage", description: "Triage prompt" }] };
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    this.callToolCalls.push({ name: params.name, arguments: params.arguments });
    return this.result;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

class FakeSession implements GatewaySession {
  private isClosed = false;
  private readonly listeners: Array<(reason: string) => void> = [];
  readonly pid = 4321;
  readonly serverInfo = { name: "docker-mcp-gateway", version: "0.44.1" };
  readonly capabilities = { tools: {}, resources: {}, prompts: {} };

  constructor(readonly client: FakeClient) {}

  get closed(): boolean {
    return this.isClosed;
  }

  stderrTail(): string {
    return "";
  }

  onClose(listener: (reason: string) => void): void {
    this.listeners.push(listener);
  }

  async close(reason = "closed"): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const listener of this.listeners) listener(reason);
    await this.client.close();
  }

  emitClose(reason: string): void {
    this.isClosed = true;
    for (const listener of this.listeners) listener(reason);
  }
}

interface SetupOptions {
  tools?: McpToolListing[];
  pages?: Page[];
  autoReconnect?: boolean;
  maxToolCallsPerRun?: number;
  approvalTimeoutMs?: number;
}

async function setup(options: SetupOptions = {}) {
  const store = new MemoryStore();
  const clients: FakeClient[] = [];
  const sessions: FakeSession[] = [];
  const launches: GatewayLaunchOptions[] = [];
  let connectorError: string | null = null;
  const connector: GatewayConnector = async (launch) => {
    launches.push(launch);
    if (connectorError) throw new Error(connectorError);
    const client = new FakeClient(
      options.pages ?? [
        {
          tools: options.tools ?? DEFAULT_TOOLS,
        },
      ],
    );
    const session = new FakeSession(client);
    clients.push(client);
    sessions.push(session);
    return session;
  };
  const exec: ExecFn = async (_file, args) => {
    const route = ROUTES[args.join(" ")];
    if (!route) throw new Error(`unexpected docker exec: ${args.join(" ")}`);
    return route;
  };
  const mcp = new McpConnectorService({
    store,
    exec,
    platform: "win32",
    env: { DNAFIX_DOCKER_PATH: "C:\\Docker\\docker.exe", PATH: "C:\\Windows", MODEL_API_KEY: "must-not-leak" },
    connector,
    autoReconnect: options.autoReconnect ?? false,
    maxToolCallsPerRun: options.maxToolCallsPerRun,
    approvalTimeoutMs: options.approvalTimeoutMs,
  });
  return {
    store,
    mcp,
    clients,
    sessions,
    launches,
    setConnectorError: (value: string | null) => {
      connectorError = value;
    },
  };
}

async function connect(context: Awaited<ReturnType<typeof setup>>, profileId = PROFILE_ID) {
  await context.mcp.setEnabled(true);
  return context.mcp.connect(profileId);
}

async function toolFor(context: Awaited<ReturnType<typeof setup>>, runId: string, name: string, agent: "coding-agent" | "verification-agent" = "coding-agent"): Promise<AgentMcpTool> {
  const tools = await context.mcp.toolsForAgent(runId, agent);
  const tool = tools.find((entry) => entry.toolName === name);
  if (!tool) throw new Error(`tool '${name}' was not exposed to ${agent}: ${tools.map((t) => t.toolName).join(", ")}`);
  return tool;
}

async function enableTool(context: Awaited<ReturnType<typeof setup>>, name: string, extra: { reviewedLevel?: 1 | 2 | 3; allowedAgents?: Array<"coding-agent" | "verification-agent"> } = {}) {
  return context.mcp.updatePermission({
    serverName: "docker",
    toolName: name,
    enabled: true,
    ...(extra.reviewedLevel ? { reviewedLevel: extra.reviewedLevel } : {}),
    ...(extra.allowedAgents ? { allowedAgents: extra.allowedAgents } : {}),
  });
}

async function pendingApproval(store: MemoryStore, runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [approval] = await store.listMcpApprovals({ runId, status: "pending" });
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no pending MCP approval appeared");
}

describe("MCP connection lifecycle", () => {
  it("never reports connected before enablement, profile selection, and a real handshake", async () => {
    const context = await setup();
    const initial = await context.mcp.getOverview();
    expect(initial.state).toBe("disabled");
    expect(initial.reason).toMatch(/temporarily disabled/);
    expect(initial.gateway).toBeNull();
    expect(initial.tools).toEqual([]);

    await context.mcp.setEnabled(true);
    const enabled = await context.mcp.getOverview();
    expect(enabled.state).toBe("not-configured");
    expect(enabled.gateway).toBeNull();
    await expect(context.mcp.connect()).rejects.toMatchObject({ code: "not_configured" });
    expect(context.sessions).toHaveLength(0);
  });

  it("marks connecting while the handshake is pending, then connected with the gateway identity", async () => {
    const context = await setup();
    let resolveSession: ((session: GatewaySession) => void) | null = null;
    const deferred = new McpConnectorService({
      store: context.store,
      exec: async (_file, args) => ROUTES[args.join(" ")] ?? ok(""),
      platform: "win32",
      env: { DNAFIX_DOCKER_PATH: "C:\\Docker\\docker.exe" },
      connector: async () =>
        new Promise<GatewaySession>((resolve) => {
          resolveSession = resolve;
        }),
      autoReconnect: false,
    });
    await deferred.setEnabled(true);
    await deferred.selectProfile(PROFILE_ID);
    const connecting = deferred.connect(PROFILE_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const during = await deferred.getOverview();
    expect(during.state).toBe("connecting");
    expect(during.gateway).toBeNull();

    const session = new FakeSession(new FakeClient([{ tools: DEFAULT_TOOLS }]));
    resolveSession!(session);
    const view = await connecting;
    expect(view.state).toBe("connected");
    expect(view.gateway?.serverInfo).toEqual({ name: "docker-mcp-gateway", version: "0.44.1" });
    expect(view.lastHandshakeAt).not.toBeNull();
  });

  it("launches the gateway with the trusted argv and a secret-free environment", async () => {
    const context = await setup();
    const view = await connect(context);
    expect(view.state).toBe("connected");
    expect(context.launches[0]!.command).toBe("C:\\Docker\\docker.exe");
    expect(context.launches[0]!.args).toEqual(buildGatewayArgs(PROFILE_ID));
    expect(context.launches[0]!.env.MODEL_API_KEY).toBeUndefined();
    expect(context.launches[0]!.env.PATH).toBe("C:\\Windows");
  });

  it("surfaces a failed handshake as connection-error and never as connected", async () => {
    const context = await setup();
    context.setConnectorError("MCP initialize handshake failed: gateway exited");
    await context.mcp.setEnabled(true);
    await expect(context.mcp.connect(PROFILE_ID)).rejects.toMatchObject({ code: "connection_error" });
    const view = await context.mcp.getOverview();
    expect(view.state).toBe("connection-error");
    expect(view.lastError).toMatch(/handshake failed/);
    expect(view.gateway).toBeNull();
    expect(view.lastHandshakeAt).toBeNull();
    expect(await context.mcp.toolsForAgent("run", "coding-agent")).toEqual([]);
  });

  it("disconnects cleanly and reports an unexpected gateway exit with its exact reason", async () => {
    const context = await setup();
    await connect(context);
    await context.mcp.disconnect();
    expect(context.sessions[0]!.closed).toBe(true);
    expect((await context.mcp.getOverview()).state).toBe("not-connected");
    expect(await context.mcp.toolsForAgent("run", "coding-agent")).toEqual([]);

    const second = await setup();
    await connect(second);
    second.sessions[0]!.emitClose("gateway crashed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const view = await second.mcp.getOverview();
    expect(view.state).toBe("connection-error");
    expect(view.lastError).toBe("gateway crashed");
  });

  it("closes the child session on shutdown and aborts run-scoped work", async () => {
    const context = await setup();
    await connect(context);
    const signal = context.mcp.signalForRun("run-shutdown");
    await context.mcp.shutdown();
    expect(context.sessions[0]!.closed).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("validates profile ids and only accepts profiles Docker actually reports", async () => {
    const context = await setup();
    await context.mcp.setEnabled(true);
    await expect(context.mcp.selectProfile("../escape")).rejects.toBeInstanceOf(McpConnectorError);
    await expect(context.mcp.selectProfile("missing")).rejects.toMatchObject({ code: "profile_invalid" });
    const selected = await context.mcp.selectProfile(PROFILE_ID);
    expect(selected.profileId).toBe(PROFILE_ID);
    expect(selected.selectedProfile?.id).toBe(PROFILE_ID);

    await context.mcp.connect();
    const switched = await context.mcp.selectProfile("other");
    expect(context.sessions[0]!.closed).toBe(true);
    expect(switched.profileId).toBe("other");
    expect(switched.state).toBe("not-connected");
  });
});

describe("MCP discovery and permissions", () => {
  it("discovers real tools, resources, prompts, and groups tools by server across pages", async () => {
    const context = await setup({
      pages: [
        {
          tools: [LIST_TOOL, CREATE_TOOL],
          nextCursor: "page-1",
        },
        {
          tools: [REMOVE_TOOL, { name: "weird_tool", description: "invalid schema", inputSchema: { type: "nonsense" }, _meta: { server: "docker" } }],
        },
      ],
    });
    const view = await connect(context);
    expect(view.toolCount).toBe(4);
    expect(view.serverCount).toBe(1);
    expect(view.servers[0]!).toMatchObject({ name: "docker", toolCount: 4, health: "reachable" });
    expect(view.resources).toEqual([{ uri: "docker://containers", name: "containers", description: "Container list" }]);
    expect(view.prompts).toEqual([{ name: "triage", description: "Triage prompt" }]);
    expect(view.tools.find((tool) => tool.name === "weird_tool")?.schemaValid).toBe(false);
    expect(view.inventory?.warnings).toEqual([]);
    expect(view.inventory?.fingerprint).toMatch(/^[a-f0-9]{24}$/);
  });

  it("refreshes inventory and audits a fingerprint change", async () => {
    const context = await setup();
    await connect(context);
    const firstFingerprint = (await context.mcp.getOverview()).inventory?.fingerprint;
    context.clients[0]!.setPages([{ tools: [LIST_TOOL] }]);
    const refreshed = await context.mcp.refresh();
    expect(refreshed.toolCount).toBe(1);
    expect(refreshed.inventory?.fingerprint).not.toBe(firstFingerprint);
    const audit = await context.store.listAudit();
    expect(audit.some((event) => event.action === "mcp.inventory.changed")).toBe(true);
  });

  it("keeps unknown tools disabled at Level 3 until a human explicitly reviews them", async () => {
    const context = await setup();
    const view = await connect(context);
    const unknown = view.tools.find((tool) => tool.name === "frobnicate_everything");
    expect(unknown).toMatchObject({ enabled: false, permissionLevel: 3, reviewed: false, risk: "high" });

    await expect(enableTool(context, "frobnicate_everything")).rejects.toMatchObject({ code: "tool_unreviewed" });
    const reviewed = await enableTool(context, "frobnicate_everything", { reviewedLevel: 2 });
    const reviewedTool = reviewed.tools.find((tool) => tool.name === "frobnicate_everything");
    expect(reviewedTool).toMatchObject({ enabled: true, permissionLevel: 2, reviewedLevel: 2, reviewed: true });
    const exposed = await toolFor(context, "run", "frobnicate_everything");
    expect(exposed.permissionLevel).toBe(2);
  });

  it("separates server enablement from tool enablement", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "list_containers");
    expect(await context.mcp.toolsForAgent("run", "coding-agent")).toHaveLength(1);

    await context.mcp.updatePermission({ serverName: "docker", enabled: false });
    const view = await context.mcp.getOverview();
    expect(view.servers[0]!.enabled).toBe(false);
    expect(view.tools.every((tool) => !tool.enabled)).toBe(true);
    expect(await context.mcp.toolsForAgent("run", "coding-agent")).toEqual([]);
    await expect(enableTool(context, "list_containers")).rejects.toMatchObject({ code: "tool_disabled" });
  });

  it("rejects permissions for servers or tools that were never discovered", async () => {
    const context = await setup();
    await connect(context);
    await expect(
      context.mcp.updatePermission({ serverName: "ghost", toolName: "list_containers", enabled: true }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(context.mcp.updatePermission({ serverName: "docker", toolName: "ghost_tool", enabled: true })).rejects.toMatchObject({
      code: "invalid_arguments",
    });
  });

  it("scopes tools per agent: verification gets Level 1 only, coding gets enabled Levels 1-3", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "list_containers");
    await enableTool(context, "inspect_container");
    await enableTool(context, "create_container");
    await enableTool(context, "remove_container");

    const verification = await context.mcp.toolsForAgent("run", "verification-agent");
    expect(verification.map((tool) => [tool.toolName, tool.permissionLevel])).toEqual([
      ["inspect_container", 1],
      ["list_containers", 1],
    ]);
    const coding = await context.mcp.toolsForAgent("run", "coding-agent");
    expect(coding.map((tool) => tool.permissionLevel)).toEqual([1, 1, 2, 3]);

    await context.mcp.updatePermission({
      serverName: "docker",
      toolName: "list_containers",
      enabled: true,
      allowedAgents: ["coding-agent"],
    });
    expect((await context.mcp.toolsForAgent("run", "verification-agent")).some((tool) => tool.toolName === "list_containers")).toBe(false);
    await expect(
      context.mcp.updatePermission({ serverName: "docker", toolName: "list_containers", enabled: true, allowedAgents: [] }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("never exposes a tool whose input schema could not be compiled", async () => {
    const context = await setup({
      tools: [LIST_TOOL, { name: "weird_tool", description: "invalid schema", inputSchema: { type: "nonsense" }, _meta: { server: "docker" } }],
    });
    await connect(context);
    await enableTool(context, "weird_tool", { reviewedLevel: 1 });
    expect(await context.mcp.toolsForAgent("run", "coding-agent")).toEqual([]);
  });
});

describe("MCP execution, approvals, and audit", () => {
  it("executes an enabled Level 1 tool without approval and records full audit metadata", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "list_containers");
    const tool = await toolFor(context, "run-1", "list_containers");
    const result = await context.mcp.executeToolCall({
      runId: "run-1",
      repositoryId: "repo-1",
      agent: "coding-agent",
      modelId: "muse-spark-1.3",
      tool,
      arguments: { all: true },
    });
    expect(result.isError).toBe(false);
    expect(context.clients[0]!.callToolCalls).toEqual([{ name: "list_containers", arguments: { all: true } }]);

    const invocation = (await context.store.listMcpInvocations({ runId: "run-1" }))[0]!;
    expect(invocation).toMatchObject({
      executed: true,
      success: true,
      permissionLevel: 1,
      approvalStatus: "not-required",
      serverName: "docker",
      toolName: "list_containers",
      agent: "coding-agent",
      modelId: "muse-spark-1.3",
    });
    expect(invocation.correlationId).toMatch(/^cor_/);
    const audit = await context.store.listAudit("run-1");
    expect(audit.some((event) => event.action === "mcp.docker.list_containers" && event.evidence?.includes("correlation="))).toBe(true);
  });

  it("validates arguments against the discovered JSON schema before execution", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "list_containers");
    const tool = await toolFor(context, "run-invalid", "list_containers");
    const invalid = await context.mcp.executeToolCall({
      runId: "run-invalid",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { all: "yes" },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.summary).toMatch(/Invalid arguments/);
    expect(context.clients[0]!.callToolCalls).toHaveLength(0);
    const invocations = await context.store.listMcpInvocations({ runId: "run-invalid" });
    expect(invocations[0]).toMatchObject({ executed: false, success: false });
  });

  it("requires a human run grant before a Level 2 tool runs, then reuses it for the same run", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "create_container");
    const tool = await toolFor(context, "run-l2", "create_container");

    const pending = context.mcp.executeToolCall({
      runId: "run-l2",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { image: "alpine" },
    });
    const approval = await pendingApproval(context.store, "run-l2");
    expect(approval).toMatchObject({ kind: "run-grant", permissionLevel: 2, status: "pending" });
    expect(approval.argumentsRedacted).toEqual({ image: "alpine" });
    await context.mcp.decideApproval("run-l2", approval.id, "approve");
    const first = await pending;
    expect(first.isError).toBe(false);
    expect(context.clients[0]!.callToolCalls).toHaveLength(1);

    const grants = await context.store.listMcpRunGrants("run-l2");
    expect(grants).toHaveLength(1);

    const second = await context.mcp.executeToolCall({
      runId: "run-l2",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { image: "alpine" },
    });
    expect(second.isError).toBe(false);
    expect(context.clients[0]!.callToolCalls).toHaveLength(2);
    expect(await context.store.listMcpApprovals({ runId: "run-l2" })).toHaveLength(1);
  });

  it("never executes a denied Level 2 call and records the denial", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "create_container");
    const tool = await toolFor(context, "run-l2-deny", "create_container");
    const pending = context.mcp.executeToolCall({
      runId: "run-l2-deny",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { image: "alpine" },
    });
    const approval = await pendingApproval(context.store, "run-l2-deny");
    await context.mcp.decideApproval("run-l2-deny", approval.id, "deny");
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/denied/);
    expect(context.clients[0]!.callToolCalls).toHaveLength(0);
    const invocation = (await context.store.listMcpInvocations({ runId: "run-l2-deny" }))[0]!;
    expect(invocation).toMatchObject({ executed: false, success: false, approvalStatus: "denied", approvalId: approval.id });
  });

  it("requires a fresh per-call approval for every Level 3 invocation", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "remove_container");
    const tool = await toolFor(context, "run-l3", "remove_container");

    const first = context.mcp.executeToolCall({
      runId: "run-l3",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { container: "abc" },
    });
    const firstApproval = await pendingApproval(context.store, "run-l3");
    expect(firstApproval).toMatchObject({ kind: "per-call", permissionLevel: 3 });
    await context.mcp.decideApproval("run-l3", firstApproval.id, "approve");
    expect((await first).isError).toBe(false);
    expect(context.clients[0]!.callToolCalls).toHaveLength(1);

    const second = context.mcp.executeToolCall({
      runId: "run-l3",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { container: "abc" },
    });
    const secondApproval = await pendingApproval(context.store, "run-l3");
    expect(secondApproval.id).not.toBe(firstApproval.id);
    await context.mcp.decideApproval("run-l3", secondApproval.id, "deny");
    expect((await second).isError).toBe(true);
    expect(context.clients[0]!.callToolCalls).toHaveLength(1);
  });

  it("ignores a caller-claimed Level 1 on a destructive tool and still requires per-call approval", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "remove_container");
    const tool = await toolFor(context, "run-forged", "remove_container");
    expect(tool.permissionLevel).toBe(3);

    const pending = context.mcp.executeToolCall({
      runId: "run-forged",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool: { ...tool, permissionLevel: 1 },
      arguments: { container: "abc" },
    });
    const approval = await pendingApproval(context.store, "run-forged");
    expect(approval).toMatchObject({ kind: "per-call", permissionLevel: 3 });
    expect(context.clients[0]!.callToolCalls).toHaveLength(0);

    await context.mcp.decideApproval("run-forged", approval.id, "deny");
    expect((await pending).isError).toBe(true);
    const invocation = (await context.store.listMcpInvocations({ runId: "run-forged" }))[0]!;
    expect(invocation).toMatchObject({ permissionLevel: 3, executed: false, approvalStatus: "denied" });
  });

  it("keeps a policy-covered tool at its floor even when a stored permission record lowers it", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "remove_container");
    await expect(enableTool(context, "remove_container", { reviewedLevel: 1 })).rejects.toMatchObject({ code: "level_too_low" });
    await expect(context.mcp.updatePermission({ serverName: "docker", toolName: "remove_container", enabled: true, reviewedLevel: 2 })).rejects.toMatchObject({
      code: "level_too_low",
    });
    expect((await toolFor(context, "run-floor", "remove_container")).permissionLevel).toBe(3);
  });

  it("applies the trusted classification over a lower caller label for a tool outside the policy", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "frobnicate_everything", { reviewedLevel: 2 });
    const tool = await toolFor(context, "run-unlisted", "frobnicate_everything");
    expect(tool.permissionLevel).toBe(2);

    const pending = context.mcp.executeToolCall({
      runId: "run-unlisted",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool: { ...tool, permissionLevel: 1 },
      arguments: {},
    });
    const approval = await pendingApproval(context.store, "run-unlisted");
    expect(approval).toMatchObject({ kind: "run-grant", permissionLevel: 2 });
    expect(context.clients[0]!.callToolCalls).toHaveLength(0);
    await context.mcp.decideApproval("run-unlisted", approval.id, "approve");
    expect((await pending).isError).toBe(false);
    expect((await context.store.listMcpInvocations({ runId: "run-unlisted" }))[0]).toMatchObject({ permissionLevel: 2 });
  });

  it("ignores an inflated caller label on a read-only tool instead of blocking it", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "list_containers");
    const tool = await toolFor(context, "run-inflated", "list_containers");
    const result = await context.mcp.executeToolCall({
      runId: "run-inflated",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool: { ...tool, permissionLevel: 3 },
      arguments: { all: true },
    });
    expect(result.isError).toBe(false);
    expect(await context.store.listMcpApprovals({ runId: "run-inflated" })).toHaveLength(0);
    expect((await context.store.listMcpInvocations({ runId: "run-inflated" }))[0]).toMatchObject({
      permissionLevel: 1,
      approvalStatus: "not-required",
      executed: true,
    });
  });

  it("expires an unanswered approval without executing the call", async () => {
    const context = await setup({ approvalTimeoutMs: 50 });
    await connect(context);
    await enableTool(context, "remove_container");
    const tool = await toolFor(context, "run-expire", "remove_container");
    const result = await context.mcp.executeToolCall({
      runId: "run-expire",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { container: "abc" },
    });
    expect(result.isError).toBe(true);
    expect(result.summary).toMatch(/expired/);
    expect(context.clients[0]!.callToolCalls).toHaveLength(0);
    const approval = (await context.store.listMcpApprovals({ runId: "run-expire" }))[0]!;
    expect(approval.status).toBe("expired");
  });

  it("cancels pending approvals and blocks the call when the run is cancelled", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "remove_container");
    const tool = await toolFor(context, "run-cancel", "remove_container");
    const pending = context.mcp.executeToolCall({
      runId: "run-cancel",
      repositoryId: null,
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { container: "abc" },
      signal: context.mcp.signalForRun("run-cancel"),
    });
    await pendingApproval(context.store, "run-cancel");
    await context.mcp.cancelRun("run-cancel");
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(context.clients[0]!.callToolCalls).toHaveLength(0);
    const approval = (await context.store.listMcpApprovals({ runId: "run-cancel" }))[0]!;
    expect(approval.status).toBe("cancelled");
  });

  it("counts only executed calls against the per-run budget", async () => {
    const context = await setup({ maxToolCallsPerRun: 1 });
    await connect(context);
    await enableTool(context, "list_containers");
    const tool = await toolFor(context, "run-budget", "list_containers");
    const base = { runId: "run-budget", repositoryId: null, agent: "coding-agent" as const, modelId: "muse", tool };

    expect((await context.mcp.executeToolCall({ ...base, arguments: { all: "invalid" } })).isError).toBe(true);
    expect((await context.mcp.executeToolCall({ ...base, arguments: {} })).isError).toBe(false);
    const third = await context.mcp.executeToolCall({ ...base, arguments: { all: true } });
    expect(third.isError).toBe(true);
    expect(third.summary).toMatch(/Maximum MCP tool calls per run/);
    expect(context.clients[0]!.callToolCalls).toHaveLength(1);
  });

  it("redacts secrets from arguments, results, audits, and persisted invocations", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "inspect_container");
    const tool = await toolFor(context, "run-redact", "inspect_container");
    context.clients[0]!.result = {
      content: [{ type: "text", text: "container abc is running. token=ghp_abcdefghijklmnopqrstuvwxyz" }],
    };
    const result = await context.mcp.executeToolCall({
      runId: "run-redact",
      repositoryId: "repo-redact",
      agent: "coding-agent",
      modelId: "muse",
      tool,
      arguments: { id: "abc", authorization: "Bearer abcdefghijklmnop" },
    });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    const invocation = (await context.store.listMcpInvocations({ runId: "run-redact" }))[0]!;
    expect(invocation.argumentsRedacted).toMatchObject({ id: "abc", authorization: "[REDACTED]" });
    expect(invocation.resultSummary).not.toContain("ghp_");
    const audit = await context.store.listAudit("run-redact");
    expect(JSON.stringify(audit)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects a tool that is not enabled for the current agent/run scope", async () => {
    const context = await setup();
    await connect(context);
    await enableTool(context, "create_container");
    const tool = await toolFor(context, "run-scope", "create_container");
    const denied = await context.mcp.executeToolCall({
      runId: "run-scope",
      repositoryId: null,
      agent: "verification-agent",
      modelId: "muse",
      tool: { ...tool, permissionLevel: 1 },
      arguments: { image: "alpine" },
    });
    expect(denied.isError).toBe(true);
    expect(context.clients[0]!.callToolCalls).toHaveLength(0);
  });

  it("produces stable, sanitized model function names per server/tool", () => {
    const first = modelToolName("docker", "remove_container");
    expect(first).toBe(modelToolName("docker", "remove_container"));
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(first).not.toBe(modelToolName("docker", "remove-image"));
    expect(modelToolName("server with spaces/tools", "do.thing")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(modelToolName("x".repeat(100), "y".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});
