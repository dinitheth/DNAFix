import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { StatusPill } from "../components/ui";
import { api, type GitHubStatus, type McpConnectorView, type McpServerView } from "../lib/api";

interface Plugin {
  id: string;
  name: string;
  description: string;
  tileBg: string;
  tileFg: string;
  glyph: string;
  href: string;
}

const PLUGINS: Plugin[] = [
  { id: "github", name: "GitHub", description: "Connect repos, import issues, draft PRs", tileBg: "#24292f", tileFg: "#ffffff", glyph: "code", href: "/connectors/github" },
  { id: "docker", name: "Docker MCP", description: "Docker Desktop MCP Toolkit gateway", tileBg: "#1D63ED", tileFg: "#ffffff", glyph: "deployed_code", href: "/connectors/docker" },
];

function Tile({ bg, fg, glyph }: { bg: string; fg: string; glyph: string }) {
  return (
    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: bg, color: fg }}>
      <Icon name={glyph} size={20} />
    </span>
  );
}

function Row({ tile, name, description, trailing, to }: { tile: ReactNode; name: string; description: string; trailing: ReactNode; to: string }) {
  return (
    <Link to={to} className="-m-1 flex items-center justify-between gap-3 rounded-lg p-1 hover:bg-[#1A1B20]">
      <span className="flex min-w-0 items-center gap-3">
        {tile}
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold text-white">{name}</span>
          <span className="block truncate text-[13px] text-[#8A8F98]">{description}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">{trailing}</span>
    </Link>
  );
}

export function Connectors() {
  const [search, setSearch] = useState("");
  const connector = useQuery({ queryKey: ["mcp-status"], queryFn: () => api<McpConnectorView>("/mcp/status"), refetchInterval: 5_000 });
  const github = useQuery({ queryKey: ["github-status"], queryFn: () => api<GitHubStatus>("/integrations/github/status"), retry: false });

  const q = search.trim().toLowerCase();
  const plugins = useMemo(() => PLUGINS.filter((p) => !q || `${p.name} ${p.description}`.toLowerCase().includes(q)), [q]);
  const servers = useMemo(
    () => (connector.data?.servers ?? []).filter((s) => !q || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q)),
    [connector.data, q],
  );
  const pending = (connector.data?.approvals ?? []).filter((a) => a.status === "pending").length;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6">
      <label className="relative block">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-3 text-[#5E626E]" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search connectors" aria-label="Search connectors" className="h-10 w-full rounded-full border border-[#2E3038] bg-[#141518] pl-9 pr-4 text-[13px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none" />
      </label>

      <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
        {plugins.map((plugin) => (
          <Row
            key={plugin.id}
            tile={<Tile bg={plugin.tileBg} fg={plugin.tileFg} glyph={plugin.glyph} />}
            name={plugin.name}
            description={plugin.description}
            to={plugin.href}
            trailing={
              plugin.id === "github" ? (
                github.data?.connected ? <StatusPill tone="success">Connected</StatusPill> : <Icon name="chevron_right" size={18} className="text-[#5E626E]" />
              ) : plugin.id === "docker" ? (
                <>
                  {connector.data?.state === "connected" && <StatusPill tone="success">Connected</StatusPill>}
                  {pending > 0 && <StatusPill tone="warning">{pending} approval{pending === 1 ? "" : "s"}</StatusPill>}
                  <Icon name="chevron_right" size={18} className="text-[#5E626E]" />
                </>
              ) : null
            }
          />
        ))}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-[#8A8F98]">MCP servers</h2>
        {servers.length > 0 ? (
          <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
            {servers.map((server) => (
              <ServerRow key={server.name} server={server} />
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-[#8A8F98]">
            {connector.data?.state === "connected"
              ? "The gateway is connected but reports no servers. Pick a profile on the Docker MCP page."
              : "Servers appear here once the Docker MCP gateway is connected."}
          </p>
        )}
      </section>

      {plugins.length === 0 && servers.length === 0 && <p className="text-[13px] text-[#5E626E]">Nothing matches “{search.trim()}”.</p>}
    </div>
  );
}

function ServerRow({ server }: { server: McpServerView }) {
  return (
    <Row
      tile={<Tile bg="#3A3D46" fg="#ffffff" glyph="extension" />}
      name={server.name}
      description={server.description ?? `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`}
      to="/connectors/docker"
      trailing={
        server.enabled ? (
          <StatusPill tone={server.health === "reachable" ? "success" : "neutral"}>{server.toolCount} tools</StatusPill>
        ) : (
          <StatusPill tone="neutral">disabled</StatusPill>
        )
      }
    />
  );
}
