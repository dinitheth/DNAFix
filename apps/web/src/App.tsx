import { FlaskConical, LayoutDashboard, Plus } from "lucide-react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useConfigStatus } from "./components/ReadinessPanel";
import { NewAnalysis } from "./pages/NewAnalysis";
import { Overview } from "./pages/Overview";
import { RunDetail } from "./pages/RunDetail";
import { readinessItems } from "./lib/status";

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden className="shrink-0">
      <rect x="1" y="1" width="24" height="24" rx="6" stroke="#647BFA" strokeWidth="1.6" />
      <path d="M8.5 6.5c5 3.4 5 9.6 0 13M17.5 6.5c-5 3.4-5 9.6 0 13" stroke="#647BFA" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10.2 10h5.6M10.2 16h5.6" stroke="#32B987" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/new", label: "New analysis", icon: Plus, end: false },
] as const;

function Shell() {
  const config = useConfigStatus();
  const location = useLocation();
  const blockers = config.data ? readinessItems(config.data).filter((i) => i.tone === "blocked").length : 0;
  const pageTitle = location.pathname.startsWith("/runs/") ? "Run workspace" : location.pathname === "/new" ? "New analysis" : "Overview";

  return (
    <div className="min-h-screen bg-background text-text-primary lg:grid lg:grid-cols-[228px_minmax(0,1fr)]">
      {/* Sidebar (desktop) / top bar (mobile) */}
      <aside className="border-b border-border bg-surface lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <Link to="/" className="flex items-center gap-2.5" aria-label="DNAFix home">
            <BrandMark />
            <span className="leading-tight">
              <span className="block text-[15px] font-semibold tracking-tight">DNAFix</span>
              <span className="block text-[10px] text-text-muted">Engineering workbench</span>
            </span>
          </Link>
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-text-muted sm:flex lg:hidden">
            <span className={`h-1.5 w-1.5 rounded-full ${blockers ? "bg-danger" : "bg-success"}`} aria-hidden />
            {config.data ? (blockers ? `${blockers} blocker${blockers > 1 ? "s" : ""}` : "Ready") : "…"}
          </span>
        </div>
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
        <div className="mt-auto hidden px-4 pb-4 lg:block">
          <p className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <span className={`h-1.5 w-1.5 rounded-full ${config.data ? (blockers ? "bg-danger" : "bg-success") : "bg-text-muted"}`} aria-hidden />
            {config.isLoading ? "Checking systems…" : config.isError ? "API unreachable" : blockers ? `${blockers} system blocker${blockers > 1 ? "s" : ""}` : "All required systems ready"}
          </p>
          <p className="mt-1.5 text-[10px] leading-relaxed text-text-muted">Understand the software before changing the software.</p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 hidden border-b border-border bg-background/95 px-6 py-3 backdrop-blur lg:block">
          <p className="text-[13px] font-medium text-text-secondary">{pageTitle}</p>
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
