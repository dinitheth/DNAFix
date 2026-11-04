import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { McpApprovalCard } from "../components/McpApprovalCard";
import { EmptyState, SectionLabel, Skeleton, StatusPill } from "../components/ui";
import { api, type McpApproval, type Run } from "../lib/api";

const FILTERS = ["Waiting", "Decided", "All"] as const;
type Filter = (typeof FILTERS)[number];

const DECISION_TONE: Record<McpApproval["status"], "success" | "danger" | "warning" | "neutral"> = {
  pending: "warning",
  approved: "success",
  denied: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

export function Approvals() {
  const queryClient = useQueryClient();
  const approvals = useQuery({
    queryKey: ["mcp-approvals"],
    queryFn: () => api<McpApproval[]>("/mcp/approvals"),
    refetchInterval: 10_000,
  });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs") });
  const [filter, setFilter] = useState<Filter>("Waiting");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ approval, decision }: { approval: McpApproval; decision: "approve" | "deny" }) =>
      api<{ approval: McpApproval }>(
        `/runs/${encodeURIComponent(approval.runId)}/mcp/approvals/${encodeURIComponent(approval.id)}`,
        { method: "POST", body: JSON.stringify({ decision }) },
      ),
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mcp-approvals"] }),
        queryClient.invalidateQueries({ queryKey: ["mcp-approvals-pending"] }),
        queryClient.invalidateQueries({ queryKey: ["run-mcp"] }),
      ]);
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => setBusy(null),
  });

  function decide(approval: McpApproval, decision: "approve" | "deny") {
    setBusy(approval.id);
    mutation.mutate({ approval, decision });
  }

  const all = useMemo(() => approvals.data ?? [], [approvals.data]);
  const pending = useMemo(() => all.filter((a) => a.status === "pending"), [all]);
  const titleOf = (runId: string) => runs.data?.find((r) => r.id === runId)?.issueTitle ?? null;

  const q = query.trim().toLowerCase();
  const shown = filter === "Waiting" ? pending : filter === "Decided" ? all.filter((a) => a.status !== "pending") : all;
  const visible = useMemo(
    () => (q ? shown.filter((a) => `${a.serverName} ${a.toolName} ${a.runId} ${a.summary}`.toLowerCase().includes(q)) : shown),
    [shown, q],
  );
  const hasPendingInView = visible.some((a) => a.status === "pending");

  return (
    <div>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Approvals</h1>
          {pending.length > 0 && <StatusPill tone="warning">{pending.length} waiting</StatusPill>}
        </div>
        <Link
          to="/connectors/docker"
          className="flex h-8 items-center gap-1.5 rounded-md border border-[#2E3038] bg-[#1A1B20] px-3 text-[13px] text-[#ECEEF0] transition-colors hover:border-[#424652]"
        >
          <Icon name="tune" size={15} className="text-[#8A8F98]" /> Tool permissions
        </Link>
      </header>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-[#E5484D]/30 bg-[#E5484D]/10 px-3 py-2 text-[12px] text-[#E5484D]">
          {error}
        </div>
      )}

      {approvals.isLoading && <Skeleton className="h-40 rounded-xl" />}
      {approvals.isError && (
        <div role="alert" className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]">
          Could not load approvals: {(approvals.error as Error).message}
          <button className="ml-3 underline" onClick={() => void approvals.refetch()}>
            Retry
          </button>
        </div>
      )}

      {approvals.data && (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SectionLabel index="01">{filter}</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">
                {visible.length === shown.length ? shown.length : `${visible.length}/${shown.length}`}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="relative">
                <Icon name="search" size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#5E626E]" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search tools or runs"
                  aria-label="Search approvals"
                  className="h-8 w-52 rounded-md border border-[#2E3038] bg-[#141518] pl-7 pr-2 text-[12px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
                />
              </div>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
                aria-label="Filter approvals"
                className="h-8 rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[12px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
              >
                {FILTERS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title={
                all.length === 0
                  ? "No approval requests yet"
                  : filter === "Waiting"
                    ? "Nothing is waiting on you"
                    : "No approvals match this view"
              }
              description={
                all.length === 0
                  ? "A run pauses here when it reaches an MCP tool call that needs a Level 2 run grant or a Level 3 per-call approval."
                  : filter === "Waiting"
                    ? "No run is paused for a permission decision. Settled requests stay under Decided."
                    : "Clear the search or pick another filter."
              }
            />
          ) : hasPendingInView ? (
            <div className="flex flex-col gap-2">
              {visible.map((a) => (
                <div key={a.id}>
                  {filter === "All" && (
                    <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                      <Link to={`/runs/${a.runId}`} className="truncate text-[11px] text-[#BDC2FF] hover:underline">
                        {titleOf(a.runId) ?? a.runId}
                      </Link>
                      {a.status !== "pending" && <StatusPill tone={DECISION_TONE[a.status]}>{a.status}</StatusPill>}
                    </div>
                  )}
                  <McpApprovalCard
                    approval={a}
                    busy={busy !== null}
                    runLink={filter !== "Waiting"}
                    onApprove={() => decide(a, "approve")}
                    onDeny={() => decide(a, "deny")}
                  />
                </div>
              ))}
              {filter === "Waiting" && (
                <p className="mt-1 text-[11px] leading-4 text-[#5E626E]">
                  Approving runs the exact call shown; a Level 2 grant also covers matching calls for the rest of that run. Denied calls never execute.
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
              <table className="w-full table-fixed text-left">
                <thead>
                  <tr className="border-b border-[#26282E]">
                    <th className="px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Tool</th>
                    <th className="w-[110px] px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Decision</th>
                    <th className="hidden w-[220px] px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E] lg:table-cell">Run</th>
                    <th className="hidden w-[150px] px-3 py-2 font-mono text-[10px] font-medium uppercase text-[#5E626E] xl:table-cell">Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((a) => (
                    <tr key={a.id} className="border-b border-[#26282E]/60 last:border-b-0">
                      <td className="px-3 py-2">
                        <span className="block truncate font-mono text-[11px] text-[#ECEEF0]">
                          {a.serverName}/{a.toolName}
                        </span>
                        <span className="block truncate text-[11px] text-[#5E626E]">{a.summary}</span>
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill tone={DECISION_TONE[a.status]}>{a.status}</StatusPill>
                      </td>
                      <td className="hidden px-3 py-2 lg:table-cell">
                        <Link to={`/runs/${a.runId}`} className="block truncate text-[12px] text-[#BDC2FF] hover:underline">
                          {titleOf(a.runId) ?? a.runId}
                        </Link>
                      </td>
                      <td className="hidden px-3 py-2 xl:table-cell">
                        <span className="block truncate font-mono text-[10px] text-[#8A8F98]" title={a.decidedAt ?? undefined}>
                          {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : "—"}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-[#5E626E]">{a.decidedBy ?? "system"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
