import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Icon } from "./components/Icon";
import { NotificationsBell } from "./components/NotificationsBell";
import { api, type Run } from "./lib/api";
import { useConfigStatus } from "./lib/config-status";
import { readinessItems } from "./lib/status";
import { NewAnalysis } from "./pages/NewAnalysis";
import { Overview } from "./pages/Overview";
import { RunDetail } from "./pages/RunDetail";
import { Settings } from "./pages/Settings";
import { Connectors } from "./pages/Connectors";
import { ConnectorDocker } from "./pages/ConnectorDocker";
import { ConnectorGithub } from "./pages/ConnectorGithub";
import { Docs } from "./pages/Docs";
import { Repositories } from "./pages/Repositories";
import { Runs } from "./pages/Runs";

const TERMINAL_STATES = ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"];

const PAGES = [
  { label: "Overview", to: "/", icon: "grid_view" },
  { label: "New Analysis", to: "/new", icon: "add_circle" },
  { label: "Runs", to: "/runs", icon: "commit" },
  { label: "Repositories", to: "/repositories", icon: "source_environment" },
  { label: "Connectors", to: "/connectors", icon: "hub" },
  { label: "Docs", to: "/docs", icon: "menu_book" },
  { label: "Settings", to: "/settings", icon: "settings" },
] as const;

function navClass(active: boolean): string {
  return `flex items-center justify-between rounded-md px-1.5 py-1.5 transition-colors ${
    active ? "bg-[#282A31] font-medium text-[#ECEEF0] shadow-sm" : "text-[#8A8F98] hover:bg-[#222329] hover:text-[#ECEEF0]"
  }`;
}

function itemClass(active: boolean): string {
  return `flex items-center gap-2.5 text-[13px] ${active ? "font-medium text-[#ECEEF0]" : ""}`;
}

function iconClass(active: boolean): string {
  return active ? "text-[#BDC2FF]" : "text-[#8A8F98]";
}

