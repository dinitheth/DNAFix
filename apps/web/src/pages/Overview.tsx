import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, SectionLabel, Skeleton, StatusPill } from "../components/ui";
import { api, type Run } from "../lib/api";
import { usePendingApprovals } from "../lib/approvals";
import { useConfigStatus } from "../lib/config-status";
import { useVerificationDecisions } from "../lib/queues";
import { briefMessage, formatAgo, formatStarted, readinessHref, readinessItems, stateLabel, stateTone } from "../lib/status";

const STOPPED = ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"];
const WAITING_STATES = ["AWAITING_PLAN_APPROVAL", "AWAITING_PR_APPROVAL", "NEEDS_CLARIFICATION"];

/** A queued decision: what it is, why it is waiting, and where the operator answers it. */
interface Action {
  id: string;
  kind: "Plan" | "Clarification" | "Verification" | "Draft PR" | "MCP tool";
  runId: string;
  title: string;
  detail: string;
}

function ActionRow({ action }: { action: Action }) {
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-[#26282E]/60 px-3 py-2 last:border-0">
      <span className="w-[92px] shrink-0 font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">{action.kind}</span>
      <Link to={`/runs/${action.runId}`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#ECEEF0] hover:text-white" title={action.title}>
        {action.title}
      </Link>
      <span className="hidden min-w-0 max-w-[320px] flex-[2] truncate text-[11px] text-[#8A8F98] xl:block" title={action.detail}>
        {action.detail}
      </span>
      <Link
        to="/approvals"
        className="flex h-7 items-center gap-1 rounded-md border border-[#2E3038] bg-[#1A1B20] px-2 text-[11px] font-medium text-[#ECEEF0] hover:border-[#424652]"
      >
        Decide <Icon name="chevron_right" size={13} />
      </Link>
    </li>
  );
}

export function Overview() {
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 5_000 });
  const config = useConfigStatus();
  const pendingApprovals = usePendingApprovals(true);
  const all = runs.data ?? [];
  const { decisions } = useVerificationDecisions(all);

  const [resumeError, setResumeError] = useState<string | null>(null);
  const [busyResume, setBusyResume] = useState<string | null>(null);
  const resume = useMutation({
    mutationFn: (id: string) => api<Run>(`/runs/${id}/resume`, { method: "POST" }),
    onSuccess: async () => {
      setResumeError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
        queryClient.invalidateQueries({ queryKey: ["run"] }),
        queryClient.invalidateQueries({ queryKey: ["audit"] }),
      ]);
    },
    onError: (err: Error) => setResumeError(err.message),
    onSettled: () => setBusyResume(null),
  });

  const actions: Action[] = [
    ...all
      .filter((run) => run.state === "AWAITING_PLAN_APPROVAL")
      .map((run) => ({
        id: run.id,
        kind: "Plan" as const,
        runId: run.id,
        title: run.issueTitle,
        detail: `${run.plan?.tasks.length ?? 0} task(s) · risk ${run.analysis?.riskLevel ?? "not recorded"}`,
      })),
    ...all
      .filter((run) => run.state === "NEEDS_CLARIFICATION")
      .map((run) => ({
        id: run.id,
        kind: "Clarification" as const,
        runId: run.id,
        title: run.issueTitle,
        detail: run.plan?.unresolvedQuestions[0] ?? run.analysis?.ambiguities[0] ?? "The planner stopped with an open question.",
      })),
    ...decisions.map(({ run, evaluation }) => ({
      id: run.id,
      kind: "Verification" as const,
      runId: run.id,
      title: run.issueTitle,
      detail: evaluation.needsHuman[0] ?? "Verification needs a human decision.",
    })),
    ...all
      .filter((run) => run.state === "AWAITING_PR_APPROVAL")
      .map((run) => ({
        id: run.id,
        kind: "Draft PR" as const,
        runId: run.id,
        title: run.issueTitle,
        detail: `${run.changedPaths.length} file(s) changed · verifier ${run.verifierReview?.verdict ?? "not recorded"}`,
      })),
    // /mcp/approvals?status=pending already returns only open requests.
    ...(pendingApprovals.data ?? []).map((approval) => ({
      id: approval.id,
      kind: "MCP tool" as const,
      runId: approval.runId,
      title: all.find((run) => run.id === approval.runId)?.issueTitle ?? approval.runId,
      detail: `${approval.serverName}/${approval.toolName} · ${approval.summary}`,
    })),
  ];

  const inFlight = all.filter((r) => !STOPPED.includes(r.state) && !WAITING_STATES.includes(r.state));
  const blocked = all.filter((r) => r.state === "BLOCKED");
  const failed = all.filter((r) => r.state === "FAILED");
  const stopped = [...blocked, ...failed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const outcomes = all
    .filter((r) => ["COMPLETED", "FAILED", "CANCELLED"].includes(r.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const blockers = config.data ? readinessItems(config.data).filter((i) => i.tone === "blocked") : [];
  const attention = config.data ? readinessItems(config.data).filter((i) => i.tone === "attention") : [];
  const dnaPath = config.data?.projectDna.path ?? null;

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Overview</h1>
          {runs.data && (
            <span className="font-mono text-[11px] text-[#5E626E]" title={new Date(runs.dataUpdatedAt).toLocaleString()}>
              {formatAgo(new Date(runs.dataUpdatedAt).toISOString())}
            </span>
          )}
        </div>
        <Link to="/new" className="flex h-8 items-center gap-1.5 rounded-md bg-[#5E6AD2] px-3 text-[13px] font-medium text-white hover:bg-[#6875E3]">
          <Icon name="add" size={15} /> New Analysis
        </Link>
      </header>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 flex-col gap-4 flex">
          {runs.data?.length === 0 && (
            <Link to="/setup" className="flex flex-wrap items-center gap-2 rounded-xl border border-[#26282E] bg-[#1A1B20] px-3 py-2 text-[12px] text-[#8A8F98] transition-colors hover:border-[#424652]">
              <Icon name="rocket_launch" size={15} className="text-[#BDC2FF]" />
              No analysis has run on this host yet.
              <span className="font-mono text-[10px] text-[#BDC2FF]">Setup checklist →</span>
            </Link>
          )}
          <section className="flex flex-col">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="01">Needs your decision</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{actions.length}</span>
            </div>
            {runs.isLoading ? (
              <Skeleton className="h-24 rounded-xl" />
            ) : runs.isError ? (
              <div role="alert" className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]">
                Could not load runs: {(runs.error as Error).message}
                <button className="ml-3 underline" onClick={() => void runs.refetch()}>Retry</button>
              </div>
            ) : actions.length === 0 ? (
              <p className="rounded-xl border border-[#26282E] bg-[#1A1B20] px-3 py-2.5 text-[12px] text-[#8A8F98]">
                Nothing is waiting on you.{" "}
                <Link to="/runs" className="text-[#BDC2FF] hover:underline">Watch the runs in flight →</Link>
              </p>
            ) : (
              <ul className="overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
                {actions.slice(0, 8).map((action) => (
                  <ActionRow key={`${action.kind}:${action.id}`} action={action} />
                ))}
                {actions.length > 8 && (
                  <li className="px-3 py-2 text-[11px] text-[#8A8F98]">
                    <Link to="/approvals" className="text-[#BDC2FF] hover:underline">
                      {actions.length - 8} more decision{actions.length - 8 === 1 ? "" : "s"} in the inbox →
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </section>

          <section className="flex flex-col">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="02">In flight</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{inFlight.length}</span>
            </div>
            {inFlight.length === 0 ? (
              <p className="text-[12px] text-[#5E626E]">No stage is executing right now.</p>
            ) : (
              <ul className="overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
                {inFlight.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-center gap-2 border-b border-[#26282E]/60 px-3 py-2 last:border-0">
                    <StatusPill tone={stateTone(run.state)}>{stateLabel(run.state)}</StatusPill>
                    <Link to={`/runs/${run.id}`} className="min-w-0 flex-1 truncate text-[13px] text-[#ECEEF0] hover:text-white" title={run.issueTitle}>
                      {run.issueTitle}
                    </Link>
                    <span className="font-mono text-[10px] text-[#5E626E]" title={`started ${new Date(run.createdAt).toLocaleString()}`}>
                      {formatStarted(run.createdAt)} · updated {formatAgo(run.updatedAt)}
                    </span>
                    <Link to={`/runs/${run.id}`} className="font-mono text-[10px] text-[#BDC2FF] hover:underline">
                      evidence
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="03">Stopped and why</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{stopped.length}</span>
            </div>
            {stopped.length === 0 ? (
              <p className="text-[12px] text-[#5E626E]">No run is blocked or failed.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {stopped.slice(0, 5).map((run) => (
                  <li key={run.id} className="rounded-xl border border-[#26282E] bg-[#1A1B20] px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={stateTone(run.state)}>{stateLabel(run.state)}</StatusPill>
                      <Link to={`/runs/${run.id}`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#ECEEF0] hover:text-white" title={run.issueTitle}>
                        {run.issueTitle}
                      </Link>
                      <span className="font-mono text-[10px] text-[#5E626E]">{formatAgo(run.updatedAt)}</span>
                      {run.state === "BLOCKED" && (
                        <Button
                          variant="secondary"
                          className="h-7 px-2 text-[11px]"
                          loading={busyResume === run.id}
                          onClick={() => {
                            setBusyResume(run.id);
                            resume.mutate(run.id);
                          }}
                        >
                          Resume
                        </Button>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] leading-[14px] text-[#8A8F98]" title={run.error ?? "no reason recorded"}>
                      {run.error ? briefMessage(run.error) : "No reason recorded on this run."}
                    </p>
                  </li>
                ))}
                {stopped.length > 5 && (
                  <li className="text-[11px] text-[#8A8F98]">
                    <Link to="/runs" className="text-[#BDC2FF] hover:underline">
                      {stopped.length - 5} more stopped run{stopped.length - 5 === 1 ? "" : "s"} →
                    </Link>
                  </li>
                )}
              </ul>
            )}
            {resumeError && (
              <p role="alert" className="mt-2 rounded-lg border border-[#E5484D]/30 bg-[#E5484D]/10 px-3 py-1.5 text-[11px] text-[#E5484D]">
                {resumeError}
              </p>
            )}
          </section>
        </div>

        <div className="flex w-full min-w-0 flex-col gap-4 xl:w-[360px]">
          <section className="flex flex-col">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="04">Readiness</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{blockers.length + attention.length}</span>
            </div>
            {config.isError ? (
              <div role="alert" className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]">
                API unreachable, so readiness is unknown.
                <button className="ml-3 underline" onClick={() => void config.refetch()}>Retry</button>
              </div>
            ) : config.isLoading ? (
              <Skeleton className="h-20 rounded-xl" />
            ) : blockers.length + attention.length === 0 ? (
              <p className="rounded-xl border border-[#27A567]/25 bg-[#27A567]/5 px-3 py-2.5 text-[12px] text-[#34D399]">
                All required systems are configured.{" "}
                <Link to="/settings" className="text-[#BDC2FF] hover:underline">Details →</Link>
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {[...blockers, ...attention].map((item) => (
                  <li key={item.id} className={`rounded-xl border px-3 py-2 ${item.tone === "blocked" ? "border-[#E5484D]/30 bg-[#E5484D]/5" : "border-[#E5A158]/30 bg-[#E5A158]/5"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[12px] font-medium ${item.tone === "blocked" ? "text-[#E5484D]" : "text-[#E5A158]"}`}>{item.label}</span>
                      <span className="font-mono text-[10px] uppercase text-[#5E626E]">{item.state}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">{item.explanation}</p>
                    <Link to={readinessHref(item.id)} className="mt-1 inline-block font-mono text-[10px] text-[#BDC2FF] hover:underline">
                      Resolve →
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={dnaPath ?? "Project DNA not resolved"}>
              {config.data
                ? `dna ${dnaPath ?? "not resolved"} · store ${config.data.store?.kind ?? "unknown"} · execution ${config.data.execution.provider}/${config.data.sandboxMode}`
                : "reading configuration"}
            </p>
          </section>

          <section className="flex flex-col">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="05">Latest outcomes</SectionLabel>
              <Link to="/runs" className="font-mono text-[10px] text-[#BDC2FF] hover:underline">all runs</Link>
            </div>
            {outcomes.length === 0 ? (
              <p className="text-[12px] text-[#5E626E]">No run has reached an outcome yet.</p>
            ) : (
              <ul className="overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20]">
                {outcomes.map((run) => (
                  <li key={run.id} className="flex items-center gap-2 border-b border-[#26282E]/60 px-3 py-2 last:border-0">
                    <StatusPill tone={stateTone(run.state)}>{stateLabel(run.state)}</StatusPill>
                    <Link to={`/runs/${run.id}`} className="min-w-0 flex-1 truncate text-[12px] text-[#ECEEF0] hover:text-white" title={run.issueTitle}>
                      {run.issueTitle}
                    </Link>
                    <span className="font-mono text-[10px] text-[#5E626E]">{formatAgo(run.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
