import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { SectionLabel, StatusPill } from "../components/ui";
import { api, type RepositoryRecord, type Run } from "../lib/api";
import { useConfigStatus } from "../lib/config-status";
import { formatAgo, repositoryLabel, stateLabel, stateTone } from "../lib/status";

const OUTCOMES = ["COMPLETED", "BLOCKED", "FAILED", "CANCELLED"] as const;

/** The newest run for this repository that carries a Project DNA report. */
function dnaRun(runs: Run[]): Run | undefined {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((run) => run.intelligence);
}

function newAnalysisLink(repo: RepositoryRecord): string {
  if (repo.githubOwner && repo.githubRepo) {
    return `/new?source=github&repositoryPath=${encodeURIComponent(`${repo.githubOwner}/${repo.githubRepo}`)}`;
  }
  return `/new?source=local&repositoryPath=${encodeURIComponent(repo.localPath ?? "")}`;
}

export function Repositories() {
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 10_000 });
  const config = useConfigStatus();

  const runsFor = (repoId: string) => (runs.data ?? []).filter((run) => run.repositoryId === repoId);
  const dnaReady = config.data?.projectDna.configured ?? false;

  return (
    <div>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Repositories</h1>
          {repos.data && <span className="font-mono text-[11px] text-[#5E626E]">{repos.data.length}</span>}
        </div>
        <Link to="/new" className="flex h-8 items-center gap-1.5 rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">
          <Icon name="add" size={15} /> New Analysis
        </Link>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#26282E] bg-[#1A1B20] px-3 py-2 text-[12px]">
        <Icon name="account_tree" size={15} className={dnaReady ? "text-[#34D399]" : "text-[#E5484D]"} />
        <span className="font-medium text-[#ECEEF0]">Project DNA</span>
        {config.isLoading && <span className="font-mono text-[11px] text-[#5E626E]">checking…</span>}
        {config.isError && <StatusPill tone="danger">API unreachable</StatusPill>}
        {config.data &&
          (dnaReady ? (
            <>
              <StatusPill tone="success">resolved</StatusPill>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[#8A8F98]" title={config.data.projectDna.path ?? ""}>
                {config.data.projectDna.path}
              </span>
            </>
          ) : (
            <>
              <StatusPill tone="danger">not resolved</StatusPill>
              <span className="text-[#E5484D]">Runs stop before analysis.</span>
              <Link to="/settings#dna" className="font-mono text-[10px] text-[#BDC2FF] hover:underline">
                Fix →
              </Link>
            </>
          ))}
      </div>

      {repos.isLoading && (
        <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-[92px] animate-pulse rounded-xl bg-[#1A1B20]" />)}</div>
      )}
      {repos.isError && (
        <div role="alert" className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]">
          Could not load repositories: {(repos.error as Error).message}
          <button className="ml-3 underline" onClick={() => void repos.refetch()}>Retry</button>
        </div>
      )}
      {repos.data && repos.data.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#2E3038] px-6 py-10 text-center">
          <p className="text-[13px] font-medium text-[#ECEEF0]">No repositories yet</p>
          <p className="mt-1 text-[12px] text-[#8A8F98]">A repository is registered the first time an analysis runs against it.</p>
          <Link to="/new" className="mt-3 inline-flex h-8 items-center rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">Start an analysis</Link>
        </div>
      )}

      {repos.data && repos.data.length > 0 && (
        <div className="flex flex-col gap-2">
          {repos.data.map((repo) => {
            const repoRuns = runsFor(repo.id);
            const latest = [...repoRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            const intelligence = dnaRun(repoRuns)?.intelligence ?? null;
            const analysedAt = dnaRun(repoRuns);
            const counts = OUTCOMES.map((state) => [state, repoRuns.filter((run) => run.state === state).length] as const);
            const waiting = repoRuns.filter((run) => ["AWAITING_PLAN_APPROVAL", "AWAITING_PR_APPROVAL", "NEEDS_CLARIFICATION"].includes(run.state)).length;
            const stale =
              Boolean(repo.lastAnalyzedCommitSha) &&
              Boolean(latest?.baseCommitSha) &&
              repo.lastAnalyzedCommitSha !== latest?.baseCommitSha;

            return (
              <article key={repo.id} className="rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon name={repo.githubOwner ? "cloud" : "folder_open"} size={15} className="text-[#5E626E]" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#ECEEF0]" title={repo.localPath ?? undefined}>
                    {repositoryLabel({ repositoryPath: repo.localPath ?? "" }, [repo], repo.id)}
                  </span>
                  {repo.defaultBranch && <span className="font-mono text-[10px] text-[#5E626E]">{repo.defaultBranch}</span>}
                  <span className="font-mono text-[10px] text-[#5E626E]" title={repo.createdAt}>
                    added {formatAgo(repo.createdAt)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Link to={`/runs?repo=${encodeURIComponent(repo.id)}`} className="flex h-7 items-center rounded-md border border-[#2E3038] bg-[#222329] px-2 text-[11px] text-[#ECEEF0] hover:border-[#424652]">
                      {repoRuns.length} run{repoRuns.length === 1 ? "" : "s"}
                    </Link>
                    <Link to={newAnalysisLink(repo)} className="flex h-7 items-center gap-1 rounded-md bg-[#5E6AD2] px-2 text-[11px] font-medium text-white hover:bg-[#6875E3]">
                      <Icon name="play_arrow" size={13} /> Analyse
                    </Link>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] leading-[14px] text-[#8A8F98]">
                  {counts.map(([state, count]) => (
                    <span key={state} className={count > 0 ? "" : "text-[#5E626E]"}>
                      {count} {state.toLowerCase()}
                    </span>
                  ))}
                  {waiting > 0 && (
                    <Link to="/approvals" className="text-[#E5A158] hover:underline">
                      {waiting} awaiting decision
                    </Link>
                  )}
                  {latest && (
                    <Link to={`/runs/${latest.id}`} className="flex items-center gap-1.5 text-[#BDC2FF] hover:underline">
                      latest: <StatusPill tone={stateTone(latest.state)}>{stateLabel(latest.state)}</StatusPill>
                      <span className="text-[#5E626E]">{formatAgo(latest.updatedAt)}</span>
                    </Link>
                  )}
                </div>

                <div className="mt-2 border-t border-[#26282E]/60 pt-2">
                  <div className="mb-1 flex items-center gap-2">
                    <SectionLabel index="DNA">Structural analysis</SectionLabel>
                    {intelligence && (
                      <span className="font-mono text-[10px] text-[#5E626E]" title={analysedAt?.id}>
                        {intelligence.analysisVersion === null ? "version not reported" : `v${intelligence.analysisVersion}`} · analysed {formatAgo(analysedAt?.updatedAt ?? "")}
                      </span>
                    )}
                  </div>
                  {!intelligence ? (
                    <p className="text-[11px] leading-4 text-[#5E626E]">
                      No Project DNA report recorded for this repository yet. Analysis runs at the start of every analysis.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill tone={intelligence.complete ? "success" : "warning"}>{intelligence.complete ? "complete" : "partial"}</StatusPill>
                        <span className="font-mono text-[10px] text-[#8A8F98]">
                          {intelligence.targets.length} impact target(s) · {intelligence.criticalComponents.length} critical component(s) · {intelligence.risks.length} risk(s)
                        </span>
                        {intelligence.languages.length > 0 && (
                          <span className="font-mono text-[10px] text-[#5E626E]">{intelligence.languages.join(", ")}</span>
                        )}
                        {repo.lastAnalyzedCommitSha && (
                          <span className="font-mono text-[10px] text-[#5E626E]" title={repo.lastAnalyzedCommitSha}>
                            @{repo.lastAnalyzedCommitSha.slice(0, 7)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-[11px] leading-4 text-[#8A8F98]" title={intelligence.architecture.summary}>
                        {intelligence.architecture.summary}
                      </p>
                      {intelligence.architecture.layers.length > 0 && (
                        <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={intelligence.architecture.layers.join(", ")}>
                          {intelligence.architecture.layers.join(" → ")}
                        </p>
                      )}
                      {intelligence.warnings.length > 0 && (
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {intelligence.warnings.slice(0, 3).map((warning, index) => (
                            <li key={index} className="truncate text-[11px] leading-4 text-[#E5A158]" title={warning}>
                              {warning}
                            </li>
                          ))}
                          {intelligence.warnings.length > 3 && (
                            <li className="text-[11px] leading-4 text-[#5E626E]">+{intelligence.warnings.length - 3} more warnings on the run</li>
                          )}
                        </ul>
                      )}
                      {stale && (
                        <p className="mt-1 text-[11px] leading-4 text-[#E5A158]">
                          Snapshot is from {repo.lastAnalyzedCommitSha?.slice(0, 7)}; the newest run started at {latest?.baseCommitSha?.slice(0, 7)}.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