function CommandPalette({ open, onClose, runs }: { open: boolean; onClose: () => void; runs: Run[] }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const id = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, [open]);

  const pageResults = useMemo(
    () => PAGES.filter((p) => p.label.toLowerCase().includes(query.trim().toLowerCase())),
    [query],
  );
  const runResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs
      .filter((r) => !q || r.issueTitle.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      .slice(0, 6);
  }, [runs, query]);

  if (!open) return null;

  function go(to: string) {
    onClose();
    navigate(to);
  }

  const first = pageResults[0]?.to ?? (runResults[0] ? `/runs/${runResults[0].id}` : null);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search workbench"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[#363840] bg-[#222328] shadow-[0_4px_20px_0_rgba(0,0,0,0.45)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[#2E3038] px-3">
          <Icon name="search" size={16} className="text-[#5E626E]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && first) go(first);
            }}
            placeholder="Search workbench..."
            aria-label="Search workbench"
            className="h-11 flex-1 bg-transparent text-[13px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:outline-none"
          />
          <kbd className="rounded border border-[#2E3038] bg-[#1A1B20] px-1 py-0.5 font-mono text-[10px] text-[#5E626E]">Esc</kbd>
        </div>

        <div className="max-h-[340px] overflow-y-auto p-1.5">
          {pageResults.length > 0 && (
            <>
              <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Navigation</p>
              {pageResults.map((p) => (
                <button
                  key={p.to}
                  type="button"
                  onClick={() => go(p.to)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-[#ECEEF0] transition-colors hover:bg-[#282A31]"
                >
                  <Icon name={p.icon} size={16} className="text-[#8A8F98]" />
                  {p.label}
                </button>
              ))}
            </>
          )}

          {runResults.length > 0 && (
            <>
              <p className="px-2 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">Runs</p>
              {runResults.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => go(`/runs/${r.id}`)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[#282A31]"
                >
                  <Icon name="commit" size={16} className="text-[#8A8F98]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-[#ECEEF0]">{r.issueTitle}</span>
                    <span className="block truncate font-mono text-[10px] text-[#5E626E]">{r.id}</span>
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">{r.state.replaceAll("_", " ")}</span>
                </button>
              ))}
            </>
          )}

          {pageResults.length === 0 && runResults.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-[#8A8F98]">No matches in the workbench.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const config = useConfigStatus();
  const location = useLocation();
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });
  const [searchOpen, setSearchOpen] = useState(false);

  const blockers = config.data ? readinessItems(config.data).filter((i) => i.tone === "blocked").length : 0;
  const activeRuns = (runsQuery.data ?? []).filter((r) => !TERMINAL_STATES.includes(r.state)).length;

  const runMatch = /^\/runs\/(.+)$/.exec(location.pathname);
  const pageTitle = runMatch
    ? `Run ${runMatch[1]}`
    : location.pathname === "/runs"
      ? "Runs"
      : location.pathname === "/repositories"
        ? "Repositories"
        : location.pathname === "/new"
          ? "New Analysis"
          : location.pathname === "/settings"
            ? "Settings"
            : location.pathname.startsWith("/connectors")
              ? "Connectors"
              : location.pathname === "/docs"
                ? "Docs"
                : "Overview";

  const overviewActive = location.pathname === "/";
  const runsActive = location.pathname === "/runs" || location.pathname.startsWith("/runs/");
  const reposActive = location.pathname === "/repositories";
  const newActive = location.pathname === "/new";
  const connectorsActive = location.pathname.startsWith("/connectors");
  const settingsActive = location.pathname === "/settings";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") setSearchOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setSearchOpen(false);
  }, [location.pathname, location.hash]);

  const health = config.isError
    ? { label: "Offline", dot: "bg-[#E5484D]", shell: "border-[#E5484D]/20 bg-[#E5484D]/10 text-[#E5484D]" }
    : config.isLoading || !config.data
      ? { label: "Checking", dot: "bg-[#5E626E]", shell: "border-[#2E3038] bg-[#1A1B20] text-[#8A8F98]" }
      : { label: "Online", dot: "bg-[#27A567]", shell: "border-[#27A567]/20 bg-[#27A567]/10 text-[#34D399]" };

  return (
    <div className="min-h-screen bg-[#141518] text-[#ECEEF0]">
      <aside className="fixed left-0 top-0 z-50 hidden h-full w-[220px] select-none flex-col justify-between border-r border-[#26282E] bg-[#18191D] lg:flex">
        <div className="flex flex-col">
          <div className="flex h-12 items-center justify-between border-b border-[#26282E]/60 px-4">
            <Link to="/" className="text-[16px] font-medium tracking-[-0.015em] text-[#ECEEF0]" aria-label="DNAFix home">
              DNAFix
            </Link>
            <span className="rounded border border-[#2E3038] bg-[#222329] px-1.5 py-0.5 font-mono text-[10px] leading-[14px] text-[#8A8F98]">v0.1.0</span>
          </div>

          <div className="px-2 py-1.5">
            <span className="block px-1.5 py-1 text-[11px] font-medium uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">Workbench</span>
          </div>

          <nav className="flex flex-col gap-0.5 px-1.5" aria-label="Primary">
            <Link to="/" aria-current={overviewActive ? "page" : undefined} className={navClass(overviewActive)}>
              <span className={itemClass(overviewActive)}>
                <Icon name="grid_view" size={16} className={iconClass(overviewActive)} />
                Overview
              </span>
            </Link>

            <Link to="/new" aria-current={newActive ? "page" : undefined} className={navClass(newActive)}>
              <span className={itemClass(newActive)}>
                <Icon name="add_circle" size={16} className={iconClass(newActive)} />
                New Analysis
              </span>
            </Link>

            <Link to="/runs" aria-current={runsActive ? "page" : undefined} className={navClass(runsActive)}>
              <span className={itemClass(runsActive)}>
                <Icon name="commit" size={16} className={iconClass(runsActive)} />
                Runs
              </span>
              {activeRuns > 0 && (
                <span className="flex items-center gap-1 rounded-full bg-[#27A567]/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#34D399]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#34D399]" aria-hidden />
                  {activeRuns} active
                </span>
              )}
            </Link>

            <Link to="/repositories" aria-current={reposActive ? "page" : undefined} className={navClass(reposActive)}>
              <span className={itemClass(reposActive)}>
                <Icon name="source_environment" size={16} className={iconClass(reposActive)} />
                Repositories
              </span>
            </Link>

            <Link to="/connectors" aria-current={connectorsActive ? "page" : undefined} className={navClass(connectorsActive)}>
              <span className={itemClass(connectorsActive)}>
                <Icon name="hub" size={16} className={iconClass(connectorsActive)} />
                Connectors
              </span>
            </Link>
          </nav>
        </div>

        <div className="flex flex-col gap-1.5 border-t border-[#26282E]/60 p-1.5">
          <div
            className={`flex items-center justify-between rounded-md border px-1.5 py-1.5 ${
              blockers > 0 || config.isError ? "border-[#2E3038] bg-[#1F2026]" : "border-[#2E3038] bg-[#1F2026]"
            }`}
            title={blockers > 0 ? `${blockers} required action${blockers > 1 ? "s" : ""} before an analysis can start` : "All readiness checks pass"}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  config.isError
                    ? "bg-[#E5484D]"
                    : config.isLoading
                      ? "bg-[#5E626E]"
                      : blockers > 0
                        ? "animate-pulse bg-[#E5484D]"
                        : "bg-[#27A567]"
                }`}
                aria-hidden
              />
              <span
                className={`font-mono text-[12px] font-medium ${
                  blockers > 0 || config.isError ? "text-[#E5484D]" : config.isLoading ? "text-[#8A8F98]" : "text-[#34D399]"
                }`}
              >
                {config.isError ? "API offline" : config.isLoading ? "Checking" : blockers > 0 ? `${blockers} Blocker${blockers > 1 ? "s" : ""}` : "Ready"}
              </span>
            </div>
            <span className="text-[11px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">
              {config.isError ? "Unknown" : config.isLoading ? "Checking" : blockers > 0 ? "Degraded" : "Operational"}
            </span>
          </div>

          <nav aria-label="Settings">
            <Link to="/settings" aria-current={settingsActive ? "page" : undefined} className={navClass(settingsActive)}>
              <span className={itemClass(settingsActive)}>
                <Icon name="settings" size={16} className={iconClass(settingsActive)} />
                Settings
              </span>
            </Link>
          </nav>

          <Link to="/settings" className="flex items-center justify-between rounded-md px-1.5 py-1.5 transition-colors hover:bg-[#222329]">
            <span className="flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[#2E3038] bg-[#282A31]">
                <Icon name="person" size={13} className="text-[#8A8F98]" />
              </span>
              <span className="text-[13px] font-medium leading-none text-[#ECEEF0]">Local runtime</span>
            </span>
          </Link>
        </div>
      </aside>

      <div className="lg:pl-[220px]">
        <header className="fixed left-0 right-0 top-0 z-40 flex h-12 items-center justify-between border-b border-[#26282E] bg-[#141518]/90 px-4 backdrop-blur-md lg:left-[220px]">
          <div className="flex items-center gap-1.5 text-[13px] lg:hidden">
            <Link to="/" className="font-medium text-[#ECEEF0]">
              DNAFix
            </Link>
          </div>

          <div className="hidden items-center gap-1.5 text-[13px] lg:flex">
            <Link to="/" className="text-[#8A8F98] transition-colors hover:text-[#ECEEF0]">
              Workspace
            </Link>
            <span className="text-[#5E626E]">/</span>
            <span className="font-medium text-[#ECEEF0]">{pageTitle}</span>
          </div>

          <div className="hidden items-center gap-3 lg:flex">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex items-center gap-1 rounded-md border border-[#26282E] bg-[#1A1B20] px-1.5 py-1 shadow-sm transition-colors hover:border-[#424652]"
              aria-label="Search workbench"
            >
              <Icon name="search" size={14} className="text-[#5E626E]" />
              <span className="font-mono text-[12px] leading-4 text-[#8A8F98]">Search workbench...</span>
              <kbd className="rounded border border-[#2E3038] bg-[#222329] px-1 py-0.5 font-mono text-[10px] text-[#5E626E]">⌘K</kbd>
            </button>

            <Link to="/docs" className="flex items-center gap-1.5 text-[12px] text-[#8A8F98] transition-colors hover:text-[#ECEEF0]">
              <Icon name="menu_book" size={15} className="text-[#8A8F98]" />
              Docs
            </Link>

            <div className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${health.shell}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${health.dot}`} aria-hidden />
              <span className="font-mono text-[11px] font-medium">{health.label}</span>
            </div>

            <NotificationsBell />

            <Link
              to="/settings"
              className="flex h-6 w-6 items-center justify-center rounded-full border border-[#2E3038] bg-[#282A31] transition-colors hover:border-[#424652]"
              aria-label="Settings"
            >
              <Icon name="person" size={14} className="text-[#8A8F98]" />
            </Link>
          </div>

          <div className="flex items-center gap-3 lg:hidden">
            <NotificationsBell />
            <Link to="/" aria-label="Overview" className={iconClass(overviewActive)}>
              <Icon name="grid_view" size={18} />
            </Link>
            <Link to="/new" aria-label="New Analysis" className={iconClass(newActive)}>
              <Icon name="add_circle" size={18} />
            </Link>
            <Link to="/runs" aria-label="Runs" className={iconClass(runsActive)}>
              <Icon name="commit" size={18} />
            </Link>
            <Link to="/connectors" aria-label="Connectors" className={iconClass(connectorsActive)}>
              <Icon name="hub" size={18} />
            </Link>
            <Link to="/settings" aria-label="Settings" className={iconClass(settingsActive)}>
              <Icon name="settings" size={18} />
            </Link>
            <span className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${health.dot}`} aria-hidden />
              <span className={`font-mono text-[10px] ${health.label === "Online" ? "text-[#34D399]" : "text-[#8A8F98]"}`}>{health.label}</span>
            </span>
          </div>
        </header>

        <main className="min-h-screen bg-[#141518] pt-12">
          <div className="mx-auto w-full max-w-[1220px] px-3 py-4">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/new" element={<NewAnalysis />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/repositories" element={<Repositories />} />
              <Route path="/connectors" element={<Connectors />} />
              <Route path="/connectors/docker" element={<ConnectorDocker />} />
              <Route path="/connectors/github" element={<ConnectorGithub />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </div>
        </main>
      </div>

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} runs={runsQuery.data ?? []} />
    </div>
  );
}

export function App() {
  return <Shell />;
}
