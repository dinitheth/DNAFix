import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { StatusPill } from "../components/ui";
import { api, type GitHubStatus, type McpConnectorView } from "../lib/api";

interface Plugin {
  id: string;
  name: string;
  description: string;
  tileBg: string;
  tileFg: string;
  glyph: string;
  href?: string;
}

const PLUGINS: Plugin[] = [
  { id: "github", name: "Github", description: "Connect repos, import issues, draft PRs", tileBg: "#24292f", tileFg: "#ffffff", glyph: "code", href: "/connectors/github" },
  { id: "docker", name: "Docker MCP", description: "Docker Desktop MCP Toolkit gateway", tileBg: "#1D63ED", tileFg: "#ffffff", glyph: "deployed_code", href: "/connectors/docker" },
  { id: "postgres", name: "Postgres", description: "Query and inspect Postgres databases", tileBg: "#336791", tileFg: "#ffffff", glyph: "database" },
  { id: "filesystem", name: "Filesystem", description: "Read workspace files as MCP resources", tileBg: "#3A3D46", tileFg: "#ffffff", glyph: "folder" },
  { id: "playwright", name: "Playwright", description: "Drive real browsers for verification", tileBg: "#2E7D32", tileFg: "#ffffff", glyph: "web" },
  { id: "stripe", name: "Stripe", description: "Inspect payments and subscriptions", tileBg: "#635BFF", tileFg: "#ffffff", glyph: "payments" },
  { id: "notion", name: "Notion", description: "Read and manage Notion workspace", tileBg: "#E8E8E8", tileFg: "#111111", glyph: "description" },
  { id: "brave", name: "Brave Search", description: "Search the web for real-time context", tileBg: "#FB542B", tileFg: "#ffffff", glyph: "search" },
];

function Tile({ plugin }: { plugin: Plugin }) {
  return (
    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: plugin.tileBg, color: plugin.tileFg }}>
      <Icon name={plugin.glyph} size={20} />
    </span>
  );
}

export function Connectors() {
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const connector = useQuery({ queryKey: ["mcp-status"], queryFn: () => api<McpConnectorView>("/mcp/status"), refetchInterval: 5_000 });
  const github = useQuery({ queryKey: ["github-status"], queryFn: () => api<GitHubStatus>("/integrations/github/status"), retry: false });

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => (q ? PLUGINS.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q)) : PLUGINS), [q]);
  const pending = (connector.data?.approvals ?? []).filter((a) => a.status === "pending").length;

  function statusFor(plugin: Plugin) {
    if (plugin.id === "github") return github.data?.connected ? <StatusPill tone="success">Connected</StatusPill> : null;
    if (plugin.id === "docker") {
      if (connector.data?.state === "connected") return <StatusPill tone="success">Connected</StatusPill>;
      if (pending > 0) return <StatusPill tone="warning">{pending} approval{pending === 1 ? "" : "s"}</StatusPill>;
      return null;
    }
    return null;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6">
      <label className="relative block">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-3 text-[#5E626E]" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search plugins" aria-label="Search plugins" className="h-10 w-full rounded-full border border-[#2E3038] bg-[#141518] pl-9 pr-4 text-[13px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none" />
      </label>

      {notice && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-lg border border-[#5E6AD2]/30 bg-[#5E6AD2]/10 px-3 py-2 text-[12px] text-[#BDC2FF]">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100"><Icon name="close" size={14} /></button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
        {filtered.map((plugin) => {
          const body = (
            <>
              <span className="flex min-w-0 items-center gap-3">
                <Tile plugin={plugin} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold text-white">
                    {plugin.name}
                    {!plugin.href && <span className="ml-1 rounded bg-[#26282E] px-1.5 py-0.5 align-middle text-[10px] font-medium text-[#8A8F98]">via Docker</span>}
                  </span>
                  <span className="block truncate text-[13px] text-[#8A8F98]">{plugin.description}</span>
                </span>
              </span>
              {statusFor(plugin) ?? <Icon name={plugin.href ? "chevron_right" : "info"} size={18} className="shrink-0 text-[#5E626E]" />}
            </>
          );
          return plugin.href ? (
            <Link key={plugin.id} to={plugin.href} className="flex items-center justify-between gap-3 rounded-lg p-1 -m-1 hover:bg-[#1A1B20]">{body}</Link>
          ) : (
            <button key={plugin.id} type="button" onClick={() => setNotice(`${plugin.name} is a Docker MCP Catalog server. Enable it in a Docker Desktop MCP profile, then open Docker MCP to connect.`)} className="flex items-center justify-between gap-3 rounded-lg p-1 -m-1 text-left hover:bg-[#1A1B20]">{body}</button>
          );
        })}
      </div>

      {filtered.length === 0 && <p className="text-[13px] text-[#5E626E]">No plugins match “{search.trim()}”.</p>}
    </div>
  );
}
