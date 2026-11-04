import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, SectionLabel, Skeleton, StatusPill } from "../components/ui";
import { McpApprovalCard } from "../components/McpApprovalCard";
import { api, type AuditEvent, type Run, type RunMcpView, type RunVerification, type VerificationCheckView, type VerificationWaiverView } from "../lib/api";
import { formatClock, formatSpan, lastStartedStage, runAttempts, runStages, stageTimings, stateLabel, stateTone, type StageStatus } from "../lib/status";

const API = "/api/v1";

/**
 * Backend errors can run to several sentences. The first one is what the operator
 * needs at a glance; the rest stays reachable instead of filling the page.
 */
function Alert({ message, prefix }: { message: string; prefix?: string }) {
  const head = message.length > 140 ? (message.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? message.slice(0, 140)).trim() : message;
  const rest = message.slice(head.length).trim();
  return (
    <div className="rounded-lg border border-[#E5484D]/25 bg-[#E5484D]/5 px-2 py-1.5 text-[12px] leading-4 text-[#E5484D]" role="alert">
      {prefix}
      {head}
      {rest && (
        <details className="mt-1">
          <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-wide text-[#E5484D]/75 hover:text-[#E5484D]">
            Full message
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words text-[#E5484D]/90">{rest}</div>
        </details>
      )}
    </div>
  );
}

const STAGE: Record<StageStatus, { icon: string; className: string; label: string }> = {
  completed: { icon: "check_circle", className: "text-[#34D399]", label: "Complete" },
  running: { icon: "progress_activity", className: "animate-spin text-[#BDC2FF]", label: "Running" },
  pending: { icon: "radio_button_unchecked", className: "text-[#5E626E]", label: "Pending" },
  failed: { icon: "cancel", className: "text-[#E5484D]", label: "Failed" },
  blocked: { icon: "error", className: "text-[#E5484D]", label: "Blocked" },
  "requires-approval": { icon: "pan_tool", className: "text-[#E5A158]", label: "Approval" },
};

/** One of the four bands the page is ordered by: evidence, history, verification, review. */
function Band({ index, title, meta, id, children }: { index: string; title: string; meta?: ReactNode; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#26282E] pb-1.5">
        <SectionLabel index={index}>{title}</SectionLabel>
        {meta && <span className="font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">{meta}</span>}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Panel({
  icon,
  title,
  actions,
  tone = "default",
  children,
}: {
  icon: string;
  title: string;
  actions?: ReactNode;
  tone?: "default" | "warning" | "danger";
  children: ReactNode;
}) {
  const border = tone === "warning" ? "border-[#E5A158]/30" : tone === "danger" ? "border-[#E5484D]/30" : "border-[#26282E]";
  return (
    <section className={`rounded-xl border bg-[#1A1B20] p-3 shadow-sm ${border}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon name={icon} size={15} className={tone === "default" ? "text-[#5E626E]" : tone === "warning" ? "text-[#E5A158]" : "text-[#E5484D]"} />
          <h2 className="text-[13px] font-medium leading-[18px] tracking-[-0.01em] text-[#ECEEF0]">{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <h3 className="mb-1 font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-[#26282E]/60 py-1.5 last:border-0">
      <dt className="w-[124px] shrink-0 text-[12px] leading-4 text-[#8A8F98]">{label}</dt>
      <dd className={`min-w-0 flex-1 text-[12px] leading-[18px] text-[#ECEEF0] ${mono ? "break-all font-mono text-[11px]" : ""}`}>{children}</dd>
    </div>
  );
}

function ProposalList({ items, tone = "muted" }: { items: string[]; tone?: "muted" | "warning" }) {
  return (
    <ul className="flex flex-col gap-1 pl-4 text-[12px] leading-4">
      {items.map((item) => (
        <li key={item} className={`list-disc marker:text-[#5E626E] ${tone === "warning" ? "text-[#E5A158]" : "text-[#8A8F98]"}`}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`break-all font-mono text-[11px] leading-[18px] text-[#8A8F98] ${className}`}>{children}</p>;
}

const CHECK_TONE = (status: string) =>
  status === "passed" ? "success" : status === "failed" ? "danger" : status === "blocked" ? "danger" : status === "pre-existing-failure" || status === "skipped" ? "warning" : "neutral";

function CheckList({ checks, waivers }: { checks: VerificationCheckView[]; waivers: VerificationWaiverView[] }) {
  if (checks.length === 0) return <p className="py-1.5 text-[12px] leading-4 text-[#5E626E]">Nothing has run yet.</p>;
  return (
    <ul className="flex flex-col">
      {checks.map((c) => {
        const waiver = waivers.find((w) => w.checkId === c.id);
        return (
          <li key={c.id} className="border-b border-[#26282E]/60 py-1.5 last:border-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] leading-[18px] text-[#ECEEF0]">{c.kind}</span>
              <StatusPill tone={CHECK_TONE(c.status) as "success" | "danger" | "warning" | "neutral"}>{c.status}</StatusPill>
              {c.result && (
                <span className="font-mono text-[10px] leading-[14px] text-[#5E626E]">
                  exit {c.result.exitCode ?? "—"}
                  {typeof c.result.durationMs === "number" && ` · ${(c.result.durationMs / 1000).toFixed(1)}s`}
                  {c.result.timedOut && " · timed out"}
                  {c.result.sandboxMode && ` · ${c.result.sandboxMode}`}
                </span>
              )}
            </div>
            {c.result && <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={c.result.argv.join(" ")}>{c.result.argv.join(" ")}</p>}
            {c.notes && <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">{c.notes}</p>}
            {c.result && (c.result.stdoutSummary || c.result.stderrSummary) && (
              <details className="mt-1">
                <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E] hover:text-[#8A8F98]">
                  output
                </summary>
                <pre className="mt-1 max-h-[220px] overflow-auto rounded-lg border border-[#26282E] bg-[#141518] p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-[#8A8F98]">
                  {(c.result.stderrSummary || "") + (c.result.stdoutSummary || "")}
                </pre>
              </details>
            )}
            {waiver && (
              <p className="mt-1 text-[11px] leading-4 text-[#E5A158]">
                Waived by {waiver.waivedBy} · {waiver.reason} · evidence: {waiver.evidence}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Pipeline({ run, audit }: { run: Run; audit: AuditEvent[] }) {
  const timings = stageTimings(audit, run);
  const stages = runStages(run, lastStartedStage(timings));
  const attempts = runAttempts(audit);
  const done = stages.filter((s) => s.status === "completed").length;

  return (
    <section className="rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm" aria-label="Run pipeline">
      <div className="mb-2 flex items-center justify-between gap-2">
        <SectionLabel index="01">Pipeline</SectionLabel>
        <span className="font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">
          {done}/{stages.length} stages complete · times from audit{attempts > 1 ? ` · attempt ${attempts}` : ""}
        </span>
      </div>
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#26282E] bg-[#26282E] md:grid-cols-3 xl:grid-cols-6">
        {stages.map((stage) => {
          const meta = STAGE[stage.status];
          const timing = timings[stage.id];
          const span = formatSpan(timing.durationMs);
          const active = stage.status === "running" || stage.status === "requires-approval";
          return (
            <li key={stage.id} className={`px-2 py-2 ${active ? "bg-[#1E2026]" : "bg-[#141518]"}`}>
              <div className="flex items-center gap-1.5">
                <Icon name={meta.icon} size={14} className={meta.className} />
                <span className="truncate font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#8A8F98]" title={stage.label}>
                  {stage.label}
                </span>
              </div>
              <p className={`mt-1 font-mono text-[11px] leading-[14px] ${active ? "text-[#ECEEF0]" : "text-[#5E626E]"}`}>{meta.label}</p>
              {timing.startedAt && (
                <p className="mt-1 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={`${new Date(timing.startedAt).toLocaleString()} · ${timing.events} audit event(s)`}>
                  {formatClock(timing.startedAt)}
                  {span ? ` · ${span}` : active ? ` · ${stage.status === "requires-approval" ? "waiting" : "in progress"}` : ""}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {stages.some((s) => timings[s.id].startedAt) && (
        <table className="mt-2 w-full table-fixed text-left">
          <thead>
            <tr className="border-b border-[#26282E]">
              <th className="w-[150px] px-2 py-1 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Stage</th>
              <th className="w-[80px] px-2 py-1 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Started</th>
              <th className="w-[80px] px-2 py-1 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Completed</th>
              <th className="w-[70px] px-2 py-1 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Duration</th>
              <th className="w-[104px] px-2 py-1 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Result</th>
              <th className="px-2 py-1 font-mono text-[10px] font-medium uppercase text-[#5E626E]">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {stages
              .filter((stage) => timings[stage.id].startedAt)
              .map((stage) => {
                const timing = timings[stage.id];
                const meta = STAGE[stage.status];
                const detail = timing.evidence?.detail ?? "";
                return (
                  <tr key={stage.id} className="border-b border-[#26282E]/60 last:border-0">
                    <td className="truncate px-2 py-1 text-[12px] text-[#ECEEF0]">{stage.label}</td>
                    <td className="px-2 py-1 font-mono text-[11px] text-[#8A8F98]" title={timing.startedAt ? new Date(timing.startedAt).toLocaleString() : undefined}>{formatClock(timing.startedAt)}</td>
                    <td className="px-2 py-1 font-mono text-[11px] text-[#8A8F98]" title={timing.endedAt ? new Date(timing.endedAt).toLocaleString() : undefined}>{formatClock(timing.endedAt)}</td>
                    <td className="px-2 py-1 font-mono text-[11px] text-[#8A8F98]">{formatSpan(timing.durationMs) || "—"}</td>
                    <td className={`px-2 py-1 font-mono text-[11px] ${meta.className}`}>{meta.label}</td>
                    <td className="max-w-0 truncate px-2 py-1 font-mono text-[11px] text-[#5E626E]" title={detail ? `${timing.evidence?.action} ${detail}` : timing.evidence?.action}>
                      {timing.evidence ? `${timing.evidence.action}${detail ? ` · ${detail}` : ""}` : "—"}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function RunDetail() {
  const { id } = useParams();
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api<Run>(`/runs/${id}`), refetchInterval: 5_000 });
  const audit = useQuery({ queryKey: ["audit", id], queryFn: () => api<AuditEvent[]>(`/audit?runId=${id}`), refetchInterval: 5_000 });
  const mcpView = useQuery({ queryKey: ["run-mcp", id], queryFn: () => api<RunMcpView>(`/runs/${id}/mcp`), refetchInterval: 3_000 });
  const verification = useQuery({ queryKey: ["run-verification", id], queryFn: () => api<RunVerification>(`/runs/${id}/verification`), refetchInterval: 5_000 });
  const [clarification, setClarification] = useState("");
  const [waiver, setWaiver] = useState({ checkId: "", reason: "", evidence: "" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API}/runs/${id}/events`);
    source.addEventListener("state", () => {
      void run.refetch();
      void audit.refetch();
      void mcpView.refetch();
      void verification.refetch();
    });
  }, [id]);

  async function act(action: string, path: string, body?: unknown) {
    setActionError(null);
    setActing(action);
    try {
      await api(`/runs/${id}${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      await run.refetch();
      await audit.refetch();
      await mcpView.refetch();
      await verification.refetch();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActing(null);
    }
  }

  if (run.isLoading) {
    return (
      <div className="flex flex-col gap-3" aria-label="Loading run">
        <Skeleton className="h-[64px] w-full" />
        <Skeleton className="h-[96px] w-full" />
        <Skeleton className="h-[280px] w-full" />
      </div>
    );
  }
  if (run.isError) {
    return (
      <div className="rounded-xl border border-[#E5484D]/25 bg-[#E5484D]/5 px-3 py-2 text-[12px] leading-4 text-[#E5484D]" role="alert">
        Could not load this run: {(run.error as Error).message}
        <button className="ml-3 underline" onClick={() => void run.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  const r = run.data!;
  const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(r.state);
  const checks = verification.data?.verificationChecks ?? r.verificationChecks ?? [];
  const waivers = verification.data?.waivers ?? r.verificationWaivers ?? [];
  const evaluation = verification.data?.evaluation;
  const pendingMcp = (mcpView.data?.approvals ?? []).filter((a) => a.status === "pending");
  const unwaived = checks.filter((c) => c.status === "pre-existing-failure" && !waivers.some((w) => w.checkId === c.id));
  const pendingDecisions =
    (r.state === "NEEDS_CLARIFICATION" ? 1 : 0) +
    (r.state === "AWAITING_PLAN_APPROVAL" ? 1 : 0) +
    (r.state === "AWAITING_PR_APPROVAL" ? 1 : 0) +
    pendingMcp.length +
    unwaived.length;
  const decisions = (audit.data ?? []).filter((e) => e.actor === "user");

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1 border-b border-[#26282E] pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-[#ECEEF0]">{r.issueTitle}</h1>
            <StatusPill tone={stateTone(r.state)}>{stateLabel(r.state)}</StatusPill>
            {pendingDecisions > 0 && (
              <a href="#review" className="rounded-full bg-[#E5A158]/10 px-2 py-0.5 font-mono text-[10px] font-medium text-[#E5A158] ring-1 ring-inset ring-[#E5A158]/25 hover:bg-[#E5A158]/20">
                {pendingDecisions} waiting on you
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            {r.state === "BLOCKED" && (
              <Button variant="secondary" loading={acting === "resume"} onClick={() => act("resume", "/resume")}>
                Resume
              </Button>
            )}
            {!terminal && (
              <Button variant="danger-ghost" loading={acting === "cancel"} onClick={() => act("cancel", "/cancel")}>
                Cancel run
              </Button>
            )}
          </div>
        </div>
        <p className="truncate font-mono text-[11px] leading-[18px] text-[#5E626E]">
          {r.id} · {r.modelProvider} · base {r.baseCommitSha ? r.baseCommitSha.slice(0, 12) : "pending"} · snapshot {r.repositorySnapshotId ?? "pending"}
          {r.impactSnapshotId ? ` · impact ${r.impactSnapshotId}` : ""} · started {new Date(r.createdAt).toLocaleString()} · repairs {r.repairAttempts}
        </p>
      </header>

      <Pipeline audit={audit.data ?? []} run={r} />

      {r.error && <Alert message={r.error} />}
      {actionError && <Alert message={actionError} prefix="Action failed: " />}

      <Band index="02" title="Engineering evidence" meta={`${r.changedPaths.length} changed file(s)`}>
        <Panel icon="description" title="Reported problem">
          <p className="whitespace-pre-wrap break-words text-[12px] leading-[18px] text-[#8A8F98]">{r.issueBody}</p>
          <dl className="mt-2">
            <Row label="Repository" mono>
              {r.repositoryPath}
            </Row>
            {(r.issueNumber || r.issueUrl) && (
              <Row label="Source" mono>
                {r.issueUrl ? (
                  <a className="text-[#BDC2FF] hover:text-white hover:underline" href={r.issueUrl} target="_blank" rel="noreferrer">
                    issue #{r.issueNumber}
                  </a>
                ) : (
                  `issue #${r.issueNumber ?? "—"}`
                )}
              </Row>
            )}
            <Row label="Base ref" mono>
              {r.baseRef ?? "HEAD"}
            </Row>
            {(r.state === "NEEDS_CLARIFICATION" || r.clarificationAnswer) && (
              <Row label="Clarification">{r.clarificationAnswer ?? "awaited"}</Row>
            )}
            {r.nominatedTargets && r.nominatedTargets.length > 0 && (
              <Row label="Nominated" mono>
                {r.nominatedTargets.join(", ")}
              </Row>
            )}
          </dl>
        </Panel>

        {r.analysis && (
          <Panel icon="psychology" title="Analysis">
            <p className="text-[12px] leading-4 text-[#8A8F98]">{r.analysis.summary}</p>
            <dl className="mt-2">
              <Row label="Problem">{r.analysis.problemDescription}</Row>
              <Row label="Expected">{r.analysis.expectedBehavior}</Row>
              <Row label="Risk" mono>
                {r.analysis.riskLevel}
              </Row>
            </dl>
            <Sub title="Requirements">
              <ProposalList items={r.analysis.requirements} />
            </Sub>
            <Sub title="Acceptance criteria">
              <ProposalList items={r.analysis.acceptanceCriteria} />
            </Sub>
            {r.analysis.assumptions.length > 0 && (
              <Sub title="Assumptions">
                <ProposalList items={r.analysis.assumptions} tone="warning" />
              </Sub>
            )}
            {r.analysis.ambiguities.length > 0 && (
              <Sub title="Ambiguities">
                <ProposalList items={r.analysis.ambiguities} tone="warning" />
              </Sub>
            )}
          </Panel>
        )}

        {r.plan && (
          <Panel icon="list_alt" title="Plan">
            <div className="flex flex-col gap-2">
              {r.plan.tasks.map((t) => (
                <div key={t.id} className="rounded-lg border border-[#26282E] bg-[#141518] p-2">
                  <p className="flex flex-wrap items-baseline gap-1.5 text-[12px] font-medium leading-[18px] text-[#ECEEF0]">
                    <span className="min-w-0">{t.title}</span>
                    <span className="shrink-0 font-mono text-[10px] font-normal text-[#5E626E]">{t.id}</span>
                  </p>
                  <p className="mt-0.5 text-[12px] leading-4 text-[#8A8F98]">{t.description}</p>
                  <p className="mt-1 break-all font-mono text-[10px] leading-[14px] text-[#5E626E]">
                    scope: {t.fileScope.join(", ")}
                    {t.dependsOn.length > 0 && <> · after: {t.dependsOn.join(", ")}</>}
                  </p>
                  {t.acceptanceCriteria.length > 0 && (
                    <div className="mt-1.5">
                      <ProposalList items={t.acceptanceCriteria} />
                    </div>
                  )}
                  {t.testExpectations.length > 0 && (
                    <p className="mt-1 text-[11px] leading-4 text-[#5E626E]">tests: {t.testExpectations.join("; ")}</p>
                  )}
                </div>
              ))}
            </div>
            <Sub title="Predicted impact">
              <ul className="flex flex-col gap-1">
                {r.plan.predictedAffectedPaths.map((p) => (
                  <li key={`${p.path}-${p.source}`} className="text-[11px] leading-4 text-[#8A8F98]">
                    <code className="break-all font-mono text-[11px] text-[#BDC2FF]">{p.path}</code>
                    <span className="text-[#5E626E]"> · {p.source} · {p.reason}</span>
                    {p.evidence && <span className="text-[#5E626E]"> · {p.evidence}</span>}
                  </li>
                ))}
                {r.plan.predictedAffectedPaths.length === 0 && <li className="text-[12px] leading-4 text-[#5E626E]">None recorded.</li>}
              </ul>
            </Sub>
          </Panel>
        )}

        {r.intelligence && (
          <Panel icon="account_tree" title="Project DNA">
            <dl>
              <Row label="Architecture">{r.intelligence.architecture.summary}</Row>
              <Row label="Layers">{[...r.intelligence.architecture.layers, ...r.intelligence.architecture.patterns].join(", ") || "—"}</Row>
              <Row label="Languages">{r.intelligence.languages.join(", ") || "—"}</Row>
              <Row label="Analysis" mono>
                {r.intelligence.complete ? "complete" : "incomplete"} · v{r.intelligence.analysisVersion ?? "—"} · {r.intelligence.repositoryId}
              </Row>
              {r.intelligence.warnings.length > 0 && <Row label="Warnings">{r.intelligence.warnings.join("; ")}</Row>}
              {r.intelligence.criticalComponents.length > 0 && (
                <Row label="Critical">{r.intelligence.criticalComponents.map((c) => `${c.name}${c.path ? ` (${c.path})` : ""}`).join(", ")}</Row>
              )}
            </dl>
            {r.intelligence.risks.length > 0 && (
              <Sub title="Risks">
                <ul className="flex flex-col gap-1">
                  {r.intelligence.risks.map((risk) => (
                    <li key={`${risk.title}-${risk.path ?? ""}`} className="text-[11px] leading-4 text-[#8A8F98]">
                      <span className="font-mono text-[10px] uppercase text-[#E5A158]">{risk.severity}</span> {risk.title}
                      {risk.path && <span className="font-mono text-[10px] text-[#5E626E]"> · {risk.path}</span>}
                    </li>
                  ))}
                </ul>
              </Sub>
            )}
            <Sub title={`Impact of ${r.intelligence.targets.length} target(s)`}>
              <div className="flex flex-col gap-1">
                {r.intelligence.targets.map((t) => (
                  <div key={t.targetPath} className="rounded-lg border border-[#26282E] bg-[#141518] p-2">
                    <code className="block truncate font-mono text-[11px] leading-[18px] text-[#BDC2FF]" title={t.targetPath}>
                      {t.targetPath}
                    </code>
                    <p className="mt-0.5 text-[12px] leading-4 text-[#8A8F98]">
                      direct: {t.directImpacted.join(", ") || "none"} · transitive: {t.transitiveImpacted.join(", ") || "none"}
                      {t.truncations.length > 0 && <span className="text-[#E5A158]"> · truncated ({t.truncations.join(", ")})</span>}
                    </p>
                    {t.evidenceReasons.length > 0 && <p className="mt-0.5 text-[11px] leading-4 text-[#5E626E]">evidence: {t.evidenceReasons.join("; ")}</p>}
                  </div>
                ))}
                {r.intelligence.targets.length === 0 && <p className="text-[12px] leading-4 text-[#5E626E]">No targets were analysed.</p>}
              </div>
            </Sub>
          </Panel>
        )}

        {r.tasks.length > 0 && (
          <Panel icon="terminal" title="Task execution">
            <ul className="flex flex-col">
              {r.tasks.map((t) => (
                <li key={t.taskId} className="border-b border-[#26282E]/60 py-2 last:border-0 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] font-medium leading-[18px] text-[#ECEEF0]">{t.taskId}</span>
                    <StatusPill tone={t.status === "completed" ? "success" : t.status === "failed" ? "danger" : t.status === "running" ? "accent" : "neutral"}>{t.status}</StatusPill>
                    {t.attempts > 0 && <span className="font-mono text-[10px] text-[#5E626E]">{t.attempts} attempt(s)</span>}
                    {t.commitSha && (
                      <span className="ml-auto font-mono text-[10px] leading-[14px] text-[#5E626E]" title={t.branch ?? undefined}>
                        {t.branch ? `${t.branch} · ` : ""}
                        {t.commitSha.slice(0, 10)}
                      </span>
                    )}
                  </div>
                  {(t.patchSummary || t.error) && (
                    <p className={`mt-1 text-[12px] leading-4 ${t.error ? "text-[#E5484D]" : "text-[#8A8F98]"}`}>{t.error ?? t.patchSummary}</p>
                  )}
                  {t.changedPaths.length > 0 && (
                    <p className="mt-0.5 break-all font-mono text-[10px] leading-[14px] text-[#5E626E]">changed: {t.changedPaths.join(", ")}</p>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {(r.diff || r.changedPaths.length > 0) && (
          <Panel
            icon="diff"
            title="Patch"
            actions={<span className="font-mono text-[10px] text-[#5E626E]">{r.diff.split("\n").length} lines</span>}
          >
            <Mono>{r.changedPaths.join(", ") || "no files recorded"}</Mono>
            {r.diff && (
              <pre className="mt-2 max-h-[460px] overflow-auto rounded-lg border border-[#26282E] bg-[#141518] p-2 font-mono text-[11px] leading-relaxed whitespace-pre text-[#8A8F98]" aria-label="Diff">
                {r.diff}
              </pre>
            )}
          </Panel>
        )}
      </Band>

      <Band
        index="03"
        title="Execution history"
        meta={`${(audit.data ?? []).length} event(s)${(r.effects ?? []).length > 0 ? ` · ${(r.effects ?? []).length} effect(s)` : ""}`}
      >
        {(r.effects ?? []).length > 0 && (
          <Panel icon="bolt" title="External effects">
            <ul className="flex flex-col">
              {(r.effects ?? []).map((effect) => (
                <li key={effect.key} className="border-b border-[#26282E]/60 py-1.5 text-[11px] leading-4 last:border-0 first:pt-0">
                  <span className="font-mono text-[11px] text-[#ECEEF0]">{effect.key}</span>
                  <StatusPill tone={effect.status === "completed" ? "success" : "warning"}>{effect.status}</StatusPill>
                  <span className="ml-1.5 font-mono text-[10px] text-[#5E626E]">
                    {new Date(effect.startedAt).toLocaleTimeString()}
                    {effect.completedAt && ` → ${new Date(effect.completedAt).toLocaleTimeString()}`}
                  </span>
                  {effect.detail && <p className="mt-0.5 break-all font-mono text-[10px] leading-[14px] text-[#5E626E]">{effect.detail}</p>}
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {(r.remoteExecutions ?? []).length > 0 && (
          <Panel icon="cloud" title="Cloud executions">
            <ul className="flex flex-col">
              {(r.remoteExecutions ?? []).map((e, i) => (
                <li key={`${e.phase}-${i}`} className="border-b border-[#26282E]/60 py-2 last:border-0 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-medium capitalize leading-[18px] text-[#ECEEF0]">{e.phase}</span>
                    <span className="font-mono text-[10px] text-[#5E626E]">{e.provider}</span>
                    <StatusPill tone={e.status === "SUCCEEDED" ? "success" : "danger"}>{e.status}</StatusPill>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={e.logsReference ?? undefined}>
                    {e.buildId}
                    {e.summary && <span className="text-[#8A8F98]"> · {e.summary}</span>}
                    {e.logsReference && (
                      <a className="ml-1.5 text-[#BDC2FF] hover:text-white hover:underline" href={e.logsReference} target="_blank" rel="noreferrer">
                        logs
                      </a>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">
                    containment: {e.containmentStatus ?? "—"} · role: {e.lifecycleState ?? "—"}
                    {e.deleteNotBefore && <> · deletable after {new Date(e.deleteNotBefore).toLocaleString()}</>}
                    {e.sourceSha256 && <> · source {e.sourceSha256.slice(0, 12)}</>}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel icon="hub" title="MCP activity">
          {mcpView.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <p className="text-[11px] leading-4 text-[#5E626E]">
                {pendingMcp.length > 0 ? `${pendingMcp.length} call(s) paused on approval.` : "No MCP call is paused on approval."}
              </p>
              <ul className="mt-1 flex flex-col">
                {(mcpView.data?.activity ?? []).slice(0, 12).map((call) => (
                  <li key={call.id} className="border-b border-[#26282E]/60 py-1.5 last:border-0 first:pt-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-mono text-[11px] leading-[18px] text-[#ECEEF0]" title={`${call.serverName}/${call.toolName}`}>
                        {call.serverName}/{call.toolName}
                      </span>
                      <StatusPill tone={call.success ? "success" : call.executed ? "danger" : "neutral"}>
                        {call.success ? "ran" : call.executed ? "failed" : "not run"}
                      </StatusPill>
                      <span className="ml-auto font-mono text-[10px] text-[#5E626E]">{call.agent === "coding-agent" ? "coding" : "verifier"}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={call.error ?? call.resultSummary ?? ""}>
                      {call.error ?? call.resultSummary ?? "No result recorded."}
                    </p>
                  </li>
                ))}
                {(mcpView.data?.activity ?? []).length === 0 && <li className="py-1.5 text-[12px] leading-4 text-[#5E626E]">No MCP tool call was made in this run.</li>}
              </ul>
              {(mcpView.data?.approvals ?? []).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">
                    approval history ({(mcpView.data?.approvals ?? []).length})
                  </summary>
                  <ul className="mt-1">
                    {(mcpView.data?.approvals ?? []).map((approval) => (
                      <li key={approval.id} className="border-b border-[#26282E]/60 py-1 text-[11px] leading-4 text-[#8A8F98] last:border-0">
                        <span className="font-mono text-[10px] text-[#ECEEF0]">
                          {approval.serverName}/{approval.toolName}
                        </span>{" "}
                        · {approval.kind} · {approval.status}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </Panel>

        <Panel icon="history" title="Audit">
          {audit.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <ul className="max-h-[420px] overflow-auto">
              {(audit.data ?? []).map((e) => (
                <li key={e.id} className="flex gap-2 border-b border-[#26282E]/60 py-1.5 last:border-0 first:pt-0">
                  <span className="shrink-0 font-mono text-[10px] leading-[18px] text-[#5E626E]">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  <span className="min-w-0">
                    <span className="text-[12px] leading-[18px] text-[#8A8F98]">{e.actor}</span>
                    <span className="text-[12px] leading-[18px] text-[#5E626E]"> · </span>
                    <span className="font-mono text-[11px] leading-[18px] text-[#ECEEF0]">{e.action}</span>
                    {e.result !== "ok" && e.result !== "info" && (
                      <span className="ml-1 font-mono text-[10px] uppercase" style={{ color: e.result === "error" ? "#E5484D" : "#E5A158" }}>
                        {e.result}
                      </span>
                    )}
                    {e.evidence && (
                      <span className="block truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={e.evidence}>
                        {e.evidence}
                      </span>
                    )}
                  </span>
                </li>
              ))}
              {audit.data?.length === 0 && (
                <li className="flex items-center gap-1.5 py-2 text-[12px] leading-4 text-[#5E626E]">
                  <Icon name="radio_button_unchecked" size={13} />
                  No events yet.
                </li>
              )}
            </ul>
          )}
        </Panel>
      </Band>

      <Band
        index="04"
        title="Verification"
        meta={evaluation ? (evaluation.ok ? "all evidence supports the change" : `${evaluation.repairable.length + evaluation.needsHuman.length} gap(s)`) : "loading"}
      >
        <Panel
          icon="verified"
          title="Checks"
          actions={
            r.pullRequestUrl && (
              <a className="flex items-center gap-1 text-[11px] text-[#BDC2FF] hover:text-white hover:underline" href={r.pullRequestUrl} target="_blank" rel="noreferrer">
                draft PR {r.pullRequestNumber ? `#${r.pullRequestNumber}` : ""}
                <Icon name="arrow_forward" size={13} />
              </a>
            )
          }
        >
          {evaluation && (
            <div className="mb-2 rounded-lg border border-[#26282E] bg-[#141518] p-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={evaluation.ok ? "success" : "danger"}>{evaluation.ok ? "verified" : "not verified"}</StatusPill>
                <span className="font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">
                  {evaluation.regressionEvidence ? "a baseline failure now passes" : "no baseline failure now passes"}
                </span>
              </div>
              {(evaluation.repairable.length > 0 || evaluation.needsHuman.length > 0 || evaluation.notes.length > 0) && (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {evaluation.repairable.map((line) => (
                    <li key={line} className="text-[11px] leading-4 text-[#E5484D]">
                      {line}
                    </li>
                  ))}
                  {evaluation.needsHuman.map((line) => (
                    <li key={line} className="text-[11px] leading-4 text-[#E5A158]">
                      {line}
                    </li>
                  ))}
                  {evaluation.notes.map((line) => (
                    <li key={line} className="text-[11px] leading-4 text-[#5E626E]">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h3 className="mb-1 font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">Before the change</h3>
              <CheckList checks={verification.data?.baselineChecks ?? r.baselineChecks ?? []} waivers={[]} />
            </div>
            <div>
              <h3 className="mb-1 font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">After the change</h3>
              <CheckList checks={checks} waivers={waivers} />
            </div>
          </div>
          {r.state === "COMPLETED" && !r.pullRequestUrl && <p className="mt-2 text-[12px] leading-4 text-[#5E626E]">Completed as a local patch — no pull request was created.</p>}
          {verification.isLoading && !verification.data && <Skeleton className="mt-2 h-16 w-full" />}
        </Panel>

        {r.verifierReview && (
          <Panel icon="rule" title="Independent verifier">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={r.verifierReview.verdict === "approve" ? "success" : r.verifierReview.verdict === "uncertain" ? "warning" : "danger"}>
                {r.verifierReview.verdict}
              </StatusPill>
              <p className="min-w-0 flex-1 text-[12px] leading-4 text-[#8A8F98]">{r.verifierReview.summary}</p>
            </div>
            {r.verifierReview.criteria.length > 0 && (
              <ul className="mt-2 flex flex-col">
                {r.verifierReview.criteria.map((c) => (
                  <li key={c.criterion} className="border-b border-[#26282E]/60 py-1.5 last:border-0 first:pt-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] leading-4 text-[#ECEEF0]">{c.criterion}</span>
                      <StatusPill tone={c.status === "satisfied" ? "success" : c.status === "uncertain" ? "warning" : "danger"}>{c.status}</StatusPill>
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-4 text-[#5E626E]">{c.evidence}</p>
                  </li>
                ))}
              </ul>
            )}
            {r.verifierReview.unintendedChanges.length > 0 && (
              <Sub title="Unintended changes">
                <ProposalList items={r.verifierReview.unintendedChanges} tone="warning" />
              </Sub>
            )}
            {r.verifierReview.missingTests.length > 0 && (
              <Sub title="Missing tests">
                <ProposalList items={r.verifierReview.missingTests} tone="warning" />
              </Sub>
            )}
          </Panel>
        )}
      </Band>

      <Band
        id="review"
        index="05"
        title="Human review"
        meta={pendingDecisions > 0 ? `${pendingDecisions} decision(s) waiting` : "nothing waiting"}
      >
        {pendingMcp.map((approval) => (
          <Panel key={approval.id} icon="pan_tool" title={`MCP approval · ${approval.serverName}/${approval.toolName}`} tone="warning">
            <McpApprovalCard
              approval={approval}
              busy={acting !== null}
              onApprove={() => act(`mcp-approve-${approval.id}`, `/mcp/approvals/${approval.id}`, { decision: "approve" })}
              onDeny={() => act(`mcp-deny-${approval.id}`, `/mcp/approvals/${approval.id}`, { decision: "deny" })}
            />
          </Panel>
        ))}

        {r.state === "NEEDS_CLARIFICATION" && (
          <Panel icon="help" title="Clarification requested" tone="warning">
            <ProposalList items={r.plan?.unresolvedQuestions ?? []} tone="warning" />
            <label htmlFor="clarification" className="mt-3 block text-[12px] leading-4 text-[#8A8F98]">
              Your answer
              <textarea
                id="clarification"
                value={clarification}
                onChange={(e) => setClarification(e.target.value)}
                rows={3}
                className="mt-1 w-full resize-y rounded-md border border-[#2E3038] bg-[#1A1B20] p-2 font-mono text-[12px] leading-[18px] text-[#ECEEF0] placeholder:text-[#5E626E] focus:border-[#5E6AD2] focus:outline-none focus:ring-1 focus:ring-[#5E6AD2]"
              />
            </label>
            <div className="mt-2 flex justify-end">
              <Button variant="primary" loading={acting === "clarify"} disabled={!clarification.trim()} onClick={() => act("clarify", "/clarification", { answer: clarification })}>
                Submit answer
              </Button>
            </div>
          </Panel>
        )}

        {r.state === "AWAITING_PLAN_APPROVAL" && (
          <Panel icon="pan_tool" title="Plan approval" tone="warning">
            <p className="text-[12px] leading-4 text-[#8A8F98]">
              {r.plan?.tasks.length ?? 0} task(s), {r.analysis?.acceptanceCriteria.length ?? 0} acceptance criteria, risk {r.analysis?.riskLevel ?? "—"}. Execution does not start until
              you approve.
            </p>
            {r.plan && r.plan.unresolvedQuestions.length > 0 && (
              <p className="mt-1 text-[12px] leading-4 text-[#E5A158]">Open questions: {r.plan.unresolvedQuestions.join("; ")}</p>
            )}
            <div className="mt-2 flex justify-end">
              <Button variant="primary" loading={acting === "plan"} onClick={() => act("plan", "/approve-plan")}>
                Approve plan and execute
              </Button>
            </div>
          </Panel>
        )}

        {r.state === "AWAITING_PR_APPROVAL" && (
          <Panel icon="merge" title="Draft pull request approval" tone="warning">
            <p className="text-[12px] leading-4 text-[#8A8F98]">
              {r.changedPaths.length} file(s) changed · {checks.filter((c) => c.status === "passed").length}/{checks.length} checks passed
              {unwaived.length > 0 && <span className="text-[#E5A158]"> · {unwaived.length} pre-existing failure(s) still unwaived</span>}
              {r.verifierReview && ` · verifier ${r.verifierReview.verdict}`}
            </p>
            <p className="mt-2 text-[12px] leading-4 text-[#5E626E]">
              Approval creates a draft pull request on {r.baseRef ?? "the default branch"}. DNAFix never merges it.
            </p>
            <div className="mt-2 flex justify-end">
              <Button variant="primary" loading={acting === "pr"} disabled={unwaived.length > 0} onClick={() => act("pr", "/approve-pr")}>
                Create draft PR
              </Button>
            </div>
          </Panel>
        )}

        {unwaived.length > 0 && (
          <Panel icon="warning" title="Pre-existing failures need evidence" tone="warning">
            <p className="text-[12px] leading-4 text-[#8A8F98]">
              These checks already failed at the base commit. A waiver accepts that as-is; it is recorded with your reason and evidence and never counts as a pass.
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {unwaived.map((c) => (
                <li key={c.id} className="font-mono text-[11px] leading-[18px] text-[#E5A158]">
                  {c.id} · {c.result ? `exit ${c.result.exitCode ?? "—"}` : "no result"}
                </li>
              ))}
            </ul>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <label className="block text-[12px] leading-4 text-[#8A8F98]">
                Check
                <select
                  value={waiver.checkId}
                  onChange={(e) => setWaiver((w) => ({ ...w, checkId: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-[#2E3038] bg-[#1A1B20] p-2 font-mono text-[12px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
                >
                  <option value="">Choose a failing check</option>
                  {unwaived.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-[12px] leading-4 text-[#8A8F98]">
                Reason (min 20 characters)
                <textarea
                  value={waiver.reason}
                  onChange={(e) => setWaiver((w) => ({ ...w, reason: e.target.value }))}
                  rows={2}
                  className="mt-1 w-full resize-y rounded-md border border-[#2E3038] bg-[#1A1B20] p-2 text-[12px] leading-[18px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
                />
              </label>
              <label className="block text-[12px] leading-4 text-[#8A8F98] md:col-span-2">
                Evidence (min 20 characters — a CI run, an issue, a commit that already fails this way)
                <textarea
                  value={waiver.evidence}
                  onChange={(e) => setWaiver((w) => ({ ...w, evidence: e.target.value }))}
                  rows={2}
                  className="mt-1 w-full resize-y rounded-md border border-[#2E3038] bg-[#1A1B20] p-2 text-[12px] leading-[18px] text-[#ECEEF0] focus:border-[#5E6AD2] focus:outline-none"
                />
              </label>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                variant="primary"
                loading={acting === "waive"}
                disabled={!waiver.checkId || waiver.reason.trim().length < 20 || waiver.evidence.trim().length < 20}
                onClick={() => {
                  void act("waive", "/verification-waivers", { checkId: waiver.checkId, reason: waiver.reason, evidence: waiver.evidence });
                  setWaiver({ checkId: "", reason: "", evidence: "" });
                }}
              >
                Record waiver
              </Button>
            </div>
          </Panel>
        )}

        {pendingDecisions === 0 && (
          <Panel icon="hourglass_empty" title="Nothing is waiting for you">
            <p className="text-[12px] leading-4 text-[#5E626E]">
              {terminal
                ? "This run is finished. Every approval it needed is in the audit history above."
                : r.state === "BLOCKED"
                  ? "The run is blocked on a missing capability. Fix the cause, then Resume it from the header."
                  : "DNAFix is working, or the run has already passed every gate it can pass without you."}
            </p>
          </Panel>
        )}

        <Panel icon="how_to_reg" title="Decisions recorded">
          <ul className="flex flex-col">
            {decisions.map((e) => (
              <li key={e.id} className="border-b border-[#26282E]/60 py-1.5 text-[11px] leading-4 last:border-0 first:pt-0">
                <span className="font-mono text-[10px] text-[#5E626E]">{new Date(e.createdAt).toLocaleString()}</span>
                <span className="ml-1.5 font-mono text-[#ECEEF0]">{e.action}</span>
                {e.evidence && <span className="ml-1.5 text-[#8A8F98]">{e.evidence.slice(0, 160)}</span>}
              </li>
            ))}
            {decisions.length === 0 && <li className="py-1.5 text-[12px] leading-4 text-[#5E626E]">No human decision has been recorded on this run.</li>}
          </ul>
        </Panel>
      </Band>
    </div>
  );
}
