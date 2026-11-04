import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, EmptyState, Input, SectionLabel, Skeleton, StatusPill } from "../components/ui";
import {
  api,
  type GitHubStatus,
  type McpAgentRole,
  type McpApproval,
  type McpConnectorView,
  type McpInvocation,
  type McpPermissionLevel,
  type McpRisk,
  type McpServerView,
  type McpToolView,
} from "../lib/api";

type Tab = "server" | "tools" | "activity";
type Tone = "success" | "danger" | "warning" | "accent" | "neutral";

const STATE: Record<McpConnectorView["state"], { label: string; tone: Tone }> = {
  "not-configured": { label: "No profile selected", tone: "warning" },
  "not-detected": { label: "Docker not detected", tone: "danger" },
  "not-connected": { label: "Disconnected", tone: "neutral" },
  connecting: { label: "Connecting", tone: "accent" },
  connected: { label: "Connected", tone: "success" },
  disabled: { label: "Disabled", tone: "neutral" },
  "authentication-required": { label: "Authentication required", tone: "warning" },
  "connection-error": { label: "Connection error", tone: "danger" },
};

const RISK_TONE: Record<McpRisk, Tone> = { low: "success", medium: "warning", high: "danger" };
const LEVEL_LABEL: Record<McpPermissionLevel, string> = { 1: "L1 · Read-only", 2: "L2 · Run-scoped", 3: "L3 · Host-wide" };
const AGENT_LABEL: Record<McpAgentRole, string> = { "coding-agent": "Coding", "verification-agent": "Verification" };

function fmtTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "border-[#5E6AD2] bg-[#5E6AD2]" : "border-[#3A3D46] bg-[#282A31]"
      }`}
    >
      <span className={`h-3 w-3 rounded-full bg-white transition-transform ${checked ? "translate-x-3.5" : "translate-x-0.5"}`} aria-hidden />
    </button>
  );
}

function AgentChecks({ value, disabled, onChange }: { value: McpAgentRole[]; disabled?: boolean; onChange: (next: McpAgentRole[]) => void }) {
  return (
    <span className="inline-flex items-center gap-2">
      {(["coding-agent", "verification-agent"] as const).map((role) => (
        <label key={role} className="inline-flex items-center gap-1 text-[11px] text-[#8A8F98]">
          <input
            type="checkbox"
            className="h-3 w-3 accent-[#5E6AD2]"
            checked={value.includes(role)}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.checked ? [...new Set([...value, role])] : value.filter((r) => r !== role);
              if (next.length > 0) onChange(next);
            }}
          />
          {AGENT_LABEL[role]}
        </label>
      ))}
    </span>
  );
}

function Card({ title, icon, actions, children }: { title?: string; icon?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[#26282E] bg-[#1A1B20] shadow-sm">
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] px-3 py-2.5">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-[#ECEEF0]">
            {icon && <Icon name={icon} size={15} className="text-[#5E626E]" />}
            {title}
          </h2>
          {actions}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Connectors() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("server");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [levels, setLevels] = useState<Record<string, McpPermissionLevel>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const connector = useQuery({
    queryKey: ["mcp-status"],
    queryFn: () => api<McpConnectorView>("/mcp/status"),
    refetchInterval: 5_000,
  });
  const github = useQuery({
    queryKey: ["github-status"],
    queryFn: () => api<GitHubStatus>("/integrations/github/status"),
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async ({ path, method = "POST", body }: { path: string; method?: string; body?: unknown }) =>
      api<unknown>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const view = connector.data;
  const busy = mutation.isPending;
  const run = (path: string, body?: unknown) => {
    setNotice(null);
    mutation.mutate({ path, body });
  };

  const q = search.trim().toLowerCase();
  const filteredTools = useMemo(() => {
    const tools = view?.tools ?? [];
    if (!q) return tools;
    return tools.filter((t) => `${t.serverName} ${t.name} ${t.description}`.toLowerCase().includes(q));
  }, [view?.tools, q]);
  const filteredServers = useMemo(() => {
    const servers = view?.servers ?? [];
    if (!q) return servers;
    return servers.filter((s) => s.name.toLowerCase().includes(q) || (view?.tools ?? []).some((t) => t.serverName === s.name && `${t.name} ${t.description}`.toLowerCase().includes(q)));
  }, [view?.servers, view?.tools, q]);

  if (!view) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-[92px] w-full" />
        <Skeleton className="h-[320px] w-full" />
      </div>
    );
  }

  const state = STATE[view.state];
  const detection = view.detection;
  const connected = view.state === "connected";

  function updateTool(tool: McpToolView, enabled: boolean) {
    const key = `${tool.serverName}/${tool.name}`;
    const reviewedLevel = tool.reviewedLevel ?? (tool.reviewed ? undefined : levels[key] ?? 3);
    run("/mcp/permissions", {
      serverName: tool.serverName,
      toolName: tool.name,
      enabled,
      allowedAgents: tool.allowedAgents,
      ...(reviewedLevel ? { reviewedLevel } : {}),
    });
    if (enabled && !tool.reviewed && !tool.reviewedLevel) {
      setNotice(`Review recorded for ${key} at Level ${levels[key] ?? 3}. The tool still needs every permission check at call time.`);
    }
  }

  function updateToolAgents(tool: McpToolView, allowedAgents: McpAgentRole[]) {
    run("/mcp/permissions", { serverName: tool.serverName, toolName: tool.name, enabled: tool.enabled, allowedAgents, ...(tool.reviewedLevel ? { reviewedLevel: tool.reviewedLevel } : {}) });
  }

  function updateServer(server: McpServerView, enabled: boolean) {
    run("/mcp/permissions", { serverName: server.name, enabled, allowedAgents: server.allowedAgents });
  }

  function updateServerAgents(server: McpServerView, allowedAgents: McpAgentRole[]) {
    run("/mcp/permissions", { serverName: server.name, enabled: server.enabled, allowedAgents });
  }

  function decide(approval: McpApproval, decision: "approve" | "deny") {
    run(`/runs/${encodeURIComponent(approval.runId)}/mcp/approvals/${encodeURIComponent(approval.id)}`, { decision });
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1 border-b border-[#26282E] pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-[#ECEEF0]">Connectors</h1>
          <StatusPill tone={state.tone}>
            {state.label}
            {view.enabled ? "" : " · DNAFix off"}
          </StatusPill>
        </div>
        <p className="max-w-3xl text-[13px] leading-[18px] text-[#8A8F98]">
          Human-controlled access to external tools. GitHub App authentication is separate from MCP; connecting Docker Desktop MCP never changes your GitHub session.
        </p>
      </header>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-[#E5484D]/30 bg-[#E5484D]/10 px-3 py-2 text-[12px] leading-4 text-[#E5484D]">
          <Icon name="warning" size={15} className="mt-0.5" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="text-[#E5484D] hover:text-white">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-[#5E6AD2]/30 bg-[#5E6AD2]/10 px-3 py-2 text-[12px] leading-4 text-[#BDC2FF]">
          <Icon name="info" size={15} className="mt-0.5" />
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice" className="hover:text-white">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-8">
          {/* Integrations */}
          <Card title="Integrations" icon="source_environment">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[#26282E] bg-[#141518] p-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-md border border-[#2E3038] bg-[#222329]">
                  <Icon name="code" size={16} className="text-[#8A8F98]" />
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[#ECEEF0]">GitHub App</p>
                  <p className="mt-0.5 text-[12px] leading-4 text-[#8A8F98]">
                    {github.isError
                      ? "Status unavailable — the API could not be reached."
                      : github.data
                        ? github.data.configured
                          ? github.data.connected
                            ? `Connected as ${github.data.account?.login ?? "unknown"}. Used only for repository import and draft pull requests.`
                            : "App configured, no account connected yet. Used only for repository import and draft pull requests."
                          : "Not configured on the API host. Analyses run with local repositories; no draft PR is created."
                        : "Checking GitHub App configuration…"}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={github.data?.connected ? "success" : github.data?.configured ? "warning" : "neutral"}>
                  {github.data?.connected ? "Account connected" : github.data?.configured ? "Not connected" : "Not configured"}
                </StatusPill>
                {github.data?.configured && !github.data.connected && (
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        const res = await api<{ authorizeUrl: string }>("/integrations/github/connect", {
                          method: "POST",
                          body: JSON.stringify({ returnTo: "/connectors" }),
                        });
                        window.location.assign(res.authorizeUrl);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    Connect GitHub
                  </Button>
                )}
                <Link to="/settings#github" className="text-[12px] text-[#BDC2FF] hover:text-white hover:underline">
                  Details
                </Link>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-[#5E626E]">
              GitHub permissions are granted by the GitHub App installation. MCP permissions below are a separate grant and cannot be used to access GitHub.
            </p>
          </Card>

          {/* MCP connection */}
          <Card
            title="MCP Connection · Docker Desktop"
            icon="hub"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-[#8A8F98]">Enabled for DNAFix</span>
                <Switch
                  checked={view.enabled}
                  disabled={busy}
                  label="Enable Docker MCP connector for DNAFix"
                  onChange={(enabled) => run("/mcp/enable", { enabled })}
                />
              </div>
            }
          >
            <div className={`rounded-lg border p-3 ${connected ? "border-[#27A567]/25 bg-[#27A567]/5" : "border-[#2E3038] bg-[#141518]"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={state.tone}>{state.label}</StatusPill>
                    {connected && <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-[#34D399]">Live gateway</span>}
                    {view.lastHandshakeAt && <span className="font-mono text-[10px] text-[#5E626E]">handshake {fmtTime(view.lastHandshakeAt)}</span>}
                  </div>
                  <p className="mt-1.5 text-[12px] leading-4 text-[#8A8F98]">{view.reason}</p>
                  {view.nextAction && <p className="mt-1 text-[12px] leading-4 text-[#E5A158]">{view.nextAction}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {connected ? (
                    <>
                      <Button variant="secondary" loading={busy} onClick={() => run("/mcp/refresh")}>
                        <Icon name="refresh" size={14} /> Refresh inventory
                      </Button>
                      <Button variant="danger-ghost" loading={busy} onClick={() => run("/mcp/disconnect")}>
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="primary"
                      loading={busy || view.state === "connecting"}
                      disabled={!view.enabled || !view.profileId || detection.desktop.running === false || !detection.cli.available}
                      onClick={() => run("/mcp/connect", view.profileId ? { profileId: view.profileId } : {})}
                    >
                      <Icon name="play_arrow" size={14} /> Connect
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-[#26282E]/70 pt-3">
                <label className="min-w-[220px] flex-1">
                  <span className="mb-1 block text-[11px] uppercase tracking-[0.03em] text-[#5E626E]">Docker MCP profile</span>
                  <select
                    className="h-8 w-full rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[13px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none disabled:opacity-50"
                    value={view.profileId ?? ""}
                    disabled={busy || !view.enabled}
                    onChange={(e) => run("/mcp/profile", { profileId: e.target.value })}
                  >
                    <option value="">{view.profiles === null ? "Profiles unavailable" : view.profiles.length === 0 ? "No profiles in Docker Desktop" : "Select a profile…"}</option>
                    {(view.profiles ?? []).map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} ({profile.id}){profile.serverNames.length > 0 ? ` · ${profile.serverNames.length} servers` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2 pb-1">
                  <Button variant="secondary" loading={busy} onClick={() => run("/mcp/detect")}>
                    <Icon name="refresh" size={14} /> Re-check Docker
                  </Button>
                </div>
              </div>
              {view.selectedProfile && (
                <p className="mt-2 font-mono text-[11px] text-[#5E626E]">
                  profile {view.selectedProfile.id} · {view.selectedProfile.serverNames.length > 0 ? view.selectedProfile.serverNames.join(", ") : "server list not reported by profile inspection"}
                </p>
              )}
              {view.lastError && view.state !== "connected" && (
                <p className="mt-2 rounded border border-[#E5484D]/20 bg-[#E5484D]/10 px-2 py-1 text-[11px] leading-4 text-[#E5484D]">Last error: {view.lastError}</p>
              )}
            </div>

            {/* Tabs */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E]">
              <div className="flex items-center gap-1" role="tablist" aria-label="MCP detail">
                {(
                  [
                    ["server", "Server", "dns", view.serverCount],
                    ["tools", "Tools", "extension", view.toolCount],
                    ["activity", "Activity", "history", view.activity.length],
                  ] as const
                ).map(([key, label, icon, count]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => setTab(key)}
                    className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] transition-colors ${
                      tab === key ? "border-[#5E6AD2] font-medium text-[#ECEEF0]" : "border-transparent text-[#8A8F98] hover:text-[#ECEEF0]"
                    }`}
                  >
                    <Icon name={icon} size={14} />
                    {label}
                    <span className="rounded bg-[#222329] px-1 font-mono text-[10px] text-[#8A8F98]">{count}</span>
                  </button>
                ))}
              </div>
              {tab !== "activity" && (
                <label className="relative my-1.5 block w-full sm:w-[240px]">
                  <Icon name="search" size={14} className="pointer-events-none absolute left-2 top-2 text-[#5E626E]" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search servers and tools…"
                    aria-label="Search MCP inventory"
                    className="pl-7"
                  />
                </label>
              )}
            </div>

            <div className="pt-3">
              {tab === "server" && (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] leading-4 text-[#5E626E]">
                    Live gateway inventory — only servers reported by Docker MCP Gateway are listed. DNAFix never injects mock servers, tools, or tool counts.
                  </p>
                  {filteredServers.length === 0 ? (
                    <EmptyState
                      title={view.tools.length === 0 ? "No server inventory yet" : "No matching servers"}
                      description={
                        view.tools.length === 0
                          ? "Connect a Docker MCP profile to discover the servers it actually exposes. Nothing is shown until the handshake and discovery succeed."
                          : "Adjust the search to see the discovered servers."
                      }
                    />
                  ) : (
                    filteredServers.map((server) => {
                      const serverTools = view.tools.filter((t) => t.serverName === server.name);
                      return (
                        <div key={server.name} className="rounded-lg border border-[#26282E] bg-[#141518] p-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <Icon name="dns" size={15} className="text-[#8A8F98]" />
                              <span className="truncate text-[13px] font-medium text-[#ECEEF0]">{server.name}</span>
                              <StatusPill tone={server.health === "reachable" ? "success" : "warning"}>
                                {server.health === "reachable" ? "Reachable" : server.health === "not-connected" ? "Disconnected" : "No tools"}
                              </StatusPill>
                              <span className="font-mono text-[10px] text-[#5E626E]">{server.toolCount} tools</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                              <AgentChecks value={server.allowedAgents} disabled={busy} onChange={(agents) => updateServerAgents(server, agents)} />
                              <Switch checked={server.enabled} disabled={busy} label={`Enable server ${server.name}`} onChange={(enabled) => updateServer(server, enabled)} />
                            </div>
                          </div>
                          {!server.enabled && <p className="mt-1 text-[11px] text-[#E5A158]">Server disabled: none of its tools are offered to agents.</p>}
                          {serverTools.length > 0 && (
                            <ul className="mt-2 divide-y divide-[#26282E]/60 border-t border-[#26282E]/60">
                              {serverTools.map((tool) => (
                                <li key={tool.name} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                                  <div className="min-w-0">
                                    <span className="font-mono text-[12px] text-[#ECEEF0]">{tool.name}</span>
                                    <span className="ml-2 text-[11px] text-[#5E626E]">{tool.reviewed ? "Reviewed policy" : "Needs human review"}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <StatusPill tone={RISK_TONE[tool.risk]}>{LEVEL_LABEL[tool.permissionLevel]}</StatusPill>
                                    <Switch checked={tool.enabled} disabled={busy || !server.enabled} label={`Enable tool ${tool.name}`} onChange={(enabled) => updateTool(tool, enabled)} />
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {tab === "tools" && (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] leading-4 text-[#5E626E]">
                    Unknown or unreviewed tools default to Level 3 and stay disabled until a human reviews them. Disabled tools are never sent to the model.
                  </p>
                  {filteredTools.length === 0 ? (
                    <EmptyState
                      title={view.tools.length === 0 ? "No tools discovered" : "No matching tools"}
                      description={view.tools.length === 0 ? "Tools appear only after a successful MCP handshake and tools/list response." : "Adjust the search to see discovered tools."}
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[760px] border-collapse text-left">
                        <thead>
                          <tr className="border-b border-[#26282E] font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">
                            <th className="py-1.5 pr-2 font-medium">Tool</th>
                            <th className="py-1.5 pr-2 font-medium">Server</th>
                            <th className="py-1.5 pr-2 font-medium">Permission</th>
                            <th className="py-1.5 pr-2 font-medium">Agents</th>
                            <th className="py-1.5 pr-2 font-medium">Enabled</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredTools.map((tool) => {
                            const key = `${tool.serverName}/${tool.name}`;
                            const level = levels[key] ?? 3;
                            return (
                              <tr key={key} className="border-b border-[#26282E]/60 align-top last:border-0">
                                <td className="max-w-[300px] py-2 pr-2">
                                  <button
                                    type="button"
                                    onClick={() => setExpanded(expanded === key ? null : key)}
                                    className="flex items-start gap-1 text-left font-mono text-[12px] text-[#ECEEF0] hover:text-white"
                                    aria-expanded={expanded === key}
                                  >
                                    <Icon name={expanded === key ? "expand_less" : "expand_more"} size={13} className="mt-0.5 text-[#5E626E]" />
                                    {tool.name}
                                  </button>
                                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[#8A8F98]">{tool.description || "No description supplied by the server."}</p>
                                  {!tool.schemaValid && <p className="mt-0.5 text-[11px] text-[#E5484D]">Invalid input schema — this tool cannot run.</p>}
                                  {expanded === key && (
                                    <div className="mt-1.5 rounded border border-[#2E3038] bg-[#0F1013] p-2">
                                      <p className="font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Parameters</p>
                                      {tool.parameterSummary.length === 0 ? (
                                        <p className="mt-1 text-[11px] text-[#8A8F98]">No declared parameters.</p>
                                      ) : (
                                        <ul className="mt-1 space-y-0.5">
                                          {tool.parameterSummary.map((param) => (
                                            <li key={param.name} className="text-[11px] leading-4 text-[#8A8F98]">
                                              <span className="font-mono text-[#ECEEF0]">{param.name}</span>
                                              <span className="text-[#5E626E]">: {param.type}{param.required ? " (required)" : ""}</span>
                                              {param.description ? <span> — {param.description}</span> : null}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                      <p className="mt-1 truncate font-mono text-[10px] text-[#5E626E]" title={tool.modelName}>model name: {tool.modelName}</p>
                                    </div>
                                  )}
                                </td>
                                <td className="py-2 pr-2 font-mono text-[11px] text-[#8A8F98]">{tool.serverName}</td>
                                <td className="py-2 pr-2">
                                  <div className="flex flex-col gap-1">
                                    <StatusPill tone={RISK_TONE[tool.risk]}>{LEVEL_LABEL[tool.permissionLevel]}</StatusPill>
                                    {!tool.reviewed && (
                                      <select
                                        aria-label={`Review level for ${key}`}
                                        className="h-7 rounded border border-[#E5A158]/40 bg-[#141518] px-1 text-[11px] text-[#E5A158] focus:outline-none"
                                        value={level}
                                        onChange={(e) => setLevels((prev) => ({ ...prev, [key]: Number(e.target.value) as McpPermissionLevel }))}
                                      >
                                        <option value={1}>Review as L1</option>
                                        <option value={2}>Review as L2</option>
                                        <option value={3}>Review as L3</option>
                                      </select>
                                    )}
                                    <span className="text-[10px] text-[#5E626E]">{tool.reviewed ? "Explicit reviewed policy" : "Not covered by policy"}</span>
                                  </div>
                                </td>
                                <td className="py-2 pr-2">
                                  <AgentChecks value={tool.allowedAgents} disabled={busy} onChange={(agents) => updateToolAgents(tool, agents)} />
                                </td>
                                <td className="py-2 pr-2">
                                  <Switch checked={tool.enabled} disabled={busy} label={`Enable tool ${key}`} onChange={(enabled) => updateTool(tool, enabled)} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {(view.resources.length > 0 || view.prompts.length > 0) && (
                    <p className="mt-1 text-[11px] text-[#5E626E]">
                      Discovery also reported {view.resources.length} resource(s) and {view.prompts.length} prompt(s). DNAFix currently exposes tools only.
                    </p>
                  )}
                </div>
              )}

              {tab === "activity" && (
                <div className="flex flex-col gap-3">
                  <ActivityApprovals approvals={view.approvals} busy={busy} onDecide={decide} />
                  <div>
                    <SectionLabel index="01">Recent MCP Activity</SectionLabel>
                    {view.activity.length === 0 ? (
                      <div className="mt-2">
                        <EmptyState title="No MCP tool calls yet" description="Every attempted call is recorded with its run, agent, permission level, approval and outcome — including rejected calls." />
                      </div>
                    ) : (
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full min-w-[700px] border-collapse text-left">
                          <thead>
                            <tr className="border-b border-[#26282E] font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">
                              <th className="py-1.5 pr-2 font-medium">Tool</th>
                              <th className="py-1.5 pr-2 font-medium">Agent</th>
                              <th className="py-1.5 pr-2 font-medium">Approval</th>
                              <th className="py-1.5 pr-2 font-medium">Result</th>
                              <th className="py-1.5 pr-2 font-medium">Run</th>
                              <th className="py-1.5 pr-2 font-medium">When</th>
                            </tr>
                          </thead>
                          <tbody>
                            {view.activity.map((call) => (
                              <ActivityRow key={call.id} call={call} />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Sidebar */}
        <aside className="flex flex-col gap-3 xl:col-span-4">
          <Card title="Host Detection" icon="computer">
            <dl className="space-y-1.5 text-[12px] leading-4">
              <Row label="Host" value={`${detection.hostLabel} · ${detection.supportedHost ? "supported" : "unsupported"}`} />
              <Row label="Docker CLI" value={detection.cli.available ? detection.cli.version ?? "available" : detection.cli.error ?? "not found"} bad={!detection.cli.available} />
              <Row label="Docker Desktop" value={detection.desktop.running === true ? "running" : detection.desktop.running === false ? "not running" : "unknown"} bad={detection.desktop.running === false} />
              <Row label="Desktop plugin" value={detection.desktop.pluginAvailable ? detection.desktop.pluginVersion ?? "available" : "unavailable"} bad={!detection.desktop.pluginAvailable} />
              <Row label="MCP Toolkit" value={detection.toolkit.available ? detection.toolkit.version ?? "available" : "unavailable"} bad={!detection.toolkit.available} />
              <Row
                label="Toolkit enabled"
                value={detection.toolkit.enabled === null ? "unverified" : detection.toolkit.enabled ? "yes" : "no"}
                bad={detection.toolkit.enabled === false}
              />
              <Row label="Gateway CLI" value={detection.toolkit.gatewayAvailable ? "available" : "unavailable"} bad={!detection.toolkit.gatewayAvailable} />
            </dl>
            <p className="mt-2 text-[11px] leading-4 text-[#8A8F98]">{detection.summary}</p>
            {detection.nextAction && <p className="mt-1 text-[11px] leading-4 text-[#E5A158]">{detection.nextAction}</p>}
            <div className="mt-2 flex items-center justify-between border-t border-[#26282E]/60 pt-2">
              <span className="font-mono text-[10px] text-[#5E626E]">checked {fmtTime(detection.checkedAt)}</span>
              <Button variant="secondary" loading={busy} onClick={() => run("/mcp/detect")}>
                <Icon name="refresh" size={13} /> Re-check
              </Button>
            </div>
          </Card>

          <Card title="Connection Boundary" icon="shield">
            <ul className="space-y-1.5 text-[12px] leading-4 text-[#8A8F98]">
              <li className="flex gap-1.5"><Icon name="check_circle" size={13} className="mt-0.5 text-[#34D399]" />DNAFix reads Docker MCP profiles and connects; it never creates profiles or installs servers.</li>
              <li className="flex gap-1.5"><Icon name="check_circle" size={13} className="mt-0.5 text-[#34D399]" />Only <span className="font-mono text-[#ECEEF0]">docker mcp gateway run --profile …</span> is spawned, with no shell and no inherited DNAFix secrets.</li>
              <li className="flex gap-1.5"><Icon name="check_circle" size={13} className="mt-0.5 text-[#34D399]" />Connected is shown only after a real MCP initialize handshake succeeds.</li>
              <li className="flex gap-1.5"><Icon name="warning" size={13} className="mt-0.5 text-[#E5A158]" />Docker Desktop and the MCP Toolkit stay user-controlled. DNAFix never starts Docker or enables beta features.</li>
              <li className="flex gap-1.5"><Icon name="lock" size={13} className="mt-0.5 text-[#5E626E]" />MCP is separate from the build sandbox. Tool access cannot widen the coding task's file scope.</li>
            </ul>
          </Card>

          <Card title="Permission Model" icon="key">
            <ul className="space-y-2 text-[12px] leading-4 text-[#8A8F98]">
              <li><StatusPill tone="success">Level 1</StatusPill><span className="ml-2">Read-only. The verification agent only ever receives Level 1 tools.</span></li>
              <li><StatusPill tone="warning">Level 2</StatusPill><span className="ml-2">Workspace/run-scoped. First use needs a run grant approved by a human.</span></li>
              <li><StatusPill tone="danger">Level 3</StatusPill><span className="ml-2">Destructive or host-wide. Every single call needs its own approval tied to the exact invocation.</span></li>
            </ul>
            <p className="mt-2 text-[11px] leading-4 text-[#5E626E]">Denied calls never execute. Tool output is treated as untrusted data and cannot change these policies.</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[#26282E]/50 pb-1.5 last:border-0">
      <dt className="shrink-0 text-[#5E626E]">{label}</dt>
      <dd className={`min-w-0 break-words text-right font-mono ${bad ? "text-[#E5484D]" : "text-[#ECEEF0]"}`}>{value}</dd>
    </div>
  );
}

function ActivityApprovals({ approvals, busy, onDecide }: { approvals: McpApproval[]; busy: boolean; onDecide: (approval: McpApproval, decision: "approve" | "deny") => void }) {
  const pending = approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) return null;
  return (
    <div className="rounded-lg border border-[#E5A158]/30 bg-[#E5A158]/5 p-2.5">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-[#E5A158]">
        <Icon name="pan_tool" size={14} /> {pending.length} pending approval{pending.length === 1 ? "" : "s"}
      </p>
      <ul className="mt-2 space-y-2">
        {pending.map((approval) => (
          <li key={approval.id} className="rounded border border-[#2E3038] bg-[#141518] p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-[#ECEEF0]">
                {approval.serverName}/{approval.toolName}
              </span>
              <span className="flex items-center gap-1.5">
                <StatusPill tone={approval.kind === "per-call" ? "danger" : "warning"}>{approval.kind === "per-call" ? "Per-call · L3" : "Run grant · L2"}</StatusPill>
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-[#8A8F98]">{approval.summary}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-[#E5A158]">{approval.consequences}</p>
            <details className="mt-1">
              <summary className="cursor-pointer font-mono text-[10px] text-[#5E626E]">redacted arguments</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-[#2E3038] bg-[#0F1013] p-1.5 font-mono text-[10px] text-[#8A8F98]">
                {JSON.stringify(approval.argumentsRedacted, null, 2)}
              </pre>
            </details>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <Link to={`/runs/${approval.runId}`} className="font-mono text-[10px] text-[#BDC2FF] hover:underline">
                run {approval.runId}
              </Link>
              <span className="flex items-center gap-1.5">
                <Button variant="danger-ghost" disabled={busy} onClick={() => onDecide(approval, "deny")}>Deny</Button>
                <Button variant="primary" disabled={busy} onClick={() => onDecide(approval, "approve")}>Approve once</Button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActivityRow({ call }: { call: McpInvocation }) {
  const approval = call.approvalStatus === "approved" ? "Approved" : call.approvalStatus === "pending" ? "Pending" : call.approvalStatus === "denied" ? "Denied" : call.approvalStatus === "not-required" ? "Not required" : call.approvalStatus;
  return (
    <tr className="border-b border-[#26282E]/60 align-top last:border-0">
      <td className="py-1.5 pr-2">
        <span className="font-mono text-[11px] text-[#ECEEF0]">{call.serverName}/{call.toolName}</span>
        <span className="ml-1.5 font-mono text-[10px] text-[#5E626E]">{LEVEL_LABEL[call.permissionLevel]}</span>
        {call.error && <p className="mt-0.5 max-w-[280px] break-words text-[10px] leading-4 text-[#E5484D]">{call.error}</p>}
        {!call.error && call.resultSummary && <p className="mt-0.5 max-w-[280px] truncate text-[10px] leading-4 text-[#5E626E]" title={call.resultSummary}>{call.resultSummary}</p>}
      </td>
      <td className="py-1.5 pr-2 text-[11px] text-[#8A8F98]">{AGENT_LABEL[call.agent]}</td>
      <td className="py-1.5 pr-2 font-mono text-[10px] text-[#8A8F98]">{approval}</td>
      <td className="py-1.5 pr-2">
        <StatusPill tone={call.success ? "success" : call.executed ? "danger" : "neutral"}>{call.success ? "Ran" : call.executed ? "Failed" : "Not run"}</StatusPill>
        {call.durationMs !== null && <span className="ml-1.5 font-mono text-[10px] text-[#5E626E]">{call.durationMs}ms</span>}
      </td>
      <td className="py-1.5 pr-2">
        {call.runId ? (
          <Link to={`/runs/${call.runId}`} className="font-mono text-[10px] text-[#BDC2FF] hover:underline">{call.runId}</Link>
        ) : (
          <span className="font-mono text-[10px] text-[#5E626E]">—</span>
        )}
      </td>
      <td className="py-1.5 pr-2 font-mono text-[10px] text-[#5E626E]">{fmtTime(call.startedAt)}</td>
    </tr>
  );
}
