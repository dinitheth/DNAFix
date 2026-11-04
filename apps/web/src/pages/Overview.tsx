import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { StatusPill } from "../components/ui";
import { api, type RepositoryRecord, type Run } from "../lib/api";
import { usePendingApprovals } from "../lib/approvals";
import { useConfigStatus } from "../lib/config-status";
import { readinessItems, stateLabel, stateTone } from "../lib/status";

export function Overview() {
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 5_000 });
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const config = useConfigStatus();
  const pendingApprovals = usePendingApprovals();

  const all = runs.data ?? [];
  const active = all.filter((r) => !["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"].includes(r.state)).length;
  const needsApproval = all.filter((r) => ["AWAITING_PLAN_APPROVAL", "AWAITING_PR_APPROVAL", "NEEDS_CLARIFICATION"].includes(r.state)).length;
  const completed = all.filter((r) => r.state === "COMPLETED").length;
  const failed = all.filter((r) => ["FAILED", "BLOCKED"].includes(r.state)).length;
  const blockers = config.data ? readinessItems(config.data).filter((i) => i.tone === "blocked").length : 0;
  const waitingApprovals = pendingApprovals.data?.length ?? 0;
  const recent = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);

  const cards = [
    { label: "Runs", value: all.length, href: "/runs", icon: "commit" },
    { label: "Active", value: active, href: "/runs", icon: "progress_activity" },
    { label: "Needs approval", value: needsApproval, href: "/runs", icon: "pan_tool" },
    { label: "Completed", value: completed, href: "/runs", icon: "check_circle" },
    { label: "Failed / blocked", value: failed, href: "/runs", icon: "error" },
    { label: "Repositories", value: repos.data?.length ?? 0, href: "/repositories", icon: "folder_open" },
  ];

  return (
    <div>
      <header className="mb-4 flex items-center justify-between border-b border-[#26282E] pb-3">
        <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Overview</h1>
        <Link to="/new" className="flex h-8 items-center gap-1.5 rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">
          <Icon name="add" size={15} /> New Analysis
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((card) => (
          <Link key={card.label} to={card.href} className="rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 hover:border-[#424652]">
            <span className="flex items-center gap-1.5 text-[11px] text-[#8A8F98]"><Icon name={card.icon} size={14} />{card.label}</span>
            <span className="mt-1 block text-[22px] font-semibold text-white">{card.value}</span>
          </Link>
        ))}
      </div>

      {blockers > 0 && (
        <Link to="/settings" className="mt-3 flex items-center gap-2 rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D] hover:bg-[#E5484D]/10">
          <Icon name="warning" size={15} /> {blockers} required action{blockers > 1 ? "s" : ""} — resolve in Settings.
        </Link>
      )}

      {waitingApprovals > 0 && (
        <Link to="/approvals" className="mt-3 flex items-center gap-2 rounded-xl border border-[#E5A158]/30 bg-[#E5A158]/5 px-3 py-2 text-[12px] text-[#E5A158] hover:bg-[#E5A158]/10">
          <Icon name="pan_tool" size={15} /> {waitingApprovals} MCP tool call{waitingApprovals === 1 ? "" : "s"} waiting for a decision.
        </Link>
      )}

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-[#ECEEF0]">Recent runs</h2>
        <Link to="/runs" className="text-[12px] text-[#BDC2FF] hover:underline">View all</Link>
      </div>
      <div className="mt-2 overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
        {recent.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-[#8A8F98]">No runs yet</p>}
        {recent.map((run) => (
          <Link key={run.id} to={`/runs/${run.id}`} className="flex items-center gap-2 border-b border-[#26282E]/60 px-3 py-2 last:border-0 hover:bg-[#1E2026]">
            <span className="min-w-0 flex-1 truncate text-[13px] text-[#ECEEF0]">{run.issueTitle}</span>
            <StatusPill tone={stateTone(run.state)}>{stateLabel(run.state)}</StatusPill>
            <Icon name="chevron_right" size={15} className="text-[#5E626E]" />
          </Link>
        ))}
      </div>
    </div>
  );
}
