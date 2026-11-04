import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { SectionLabel, StatusPill } from "../components/ui";
import { api, type RepositoryRecord, type Run } from "../lib/api";
import { formatDuration, repositoryLabel, stateLabel, stateTone } from "../lib/status";

const STATUS_FILTERS = ["All states", "Running", "Requires approval", "Completed", "Blocked or failed"] as const;

function matchesFilter(run: Run, filter: (typeof STATUS_FILTERS)[number]): boolean {
  switch (filter) {
    case "All states":
      return true;
    case "Running":
      return !["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "AWAITING_PLAN_APPROVAL", "AWAITING_PR_APPROVAL", "NEEDS_CLARIFICATION", "QUEUED"].includes(run.state);
    case "Requires approval":
      return ["AWAITING_PLAN_APPROVAL", "AWAITING_PR_APPROVAL", "NEEDS_CLARIFICATION"].includes(run.state);
    case "Completed":
      return run.state === "COMPLETED";
    case "Blocked or failed":
      return ["BLOCKED", "FAILED"].includes(run.state);
  }
}

function resultSummary(run: Run): string {
  if (run.state === "COMPLETED") return run.pullRequestUrl ? "Draft PR created" : `${run.changedPaths.length} file${run.changedPaths.length === 1 ? "" : "s"} changed · local patch`;
  if (run.state === "BLOCKED" || run.state === "FAILED") return run.error ?? run.state;
  if (run.verifierReview) return `Verifier: ${run.verifierReview.verdict}`;
  return "—";
}

export function Runs() {
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 5_000 });
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("All states");

  const visible = useMemo(
    () => (runs.data ?? []).filter((r) => matchesFilter(r, filter) && (r.issueTitle.toLowerCase().includes(query.toLowerCase()) || r.id.toLowerCase().includes(query.toLowerCase()))),
    [runs.data, filter, query],
  );

  return (
    <div>
      <header className="mb-3 flex items-center justify-between border-b border-[#26282E] pb-3">
        <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Runs</h1>
        <Link to="/new" className="flex h-8 items-center gap-1.5 rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">
          <Icon name="add" size={15} /> New Analysis
        </Link>
      </header>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SectionLabel index="01">Runs</SectionLabel>
          <span className="font-mono text-[11px] text-[#5E626E]">{runs.data ? `${visible.length}/${runs.data.length}` : "…"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <Icon name="search" size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#5E626E]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search issues or run IDs" aria-label="Search runs" className="h-8 w-52 rounded-md border border-[#2E3038] bg-[#141518] pl-7 pr-2 text-[12px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none" />
          </div>
          <select value={filter} onChange={(e) => setFilter(e.target.value as (typeof STATUS_FILTERS)[number])} aria-label="Filter runs by status" className="h-8 rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[12px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none">
            {STATUS_FILTERS.map((f) => <option key={f}>{f}</option>)}
          </select>
        </div>
      </div>

      {runs.isLoading && <div className="flex flex-col gap-1">{[0,1,2].map(i => <div key={i} className="h-[44px] animate-pulse rounded-lg bg-[#1A1B20]" />)}</div>}
      {runs.isError && (
        <div className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]" role="alert">
          Could not load runs: {(runs.error as Error).message}
          <button className="ml-3 underline" onClick={() => void runs.refetch()}>Retry</button>
        </div>
      )}
      {runs.data && visible.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#2E3038] px-6 py-10 text-center">
          <p className="text-[13px] font-medium text-[#ECEEF0]">{runs.data.length === 0 ? "No runs yet" : "No runs match your filters"}</p>
          {runs.data.length === 0 && <Link to="/new" className="mt-3 inline-flex h-8 items-center rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">Start your first analysis</Link>}
        </div>
      )}
      {visible.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
          <table className="w-full table-fixed text-left">
            <thead><tr className="border-b border-[#26282E]">
              <th className="px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Issue</th>
              <th className="hidden w-[140px] px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E] 2xl:table-cell">Repository</th>
              <th className="w-[120px] px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Status</th>
              <th className="hidden w-[96px] px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E] 2xl:table-cell">Duration</th>
              <th className="hidden px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E] lg:table-cell">Result</th>
              <th className="w-9 px-2 py-2" aria-label="Open run" />
            </tr></thead>
            <tbody>
              {visible.map((run) => (
                <tr key={run.id} className="group border-b border-[#26282E]/60 last:border-0 hover:bg-[#1E2026]">
                  <td className="min-w-0 px-3 py-2">
                    <Link to={`/runs/${run.id}`} className="block truncate text-[13px] font-medium text-[#ECEEF0] group-hover:text-white" title={run.issueTitle}>{run.issueTitle}</Link>
                    <span className="block truncate font-mono text-[10px] text-[#5E626E]">{run.id}</span>
                  </td>
                  <td className="hidden truncate px-3 py-2 font-mono text-[11px] text-[#8A8F98] 2xl:table-cell">{repositoryLabel(run, repos.data ?? [], run.repositoryId)}</td>
                  <td className="px-3 py-2"><StatusPill tone={stateTone(run.state)}>{stateLabel(run.state)}</StatusPill></td>
                  <td className="hidden px-3 py-2 font-mono text-[11px] text-[#8A8F98] 2xl:table-cell">{formatDuration(run.createdAt, run.updatedAt)}</td>
                  <td className="hidden max-w-0 truncate px-3 py-2 text-[12px] text-[#8A8F98] lg:table-cell" title={resultSummary(run)}>{resultSummary(run)}</td>
                  <td className="px-2 py-2 text-right"><Link to={`/runs/${run.id}`} aria-label={`Open run ${run.id}`} className="inline-flex h-6 w-6 items-center justify-center rounded text-[#5E626E] hover:bg-[#282A31] hover:text-[#ECEEF0]"><Icon name="chevron_right" size={16} /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
