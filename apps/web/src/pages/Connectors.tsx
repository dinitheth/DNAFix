import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { Button, StatusPill } from "../components/ui";
import { api, type GitHubStatus, type McpConnectorView } from "../lib/api";

type PluginId =
  | "github-app"
  | "docker-desktop"
  | "postgres"
  | "filesystem"
  | "playwright"
  | "stripe"
  | "notion"
  | "brave";

interface CatalogPlugin {
  id: PluginId;
  name: string;
  description: string;
  /** Tile appearance: brand-like solid color + glyph, no external images. */
  tileBg: string;
  tileFg: string;
  glyph: string;
}

const CORE_PLUGINS: CatalogPlugin[] = [
  { id: "github-app", name: "GitHub App", description: "Connect repos, import issues, draft PRs", tileBg: "#24292f", tileFg: "#ffffff", glyph: "code" },
  { id: "docker-desktop", name: "Docker Desktop", description: "Run MCP tools via local gateway", tileBg: "#1D63ED", tileFg: "#ffffff", glyph: "deployed_code" },
];

const CATALOG_PLUGINS: CatalogPlugin[] = [
  { id: "postgres", name: "Postgres", description: "Query and inspect Postgres databases", tileBg: "#336791", tileFg: "#ffffff", glyph: "database" },
  { id: "filesystem", name: "Filesystem", description: "Read workspace files as MCP resources", tileBg: "#3A3D46", tileFg: "#ffffff", glyph: "folder" },
  { id: "playwright", name: "Playwright", description: "Drive real browsers for verification", tileBg: "#2E7D32", tileFg: "#ffffff", glyph: "web" },
  { id: "stripe", name: "Stripe", description: "Inspect payments and subscriptions", tileBg: "#635BFF", tileFg: "#ffffff", glyph: "payments" },
  { id: "notion", name: "Notion", description: "Read and manage Notion workspace", tileBg: "#E8E8E8", tileFg: "#111111", glyph: "description" },
  { id: "brave", name: "Brave Search", description: "Search the web for real-time context", tileBg: "#FB542B", tileFg: "#ffffff", glyph: "search" },
];

function Tile({ plugin }: { plugin: CatalogPlugin }) {
  return (
    <span
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
      style={{ backgroundColor: plugin.tileBg, color: plugin.tileFg }}
    >
      <Icon name={plugin.glyph} size={20} />
    </span>
  );
}

