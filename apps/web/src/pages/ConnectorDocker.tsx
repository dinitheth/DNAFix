import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, StatusPill } from "../components/ui";
import { api, type McpAgentRole, type McpConnectorView, type McpPermissionLevel, type McpServerView, type McpToolView } from "../lib/api";

const LEVEL: Record<McpPermissionLevel, { label: string; tone: "success" | "warning" | "danger" }> = {
  1: { label: "L1 Read-only", tone: "success" },
  2: { label: "L2 Run-scoped", tone: "warning" },
  3: { label: "L3 Host-wide", tone: "danger" },
};

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${checked ? "border-[#5E6AD2] bg-[#5E6AD2]" : "border-[#3A3D46] bg-[#282A31]"}`}>
      <span className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} aria-hidden />
    </button>
  );
}

export function ConnectorDocker() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<Record<string, McpPermissionLevel>>({});

  const connector = useQuery({ queryKey: ["mcp-status"], queryFn: () => api<McpConnectorView>("/mcp/status"), refetchInterval: 5_000 });
  const mutation = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) => api<unknown>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSuccess: async () => { setError(null); await queryClient.invalidateQueries({ queryKey: ["mcp-status"] }); },
    onError: (err: Error) => setError(err.message),
  });
  const view = connector.data;
  const busy = mutation.isPending;
  const run = (path: string, body?: unknown) => mutation.mutate({ path, body });
  const connected = view?.state === "connected";

  function updateTool(tool: McpToolView, enabled: boolean) {
    const key = `${tool.serverName}/${tool.name}`;
    const reviewedLevel = tool.reviewedLevel ?? (tool.reviewed ? undefined : levels[key] ?? 3);
    run("/mcp/permissions", { serverName: tool.serverName, toolName: tool.name, enabled, allowedAgents: tool.allowedAgents, ...(reviewedLevel ? { reviewedLevel } : {}) });
  }
  function updateAgents(tool: McpToolView, role: McpAgentRole, on: boolean) {
    const next = on ? [...new Set([...tool.allowedAgents, role])] : tool.allowedAgents.filter((r) => r !== role);
    if (next.length === 0) return;
    run("/mcp/permissions", { serverName: tool.serverName, toolName: tool.name, enabled: tool.enabled, allowedAgents: next, ...(tool.reviewedLevel ? { reviewedLevel: tool.reviewedLevel } : {}) });
  }
  function updateServer(server: McpServerView, enabled: boolean) {
    run("/mcp/permissions", { serverName: server.name, enabled, allowedAgents: server.allowedAgents });
  }

  const q = search.trim().toLowerCase();
  const tools = (view?.tools ?? []).filter((t) => !q || `${t.serverName} ${t.name} ${t.description}`.toLowerCase().includes(q));
  const pending = (view?.approvals ?? []).filter((a) => a.status === "pending");

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <Link to="/connectors" className="flex items-center gap-1 text-[12px] text-[#8A8F98] hover:text-white"><Icon name="arrow_back" size={14} /> Connectors</Link>
      <header className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#1D63ED] text-white"><Icon name="deployed_code" size={22} /></span>
          <div>
            <h1 className="text-[18px] font-semibold text-white">Docker MCP</h1>
            <p className="font-mono text-[11px] text-[#8A8F98]">{view ? view.state : "loading"}{view?.profileId ? ` · ${view.profileId}` : ""}</p>
          </div>
        </div>
        {view && <Toggle checked={view.enabled} disabled={busy} label="Enable Docker MCP" onChange={(enabled) => run("/mcp/enable", { enabled })} />}
      </header>

      {error && <div role="alert" className="mt-3 rounded-lg border border-[#E5484D]/30 bg-[#E5484D]/10 px-3 py-2 text-[12px] text-[#E5484D]">{error}</div>}
      {!view && <div className="mt-4 h-40 animate-pulse rounded-xl bg-[#1A1B20]" />}

      {view && (
        <>
          <section className="mt-4 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[12px] text-[#8A8F98]">
                Profile
                <select className="h-9 rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[13px] text-white focus:border-[#5E6AD2] focus:outline-none disabled:opacity-50" value={view.profileId ?? ""} disabled={busy || !view.enabled} onChange={(e) => run("/mcp/profile", { profileId: e.target.value })}>
                  <option value="">Select a profile…</option>
                  {(view.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                </select>
              </label>
              <Button variant="secondary" loading={busy} onClick={() => run("/mcp/detect")}><Icon name="refresh" size={14} /> Re-check</Button>
              {connected ? (
                <>
                  <Button variant="secondary" loading={busy} onClick={() => run("/mcp/refresh")}>Refresh tools</Button>
                  <Button variant="danger-ghost" loading={busy} onClick={() => run("/mcp/disconnect")}>Disconnect</Button>
                </>
              ) : (
                <Button variant="primary" loading={busy} disabled={!view.enabled || !view.profileId} onClick={() => run("/mcp/connect", view.profileId ? { profileId: view.profileId } : {})}>Connect</Button>
              )}
            </div>
            {view.nextAction && !connected && <p className="mt-2 text-[12px] text-[#E5A158]">{view.nextAction}</p>}
            {!connected && <p className="mt-1 text-[12px] text-[#8A8F98]">{view.detection.summary}</p>}
            {view.lastError && !connected && <p className="mt-1 text-[12px] text-[#E5484D]">{view.lastError}</p>}
            {connected && <p className="mt-2 font-mono text-[11px] text-[#5E626E]">{view.enabledToolCount}/{view.toolCount} tools enabled · {view.serverCount} servers</p>}
          </section>

          {pending.length > 0 && (
            <Link
              to="/approvals"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#E5A158]/30 bg-[#E5A158]/5 px-3 py-2 text-[12px] text-[#E5A158] transition-colors hover:bg-[#E5A158]/10"
            >
              <span>
                {pending.length} approval{pending.length === 1 ? "" : "s"} waiting on a decision
              </span>
              <span className="flex items-center gap-1">
                Approvals inbox
                <Icon name="arrow_forward" size={14} />
              </span>
            </Link>
          )}

          {connected && (
            <>
              <div className="mt-4 flex items-center gap-2">
                <div className="relative flex-1">
                  <Icon name="search" size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#5E626E]" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tools" aria-label="Search tools" className="h-9 w-full rounded-full border border-[#2E3038] bg-[#141518] pl-8 pr-3 text-[13px] text-white placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none" />
                </div>
              </div>

              {(view.servers ?? []).map((server) => (
                <section key={server.name} className="mt-3 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-white"><Icon name="dns" size={15} className="text-[#8A8F98]" />{server.name}<span className="font-mono text-[10px] text-[#5E626E]">{server.toolCount} tools</span></span>
                    <Toggle checked={server.enabled} disabled={busy} label={`Enable server ${server.name}`} onChange={(enabled) => updateServer(server, enabled)} />
                  </div>
                  <ul className="mt-2 divide-y divide-[#26282E]/60">
                    {tools.filter((t) => t.serverName === server.name).map((tool) => {
                      const key = `${tool.serverName}/${tool.name}`;
                      return (
                        <li key={key} className="flex flex-wrap items-center gap-2 py-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[12px] text-white">{tool.name}</span>
                            <span className="block truncate text-[11px] text-[#5E626E]">{tool.description || tool.modelName}</span>
                          </span>
                          <StatusPill tone={LEVEL[tool.permissionLevel].tone}>{LEVEL[tool.permissionLevel].label}</StatusPill>
                          {!tool.reviewed && (
                            <select aria-label={`Review level for ${key}`} className="h-7 rounded border border-[#E5A158]/40 bg-[#141518] px-1 text-[11px] text-[#E5A158]" value={levels[key] ?? 3} onChange={(e) => setLevels((prev) => ({ ...prev, [key]: Number(e.target.value) as McpPermissionLevel }))}>
                              <option value={1}>Review L1</option><option value={2}>Review L2</option><option value={3}>Review L3</option>
                            </select>
                          )}
                          {(["coding-agent", "verification-agent"] as const).map((role) => (
                            <label key={role} className="flex items-center gap-1 text-[11px] text-[#8A8F98]">
                              <input type="checkbox" className="h-3 w-3 accent-[#5E6AD2]" checked={tool.allowedAgents.includes(role)} disabled={busy} onChange={(e) => updateAgents(tool, role, e.target.checked)} />
                              {role === "coding-agent" ? "Coding" : "Verify"}
                            </label>
                          ))}
                          <Toggle checked={tool.enabled} disabled={busy || !server.enabled} label={`Enable tool ${key}`} onChange={(enabled) => updateTool(tool, enabled)} />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}

              {(view.activity ?? []).length > 0 && (
                <section className="mt-3 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
                  <h2 className="text-[13px] font-medium text-white">Activity</h2>
                  <ul className="mt-1 divide-y divide-[#26282E]/60">
                    {view.activity.slice(0, 10).map((call) => (
                      <li key={call.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[11px]">
                        <span className="font-mono text-white">{call.serverName}/{call.toolName}</span>
                        <StatusPill tone={call.success ? "success" : call.executed ? "danger" : "neutral"}>{call.success ? "ran" : call.executed ? "failed" : "not run"}</StatusPill>
                        <span className="text-[#5E626E]">{call.agent} · L{call.permissionLevel} · {call.approvalStatus}</span>
                        {call.runId && <Link to={`/runs/${call.runId}`} className="ml-auto font-mono text-[10px] text-[#BDC2FF] hover:underline">{call.runId.slice(0, 12)}</Link>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
