import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ReadinessPanel, useConfigStatus } from "../components/ReadinessPanel";
import { Button, EmptyState, Skeleton, StatusPill } from "../components/ui";
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
  if (run.state === "COMPLETED") {
    return run.pullRequestUrl ? "Draft PR created" : `${run.changedPaths.length} file${run.changedPaths.length === 1 ? "" : "s"} changed · local patch`;
  }
  if (run.state === "BLOCKED" || run.state === "FAILED") return run.error?.slice(0, 90) ?? run.state;
  if (run.verifierReview) return `Verifier: ${run.verifierReview.verdict}`;
  return "—";
}

export function Overview() {
  const location = useLocation();
  useEffect(() => {
    if (location.hash) {
      document.querySelector(location.hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [location.hash]);
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const config = useConfigStatus();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("All states");

  const visible = useMemo(
    () =>
      (runs.data ?? []).filter(
        (r) => matchesFilter(r, filter) && (r.issueTitle.toLowerCase().includes(query.toLowerCase()) || r.id.toLowerCase().includes(query.toLowerCase())),
      ),
    [runs.data, filter, query],
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <div id="runs" className="mb-4 flex scroll-mt-16 flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Runs</h1>
          <span className="text-[13px] text-text-muted">{runs.data ? `${visible.length} of ${runs.data.length}` : ""}</span>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search issues or run IDs"
                aria-label="Search runs"
                className="w-56 rounded-md border border-border bg-surface py-1.5 pl-8 pr-3 text-[13px] placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as (typeof STATUS_FILTERS)[number])}
              aria-label="Filter runs by status"
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] focus:border-accent focus:outline-none"
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <Link to="/new">
              <Button variant="primary">
                <Plus size={15} aria-hidden /> New analysis
              </Button>
            </Link>
          </div>
        </div>

        {runs.isLoading && (
          <div className="space-y-2" aria-label="Loading runs">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {runs.isError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-danger" role="alert">
            Could not load runs: {(runs.error as Error).message}. Check that the API is running, then retry.
            <button className="ml-3 underline" onClick={() => void runs.refetch()}>
              Retry
            </button>
          </div>
        )}
        {runs.data && visible.length === 0 && (
          <EmptyState
            title={runs.data.length === 0 ? "No runs yet" : "No runs match your filters"}
            description={
              runs.data.length === 0
                ? "Start an analysis to investigate an issue, plan a change with Project DNA evidence, and produce a verified patch."
                : "Try a different search term or status filter."
            }
            action={
              runs.data.length === 0 ? (
                <Link to="/new">
                  <Button variant="primary">Start your first analysis</Button>
                </Link>
              ) : undefined
            }
          />
        )}
        {visible.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[680px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-border text-xs text-text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Issue</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Repository</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Started</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Duration</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Result</th>
                  <th scope="col" className="px-4 py-2.5" aria-label="Open run" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((run) => (
                  <tr key={run.id} className="transition-colors hover:bg-surface-hover">
                    <td className="max-w-[260px] px-4 py-2.5">
                      <Link to={`/runs/${run.id}`} className="block truncate font-medium text-text-primary hover:text-accent" title={run.issueTitle}>
                        {run.issueTitle}
                      </Link>
                      <div className="mt-0.5 font-mono text-[10px] text-text-muted">{run.id}</div>
                    </td>
                    <td className="max-w-[180px] truncate px-4 py-3 text-text-secondary">{repositoryLabel(run, repos.data ?? [], run.repositoryId)}</td>
                    <td className="px-4 py-3">
                      <StatusPill tone={stateTone(run.state)}>{stateLabel(run.state)}</StatusPill>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{new Date(run.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatDuration(run.createdAt, run.updatedAt)}</td>
                    <td className="max-w-[190px] truncate px-4 py-2.5 text-text-secondary" title={resultSummary(run)}>
                      {resultSummary(run)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/runs/${run.id}`} aria-label={`Open run ${run.id}`} className="inline-flex rounded p-1 text-text-muted transition-colors hover:text-accent">
                        <ArrowRight size={15} aria-hidden />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2 id="repositories" className="mb-2 mt-8 scroll-mt-16 text-lg font-semibold tracking-tight">Repositories</h2>
        {repos.data && repos.data.length === 0 && <p className="text-[13px] text-text-muted">No repositories yet. A repository is registered when you start an analysis.</p>}
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {(repos.data ?? []).map((repo) => (
            <li key={repo.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="font-medium text-text-primary">{repo.githubOwner ? `${repo.githubOwner}/${repo.githubRepo}` : repo.localPath}</span>
              {repo.lastAnalyzedCommitSha && <span className="font-mono text-[11px] text-text-muted">analysed @ {repo.lastAnalyzedCommitSha.slice(0, 10)}</span>}
              <span className="ml-auto font-mono text-[11px] text-text-muted">{repo.id}</span>
            </li>
          ))}
        </ul>
      </div>

      <aside className="min-w-0">
        <ReadinessPanel config={config.data} />
        {config.isError && (
          <p className="mt-3 text-xs text-danger" role="alert">
            API unreachable: {(config.error as Error).message}
          </p>
        )}
      </aside>
    </div>
  );
}