export function Connectors() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dockerOpen, setDockerOpen] = useState(false);

  const connector = useQuery({
    queryKey: ["mcp-status"],
    queryFn: () => api<McpConnectorView>("/mcp/status"),
    refetchInterval: 5_000,
  });
  const github = useQuery({
    queryKey: ["github-status"],
    queryFn: () => api<GitHubStatus>("/integrations/github/status"),
    retry: false
  });

  const mutation = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) =>
      api<unknown>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["mcp-status"] });
    },
    onError: (err: Error) => setError(err.message)
  });

  const view = connector.data;
  const busy = mutation.isPending;
  const run = (path: string, body?: unknown) => {
    setNotice(null);
    mutation.mutate({ path, body });
  };

  const q = search.trim().toLowerCase();
  const all = useMemo(() => [...CORE_PLUGINS, ...CATALOG_PLUGINS], []);
  const filtered = q ? all.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q)) : all;

  const pending = (view?.approvals ?? []).filter((a) => a.status === "pending");
  const connected = view?.state === "connected";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6">
      <label className="relative block">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-3 text-[#5E626E]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search plugins"
          aria-label="Search plugins"
          className="h-10 w-full rounded-full border border-[#2E3038] bg-[#141518] pl-9 pr-4 text-[13px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
        />
      </label>

      {error && (
        <div role="alert" className="rounded-lg border border-[#E5484D]/30 bg-[#E5484D]/10 px-3 py-2 text-[12px] text-[#E5484D]">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border border-[#5E6AD2]/30 bg-[#5E6AD2]/10 px-3 py-2 text-[12px] text-[#BDC2FF]">
          {notice}
        </div>
      )}
      {pending.length > 0 && (
        <div className="rounded-xl border border-[#E5A158]/30 bg-[#E5A158]/5 p-3">
          <p className="text-[13px] font-medium text-[#E5A158]">
            {pending.length} MCP approval{pending.length === 1 ? "" : "s"} waiting
          </p>
          <ul className="mt-2 space-y-2">
            {pending.map((approval) => (
              <li key={approval.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#2E3038] bg-[#141518] p-2">
                <span className="font-mono text-[12px] text-[#ECEEF0]">
                  {approval.serverName}/{approval.toolName}
                </span>
                <span className="flex gap-1.5">
                  <Button variant="danger-ghost" disabled={busy} onClick={() => run(`/runs/${encodeURIComponent(approval.runId)}/mcp/approvals/${encodeURIComponent(approval.id)}`, { decision: "deny" })}>
                    Deny
                  </Button>
                  <Button variant="primary" disabled={busy} onClick={() => run(`/runs/${encodeURIComponent(approval.runId)}/mcp/approvals/${encodeURIComponent(approval.id)}`, { decision: "approve" })}>
                    Approve
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
        {filtered.map((plugin) => {
          if (plugin.id === "github-app") {
            const isConnected = github.data?.connected === true;
            const configured = github.data?.configured === true;
            return (
              <div key={plugin.id} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Tile plugin={plugin} />
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold text-white">{plugin.name}</p>
                    <p className="truncate text-[13px] text-[#8A8F98]">{isConnected && github.data?.account ? `Connected as ${github.data.account.login}` : plugin.description}</p>
                  </div>
                </div>
                {isConnected ? (
                  <StatusPill tone="success">Connected</StatusPill>
                ) : (
                  <button
                    type="button"
                    aria-label="Connect GitHub App"
                    disabled={!configured}
                    title={configured ? "Connect GitHub App" : "GitHub App is not configured on the API host"}
                    onClick={async () => {
                      try {
                        const res = await api<{ authorizeUrl: string }>("/integrations/github/connect", {
                          method: "POST",
                          body: JSON.stringify({ returnTo: "/connectors" })
                        });
                        window.location.assign(res.authorizeUrl);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[#8A8F98] hover:bg-[#26282E] hover:text-white disabled:opacity-40"
                  >
                    <Icon name="add" size={20} />
                  </button>
                )}
              </div>
            );
          }

          if (plugin.id === "docker-desktop") {
            return (
              <div key={plugin.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Tile plugin={plugin} />
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold text-white">{plugin.name}</p>
                      <p className="truncate text-[13px] text-[#8A8F98]">
                        {connected ? `Connected${view?.profileId ? ` · ${view.profileId}` : ""}` : view ? view.reason || plugin.description : plugin.description}
                      </p>
                    </div>
                  </div>
                  {connected ? (
                    <StatusPill tone="success">Connected</StatusPill>
                  ) : (
                    <button
                      type="button"
                      aria-label={dockerOpen ? "Close Docker settings" : "Configure Docker Desktop"}
                      onClick={() => setDockerOpen((v) => !v)}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-[#8A8F98] hover:bg-[#26282E] hover:text-white"
                    >
                      <Icon name="add" size={20} />
                    </button>
                  )}
                </div>
                {(dockerOpen || connected) && view && (
                  <div className="ml-12 flex flex-col gap-2 rounded-xl border border-[#26282E] bg-[#141518] p-3">
                    <label className="flex flex-col gap-1 text-[12px] text-[#8A8F98]">
                      Profile
                      <select
                        className="h-8 rounded-md border border-[#2E3038] bg-[#0F1013] px-2 text-[13px] text-white focus:border-[#5E6AD2] focus:outline-none disabled:opacity-50"
                        value={view.profileId ?? ""}
                        disabled={busy || !view.enabled}
                        onChange={(e) => run("/mcp/profile", { profileId: e.target.value })}
                      >
                        <option value="">Select a profile…</option>
                        {(view.profiles ?? []).map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} ({profile.id})
                          </option>
                        ))}
                      </select>
                    </label>
                    {view.nextAction && view.state !== "connected" && <p className="text-[12px] text-[#E5A158]">{view.nextAction}</p>}
                    {view.lastError && view.state !== "connected" && <p className="text-[12px] text-[#E5484D]">{view.lastError}</p>}
                    <div className="flex flex-wrap items-center gap-2">
                      {!view.enabled && (
                        <Button variant="secondary" disabled={busy} onClick={() => run("/mcp/enable", { enabled: true })}>
                          Enable
                        </Button>
                      )}
                      {view.enabled && !connected && (
                        <Button
                          variant="primary"
                          loading={busy}
                          disabled={!view.profileId}
                          onClick={() => run("/mcp/connect", view.profileId ? { profileId: view.profileId } : {})}
                        >
                          Connect
                        </Button>
                      )}
                      {connected && (
                        <>
                          <Button variant="secondary" loading={busy} onClick={() => run("/mcp/refresh")}>
                            Refresh
                          </Button>
                          <Button variant="danger-ghost" loading={busy} onClick={() => run("/mcp/disconnect")}>
                            Disconnect
                          </Button>
                        </>
                      )}
                      <button
                        type="button"
                        className="ml-auto flex items-center gap-1 text-[12px] text-[#8A8F98] hover:text-white"
                        disabled={busy}
                        onClick={() => run(view.enabled ? "/mcp/disconnect" : "/mcp/enable", view.enabled ? undefined : { enabled: true })}
                        title={view.enabled ? "Disable connector" : "Enable connector"}
                      >
                        <Icon name={view.enabled ? "toggle_on" : "toggle_off"} size={18} />
                        {view.enabled ? "On" : "Off"}
                      </button>
                    </div>
                    {connected && <p className="text-[11px] text-[#5E626E]">{view.enabledToolCount} of {view.toolCount} tools enabled</p>}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={plugin.id} className="flex items-center justify-between gap-3 opacity-90">
              <div className="flex min-w-0 items-center gap-3">
                <Tile plugin={plugin} />
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-white">{plugin.name}</p>
                  <p className="truncate text-[13px] text-[#8A8F98]">{plugin.description}</p>
                </div>
              </div>
              <button
                type="button"
                aria-label={`Enable ${plugin.name} via Docker Desktop`}
                title="Available in the Docker MCP Catalog — enable it in a Docker Desktop MCP profile"
                onClick={() => {
                  setDockerOpen(true);
                  setNotice(`${plugin.name} is available in the Docker MCP Catalog. Enable it in a Docker Desktop MCP profile, then use Docker Desktop above to connect. DNAFix never installs servers itself.`);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[#8A8F98] hover:bg-[#26282E] hover:text-white"
              >
                <Icon name="add" size={20} />
              </button>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && <p className="text-[13px] text-[#5E626E]">No plugins match “{search.trim()}”.</p>}
    </div>
  );
}
