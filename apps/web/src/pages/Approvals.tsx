import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { McpApprovalCard } from "../components/McpApprovalCard";
import { Button, EmptyState, SectionLabel, Skeleton, StatusPill, Textarea } from "../components/ui";
import { api, type McpApproval, type RepositoryRecord, type Run, type RunVerification } from "../lib/api";
import { repositoryLabel, stateLabel, stateTone } from "../lib/status";

const MCP_FILTERS = ["Waiting", "Decided", "All"] as const;
type McpFilter = (typeof MCP_FILTERS)[number];

const DECISION_TONE: Record<McpApproval["status"], "success" | "danger" | "warning" | "neutral"> = {
  pending: "warning",
  approved: "success",
  denied: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

function Card({ run, children, actions }: { run: Run; children: ReactNode; actions?: ReactNode }) {
  return (
    <article className="rounded-xl border border-[#26282E] bg-[#1A1B20] p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusPill tone={stateTone(run.state)}>{stateLabel(run.state)}</StatusPill>
          <Link to={`/runs/${run.id}`} className="truncate text-[13px] font-medium text-[#ECEEF0] hover:text-white" title={run.issueTitle}>
            {run.issueTitle}
          </Link>
        </div>
        <div className="flex items-center gap-1.5">{actions}</div>
      </header>
      {children}
    </article>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="mb-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex min-w-0 gap-2">
          <dt className="w-[104px] shrink-0 font-mono text-[10px] uppercase leading-[18px] tracking-[0.03em] text-[#5E626E]">{label}</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[11px] leading-[18px] text-[#8A8F98]" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TaskList({ run }: { run: Run }) {
  const tasks = run.plan?.tasks ?? [];
  if (tasks.length === 0) return <p className="text-[12px] text-[#5E626E]">No tasks recorded in the plan.</p>;
  return (
    <ol className="mb-2 flex flex-col gap-1">
      {tasks.map((task) => (
        <li key={task.id} className="rounded-lg border border-[#26282E] bg-[#141518] px-2 py-1.5">
          <p className="truncate text-[12px] font-medium text-[#ECEEF0]">
            <span className="mr-1.5 font-mono text-[10px] uppercase text-[#5E626E]">{task.id}</span>
            {task.title}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={task.fileScope.join(", ")}>
            {task.fileScope.length ? task.fileScope.join(", ") : "no file scope recorded"}
            {task.dependsOn.length ? ` · depends ${task.dependsOn.join(",")}` : ""}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function Approvals() {
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 5_000 });
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<RepositoryRecord[]>("/repositories") });
  const approvals = useQuery({ queryKey: ["mcp-approvals"], queryFn: () => api<McpApproval[]>("/mcp/approvals"), refetchInterval: 10_000 });
  const [mcpFilter, setMcpFilter] = useState<McpFilter>("Waiting");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [waivers, setWaivers] = useState<Record<string, { checkId: string; reason: string; evidence: string }>>({});

  const post = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
        queryClient.invalidateQueries({ queryKey: ["run"] }),
        queryClient.invalidateQueries({ queryKey: ["audit"] }),
        queryClient.invalidateQueries({ queryKey: ["run-verification"] }),
        queryClient.invalidateQueries({ queryKey: ["mcp-approvals"] }),
      ]);
    },
    onError: (err: Error) => setError(err.message),
    onSettled: () => setBusy(null),
  });

  function act(id: string, path: string, body?: unknown) {
    setBusy(`${path}:${id}`);
    post.mutate({ path, body });
  }

  const all = useMemo(() => runs.data ?? [], [runs.data]);
  const planQueue = all.filter((r) => r.state === "AWAITING_PLAN_APPROVAL");
  const clarificationQueue = all.filter((r) => r.state === "NEEDS_CLARIFICATION");
  const prQueue = all.filter((r) => r.state === "AWAITING_PR_APPROVAL");

  // Verification decisions are computed by the API from recorded evidence, so they are read per run.
  const verificationCandidates = useMemo(
    () => all.filter((r) => r.verificationChecks && r.verificationChecks.length > 0 && r.state !== "COMPLETED").slice(0, 12),
    [all],
  );
  const verifications = useQueries({
    queries: verificationCandidates.map((run) => ({
      queryKey: ["run-verification", run.id],
      queryFn: () => api<RunVerification>(`/runs/${run.id}/verification`),
      refetchInterval: 10_000,
    })),
  });
  const verificationQueue = verificationCandidates
    .map((run, index) => ({ run, data: verifications[index]?.data }))
    .filter((entry) => (entry.data?.evaluation.needsHuman.length ?? 0) > 0);

  const mcpAll = useMemo(() => approvals.data ?? [], [approvals.data]);
  const mcpPending = mcpAll.filter((a) => a.status === "pending");
  const repoLabel = (run: Run) => repositoryLabel(run, repos.data ?? [], run.repositoryId);

  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const mcpShown = mcpFilter === "Waiting" ? mcpPending : mcpFilter === "Decided" ? mcpAll.filter((a) => a.status !== "pending") : mcpAll;
  const mcpVisible = mcpShown.filter((a) => matches(`${a.serverName} ${a.toolName} ${a.runId} ${a.summary}`));

  const waiting = planQueue.length + clarificationQueue.length + verificationQueue.length + prQueue.length + mcpPending.length;

  return (
    <div>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-[20px] font-semibold text-[#ECEEF0]">Approvals</h1>
          {waiting > 0 && <StatusPill tone="warning">{waiting} waiting on you</StatusPill>}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <Icon name="search" size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#5E626E]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search issues, tools or runs"
              aria-label="Search approvals"
              className="h-8 w-52 rounded-md border border-[#2E3038] bg-[#141518] pl-7 pr-2 text-[12px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
            />
          </div>
          <Link
            to="/connectors/docker"
            className="flex h-8 items-center gap-1.5 rounded-md border border-[#2E3038] bg-[#1A1B20] px-3 text-[13px] text-[#ECEEF0] transition-colors hover:border-[#424652]"
          >
            <Icon name="tune" size={15} className="text-[#8A8F98]" /> Tool permissions
          </Link>
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-[#E5484D]/30 bg-[#E5484D]/10 px-3 py-2 text-[12px] text-[#E5484D]">
          {error}
        </div>
      )}

      {runs.isLoading && <Skeleton className="h-40 rounded-xl" />}
      {runs.isError && (
        <div role="alert" className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]">
          Could not load runs: {(runs.error as Error).message}
          <button className="ml-3 underline" onClick={() => void runs.refetch()}>
            Retry
          </button>
        </div>
      )}

      {runs.data && (
        <>
          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="01">Plan approval</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{planQueue.filter((r) => matches(r.issueTitle)).length}</span>
            </div>
            {planQueue.filter((r) => matches(r.issueTitle)).length === 0 ? (
              <p className="text-[12px] text-[#5E626E]">No plan is waiting for approval.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {planQueue
                  .filter((r) => matches(r.issueTitle))
                  .map((run) => (
                    <Card
                      key={run.id}
                      run={run}
                      actions={
                        <>
                          <Button variant="danger-ghost" loading={busy === `/runs/${run.id}/cancel:${run.id}`} onClick={() => act(run.id, `/runs/${run.id}/cancel`)}>
                            Reject
                          </Button>
                          <Button variant="primary" onClick={() => act(run.id, `/runs/${run.id}/approve-plan`)} loading={busy === `/runs/${run.id}/approve-plan:${run.id}`}>
                            Approve plan
                          </Button>
                        </>
                      }
                    >
                      <Facts
                        rows={[
                          ["Repository", repoLabel(run)],
                          ["Risk", run.analysis?.riskLevel ?? "not recorded"],
                          ["Impact", `${run.plan?.predictedAffectedPaths.length ?? 0} predicted path(s)`],
                          ["Snapshot", run.impactSnapshotId ?? "pending"],
                        ]}
                      />
                      <TaskList run={run} />
                      {run.plan?.unresolvedQuestions.length ? (
                        <p className="text-[11px] leading-4 text-[#E5A158]">Open questions: {run.plan.unresolvedQuestions.join(" ")}</p>
                      ) : null}
                    </Card>
                  ))}
              </div>
            )}
          </section>

          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="02">Clarification</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{clarificationQueue.filter((r) => matches(r.issueTitle)).length}</span>
            </div>
            {clarificationQueue.filter((r) => matches(r.issueTitle)).length === 0 ? (
              <p className="text-[12px] text-[#5E626E]">Nothing is waiting for a clarification answer.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {clarificationQueue
                  .filter((r) => matches(r.issueTitle))
                  .map((run) => {
                    const answer = answers[run.id] ?? "";
                    return (
                      <Card
                        key={run.id}
                        run={run}
                        actions={
                          <Button
                            variant="primary"
                            disabled={!answer.trim()}
                            loading={busy === `/runs/${run.id}/clarification:${run.id}`}
                            onClick={() => act(run.id, `/runs/${run.id}/clarification`, { answer: answer.trim() })}
                          >
                            Send answer
                          </Button>
                        }
                      >
                        <ul className="mb-2 flex flex-col gap-1">
                          {(run.plan?.unresolvedQuestions ?? []).map((question, index) => (
                            <li key={index} className="text-[12px] leading-5 text-[#ECEEF0]">
                              {question}
                            </li>
                          ))}
                          {(run.analysis?.ambiguities ?? []).map((gap, index) => (
                            <li key={`a${index}`} className="text-[12px] leading-5 text-[#8A8F98]">
                              Ambiguity: {gap}
                            </li>
                          ))}
                        </ul>
                        <Textarea
                          value={answer}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [run.id]: e.target.value }))}
                          placeholder="Answer the questions above; the planner restarts from this answer."
                          aria-label={`Clarification answer for ${run.issueTitle}`}
                          rows={2}
                          className="w-full rounded-lg border border-[#2E3038] bg-[#141518] px-2 py-1.5 text-[12px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
                        />
                      </Card>
                    );
                  })}
              </div>
            )}
          </section>

          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="03">Verification decisions</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{verificationQueue.length}</span>
            </div>
            {verificationQueue.length === 0 ? (
              <p className="text-[12px] text-[#5E626E]">No verification result is waiting on a human decision.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {verificationQueue
                  .filter((entry) => matches(entry.run.issueTitle))
                  .map(({ run, data }) => {
                    const needsHuman = data?.evaluation.needsHuman ?? [];
                    const waived = new Set((run.verificationWaivers ?? []).map((w) => w.checkId));
                    const waivable = (run.verificationChecks ?? []).filter((check) => check.status === "pre-existing-failure" && !waived.has(check.id));
                    const form = waivers[run.id] ?? { checkId: waivable[0]?.id ?? "", reason: "", evidence: "" };
                    const ready = Boolean(form.checkId && form.reason.trim() && form.evidence.trim().length >= 20);
                    return (
                      <Card key={run.id} run={run}>
                        <Facts
                          rows={[
                            ["Repository", repoLabel(run)],
                            ["Repairs", `${run.repairAttempts} attempt(s)`],
                            ["Verifier", run.verifierReview?.verdict ?? "not recorded"],
                            ["Checks", `${run.verificationChecks?.length ?? 0} recorded`],
                          ]}
                        />
                        <ul className="mb-2 flex flex-col gap-1">
                          {needsHuman.map((gap) => (
                            <li key={gap} className="text-[11px] leading-4 text-[#E5484D]">
                              {gap}
                            </li>
                          ))}
                        </ul>
                        {waivable.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <select
                              value={form.checkId}
                              onChange={(e) => setWaivers((prev) => ({ ...prev, [run.id]: { ...form, checkId: e.target.value } }))}
                              aria-label="Check to waive"
                              className="h-8 rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[12px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
                            >
                              {waivable.map((check) => (
                                <option key={check.id} value={check.id}>
                                  {check.kind} · {check.id}
                                </option>
                              ))}
                            </select>
                            <input
                              value={form.reason}
                              onChange={(e) => setWaivers((prev) => ({ ...prev, [run.id]: { ...form, reason: e.target.value } }))}
                              placeholder="Reason"
                              aria-label="Waiver reason"
                              className="h-8 w-40 rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[12px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
                            />
                            <input
                              value={form.evidence}
                              onChange={(e) => setWaivers((prev) => ({ ...prev, [run.id]: { ...form, evidence: e.target.value } }))}
                              placeholder="Evidence (20+ characters)"
                              aria-label="Waiver evidence"
                              className="h-8 w-64 flex-1 rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[12px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none"
                            />
                            <Button
                              variant="primary"
                              disabled={!ready}
                              loading={busy === `/runs/${run.id}/verification-waivers:${run.id}`}
                              onClick={() => act(run.id, `/runs/${run.id}/verification-waivers`, { checkId: form.checkId, reason: form.reason.trim(), evidence: form.evidence.trim() })}
                            >
                              Waive
                            </Button>
                          </div>
                        ) : (
                          <p className="text-[11px] leading-4 text-[#5E626E]">
                            {waived.size > 0 ? "Every waivable check on this run is already covered by a waiver." : "No pre-existing failure to waive here; this verdict needs a fix or a re-run."}
                          </p>
                        )}
                      </Card>
                    );
                  })}
              </div>
            )}
          </section>

          <section className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <SectionLabel index="04">Draft PR review</SectionLabel>
              <span className="font-mono text-[11px] text-[#5E626E]">{prQueue.filter((r) => matches(r.issueTitle)).length}</span>
            </div>
            {prQueue.filter((r) => matches(r.issueTitle)).length === 0 ? (
              <p className="text-[12px] text-[#5E626E]">No completed run is waiting for PR approval.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {prQueue
                  .filter((r) => matches(r.issueTitle))
                  .map((run) => (
                    <Card
                      key={run.id}
                      run={run}
                      actions={
                        <>
                          <Button variant="danger-ghost" loading={busy === `/runs/${run.id}/cancel:${run.id}`} onClick={() => act(run.id, `/runs/${run.id}/cancel`)}>
                            Reject
                          </Button>
                          <Button variant="primary" loading={busy === `/runs/${run.id}/approve-pr:${run.id}`} onClick={() => act(run.id, `/runs/${run.id}/approve-pr`)}>
                            Approve and open draft PR
                          </Button>
                        </>
                      }
                    >
                      <Facts
                        rows={[
                          ["Repository", repoLabel(run)],
                          ["Changed", `${run.changedPaths.length} file(s)`],
                          ["Verifier", run.verifierReview?.verdict ?? "not recorded"],
                          ["Base", run.baseCommitSha ? run.baseCommitSha.slice(0, 12) : "pending"],
                        ]}
                      />
                      <p className="mb-1 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={run.changedPaths.join(", ")}>
                        {run.changedPaths.slice(0, 6).join(", ")}
                        {run.changedPaths.length > 6 ? ` · +${run.changedPaths.length - 6} more` : ""}
                      </p>
                      <p className="text-[11px] leading-4 text-[#8A8F98]">
                        <Link to={`/runs/${run.id}`} className="text-[#BDC2FF] hover:underline">
                          Review evidence
                        </Link>{" "}
                        · approving opens a draft PR, never a merge.
                      </p>
                    </Card>
                  ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <SectionLabel index="05">MCP tool approvals</SectionLabel>
                <span className="font-mono text-[11px] text-[#5E626E]">
                  {mcpVisible.length === mcpShown.length ? mcpShown.length : `${mcpVisible.length}/${mcpShown.length}`}
                </span>
              </div>
              <select
                value={mcpFilter}
                onChange={(e) => setMcpFilter(e.target.value as McpFilter)}
                aria-label="Filter MCP approvals"
                className="h-8 rounded-md border border-[#2E3038] bg-[#141518] px-2 text-[12px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
              >
                {MCP_FILTERS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </div>

            {approvals.isLoading && <Skeleton className="h-32 rounded-xl" />}
            {approvals.isError && (
              <div role="alert" className="rounded-xl border border-[#E5484D]/30 bg-[#E5484D]/5 px-3 py-2 text-[12px] text-[#E5484D]">
                Could not load approvals: {(approvals.error as Error).message}
                <button className="ml-3 underline" onClick={() => void approvals.refetch()}>
                  Retry
                </button>
              </div>
            )}

            {approvals.data &&
              (mcpVisible.length === 0 ? (
                <EmptyState
                  title={mcpAll.length === 0 ? "No approval requests yet" : mcpFilter === "Waiting" ? "Nothing is waiting on you" : "No approvals match this view"}
                  description={
                    mcpAll.length === 0
                      ? "A run pauses here when it reaches an MCP tool call that needs a Level 2 run grant or a Level 3 per-call approval."
                      : mcpFilter === "Waiting"
                        ? "No run is paused for a permission decision. Settled requests stay under Decided."
                        : "Clear the search or pick another filter."
                  }
                />
              ) : mcpVisible.some((a) => a.status === "pending") ? (
                <div className="flex flex-col gap-2">
                  {mcpVisible.map((a) => (
                    <div key={a.id}>
                      {mcpFilter === "All" && (
                        <div className="mb-1 flex items-center justify-between gap-2 px-0.5">
                          <Link to={`/runs/${a.runId}`} className="truncate text-[11px] text-[#BDC2FF] hover:underline">
                            {all.find((r) => r.id === a.runId)?.issueTitle ?? a.runId}
                          </Link>
                          {a.status !== "pending" && <StatusPill tone={DECISION_TONE[a.status]}>{a.status}</StatusPill>}
                        </div>
                      )}
                      <McpApprovalCard
                        approval={a}
                        busy={busy !== null}
                        runLink={mcpFilter !== "Waiting"}
                        onApprove={() => act(a.runId, `/runs/${a.runId}/mcp/approvals/${a.id}`, { decision: "approve" })}
                        onDeny={() => act(a.runId, `/runs/${a.runId}/mcp/approvals/${a.id}`, { decision: "deny" })}
                      />
                    </div>
                  ))}
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
                      {mcpVisible.map((a) => (
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
                              {all.find((r) => r.id === a.runId)?.issueTitle ?? a.runId}
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
              ))}
          </section>
        </>
      )}
    </div>
  );
}
