import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { api, type RepositoryRecord, type Run } from "../lib/api";

export function Repositories() {
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });

  const runCount = (repoId: string) => (runs.data ?? []).filter((r) => r.repositoryId === repoId).length;
  const latestRun = (repoId: string) => (runs.data ?? []).filter((r) => r.repositoryId === repoId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return (
    <div>
      <header className="mb-3 flex items-center justify-between border-b border-[#26282E] pb-3">
        <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Repositories</h1>
        <Link to="/new" className="flex h-8 items-center gap-1.5 rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">
          <Icon name="add" size={15} /> New Analysis
        </Link>
      </header>

      {repos.isLoading && <div className="flex flex-col gap-1">{[0,1,2].map(i => <div key={i} className="h-[44px] animate-pulse rounded-lg bg-[#1A1B20]" />)}</div>}
      {repos.isError && (
        <div className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]" role="alert">
          Could not load repositories: {(repos.error as Error).message}
          <button className="ml-3 underline" onClick={() => void repos.refetch()}>Retry</button>
        </div>
      )}
      {repos.data && repos.data.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#2E3038] px-6 py-10 text-center">
          <p className="text-[13px] font-medium text-[#ECEEF0]">No repositories yet</p>
          <Link to="/new" className="mt-3 inline-flex h-8 items-center rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">Start an analysis</Link>
        </div>
      )}
      {repos.data && repos.data.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
          {repos.data.map((repo) => {
            const latest = latestRun(repo.id);
            return (
              <div key={repo.id} className="flex flex-wrap items-center gap-2 border-b border-[#26282E]/60 px-3 py-2.5 text-[12px] last:border-0">
                <Icon name="folder_open" size={15} className="text-[#5E626E]" />
                <span className="min-w-0 flex-1 truncate font-medium text-[#ECEEF0]">{repo.githubOwner ? `${repo.githubOwner}/${repo.githubRepo}` : repo.localPath}</span>
                {repo.defaultBranch && <span className="font-mono text-[10px] text-[#5E626E]">{repo.defaultBranch}</span>}
                {repo.lastAnalyzedCommitSha && <span className="font-mono text-[10px] text-[#5E626E]">@{repo.lastAnalyzedCommitSha.slice(0, 7)}</span>}
                <span className="font-mono text-[10px] text-[#8A8F98]">{runCount(repo.id)} runs</span>
                {latest ? (
                  <Link to={`/runs/${latest.id}`} className="font-mono text-[10px] text-[#BDC2FF] hover:underline">latest run</Link>
                ) : (
                  <Link to="/new" className="font-mono text-[10px] text-[#BDC2FF] hover:underline">analyse</Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
