import { FlaskConical, FolderGit2, LayoutDashboard, Plus } from "lucide-react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useConfigStatus } from "./components/ReadinessPanel";
import { NewAnalysis } from "./pages/NewAnalysis";
import { Overview } from "./pages/Overview";
import { RunDetail } from "./pages/RunDetail";
import { readinessItems } from "./lib/status";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/new", label: "New analysis", icon: Plus, end: false },
  { to: "/#runs", label: "Runs", icon: FlaskConical, end: false },
  { to: "/#repositories", label: "Repositories", icon: FolderGit2, end: false },
] as const;

function Shell() {
  const config = useConfigStatus();
  const location = useLocation();
  const blockers = config.data ? readinessItems(config.data).filter((i) => i.tone === "blocked").length : 0;
  const pageTitle = location.pathname.startsWith("/runs/") ? "Run workspace" : location.pathname === "/new" ? "New analysis" : "Overview";

  return (
    <div className="min-h-screen bg-background text-text-primary lg:grid lg:grid-cols-[210px_minmax(0,1fr)]">
      {/* Sidebar (desktop) / top bar (mobile) */}
      <aside className="border-b border-border bg-background lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <Link to="/" className="flex items-center gap-2.5" aria-label="DNAFix home">
            <span className="text-[15px] font-semibold tracking-tight">DNAFix</span>
            <span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-muted">v0.1.0</span>
          </Link>
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-text-muted sm:flex lg:hidden">
            <span className={`h-1.5 w-1.5 rounded-full ${blockers ? "bg-danger" : "bg-success"}`} aria-hidden />
            {config.data ? (blockers ? `${blockers} blocker${blockers > 1 ? "s" : ""}` : "Ready") : "…"}
          </span>
        </div>
        <p className="hidden px-5 pb-1.5 pt-2 font-mono text-[10px] font-medium uppercase tracking-widest text-text-muted lg:block">Workbench</p>
        <nav className="flex gap-1 px-3 pb-3 lg:flex-col lg:gap-0.5" aria-label="Primary">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `inline-flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors ${
                  isActive ? "bg-surface-elevated text-text-primary ring-1 ring-border" : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                }`
              }
            >
              <Icon size={15} aria-hidden /> {label}
            </NavLink>
          ))}
          {location.pathname.startsWith("/runs/") && (
            <span className="inline-flex items-center gap-2 rounded-md bg-surface-elevated px-2.5 py-2 text-[13px] font-medium text-text-primary ring-1 ring-border" aria-current="page">
              <FlaskConical size={15} aria-hidden /> Run workspace
            </span>
          )}
        </nav>
        <div className="mt-auto hidden px-3 pb-4 lg:block">
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 ${blockers ? "border-red-500/25 bg-red-500/5" : "border-border bg-surface"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${config.data ? (blockers ? "animate-pulse bg-danger" : "bg-success") : "bg-text-muted"}`} aria-hidden />
            <span className={`text-xs font-medium ${blockers ? "text-danger" : "text-text-primary"}`}>
              {config.isLoading ? "Checking systems…" : config.isError ? "API unreachable" : blockers ? `${blockers} Blocker${blockers > 1 ? "s" : ""}` : "All systems ready"}
            </span>
            <span className="ml-auto text-[10px] text-text-muted">{blockers ? "Degraded" : "Operational"}</span>
          </div>
          <p className="mt-2.5 px-1 text-[10px] leading-relaxed text-text-muted">Understand the software before changing the software.</p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-border bg-background/95 px-6 py-2.5 backdrop-blur lg:flex">
          <p className="text-xs text-text-muted">
            Workspace <span className="mx-1.5 text-border-strong">/</span> <span className="font-medium text-text-primary">{pageTitle}</span>
          </p>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
              blockers ? "border-red-500/30 bg-red-500/10 text-danger" : "border-emerald-500/30 bg-emerald-500/10 text-success-light"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${blockers ? "animate-pulse bg-danger" : "bg-success"}`} aria-hidden />
            {config.isLoading ? "Checking" : blockers ? `${blockers} Required Action${blockers > 1 ? "s" : ""}` : "Ready"}
          </span>
        </header>
        <main className="mx-auto w-full max-w-[1240px] px-4 py-5 sm:px-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/new" element={<NewAnalysis />} />
            <Route path="/runs/:id" element={<RunDetail />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return <Shell />;
}
