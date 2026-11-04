import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Button, SectionLabel, Skeleton, StatusPill } from "../components/ui";
import { McpApprovalCard } from "../components/McpApprovalCard";
import { api, type AuditEvent, type Run, type RunMcpView } from "../lib/api";
import { runStages, stateLabel, stateTone, type StageStatus } from "../lib/status";

const API = "/api/v1";

/**
 * Backend errors can run to several sentences. The first one is what the operator
 * needs at a glance; the rest stays reachable instead of filling the page.
 */
function Alert({ message, prefix }: { message: string; prefix?: string }) {
  const head = message.length > 140 ? (message.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? message.slice(0, 140)).trim() : message;
  const rest = message.slice(head.length).trim();
  return (
    <div className="mb-3 rounded-lg border border-[#E5484D]/25 bg-[#E5484D]/5 px-2 py-1.5 text-[12px] leading-4 text-[#E5484D]" role="alert">
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

function Card({
  index,
  title,
  actions,
  tone = "default",
  children,
}: {
  index: string;
  title: string;
  actions?: ReactNode;
  tone?: "default" | "warning";
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-xl border bg-[#1A1B20] p-3 shadow-sm ${
        tone === "warning" ? "border-[#E5A158]/30" : "border-[#26282E]"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <SectionLabel index={index}>{title}</SectionLabel>
        {actions}
      </div>
      {children}
    </section>
  );
}

function RailCard({
  icon,
  title,
  actions,
  children,
}: {
  icon: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon name={icon} size={15} className="text-[#5E626E]" />
          <h2 className="text-[13px] font-medium leading-[18px] tracking-[-0.01em] text-[#ECEEF0]">{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Row({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-[#26282E]/60 py-1.5 last:border-0">
      <dt className="w-[124px] shrink-0 text-[12px] leading-4 text-[#8A8F98]">{label}</dt>
      <dd className={`min-w-0 flex-1 text-[12px] leading-[18px] text-[#ECEEF0] ${mono ? "break-all font-mono text-[11px]" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

function ProposalList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1 pl-4 text-[12px] leading-4 text-[#8A8F98]">
      {items.map((item) => (
        <li key={item} className="list-disc marker:text-[#5E626E]">
          {item}
        </li>
      ))}
    </ul>
  );
}

function Pipeline({ run }: { run: Run }) {
  const stages = runStages(run);
  const done = stages.filter((s) => s.status === "completed").length;

  return (
    <section className="mb-3 rounded-xl border border-[#26282E] bg-[#1A1B20] p-3 shadow-sm" aria-label="Run pipeline">
      <div className="mb-2 flex items-center justify-between gap-2">
        <SectionLabel index="01">Pipeline</SectionLabel>
        <span className="font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">
          {done}/{stages.length} stages complete
        </span>
      </div>
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#26282E] bg-[#26282E] md:grid-cols-3 xl:grid-cols-6">
        {stages.map((stage) => {
          const meta = STAGE[stage.status];
          const active = stage.status === "running" || stage.status === "requires-approval";
          return (
            <li key={stage.id} className={`px-2 py-2 ${active ? "bg-[#1E2026]" : "bg-[#141518]"}`}>
              <div className="flex items-center gap-1.5">
                <Icon name={meta.icon} size={14} className={meta.className} />
                <span className="truncate font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#8A8F98]" title={stage.label}>
                  {stage.label}
                </span>
              </div>
              <p className={`mt-1 font-mono text-[11px] leading-[14px] ${active ? "text-[#ECEEF0]" : "text-[#5E626E]"}`}>
                {meta.label}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function RunDetail() {
  const { id } = useParams();
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api<Run>(`/runs/${id}`), refetchInterval: 5_000 });
  const audit = useQuery({ queryKey: ["audit", id], queryFn: () => api<AuditEvent[]>(`/audit?runId=${id}`), refetchInterval: 5_000 });
  const mcpView = useQuery({ queryKey: ["run-mcp", id], queryFn: () => api<RunMcpView>(`/runs/${id}/mcp`), refetchInterval: 3_000 });
  const [clarification, setClarification] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API}/runs/${id}/events`);
    source.addEventListener("state", () => {
      void run.refetch();
      void audit.refetch();
      void mcpView.refetch();
    });
    return () => source.close();
  }, [id]);

  async function act(action: string, path: string, body?: unknown) {
    setActionError(null);
    setActing(action);
    try {
      await api(`/runs/${id}${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      await run.refetch();
      await audit.refetch();
      await mcpView.refetch();
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
  const verificationReady = r.verificationChecks || r.diff;
  const pendingMcp = (mcpView.data?.approvals ?? []).filter((a) => a.status === "pending");

  return (
    <div>
      <header className="mb-3 flex flex-col gap-1 border-b border-[#26282E] pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-[#ECEEF0]">{r.issueTitle}</h1>
            <StatusPill tone={stateTone(r.state)}>{stateLabel(r.state)}</StatusPill>
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
        <p className="mt-0.5 truncate font-mono text-[11px] leading-[18px] text-[#5E626E]">
          {r.id} · model {r.modelProvider} · base {r.baseCommitSha ? r.baseCommitSha.slice(0, 12) : "pending"} · snapshot{" "}
          {r.repositorySnapshotId ?? "pending"} · started {new Date(r.createdAt).toLocaleString()}
        </p>
      </header>

      <Pipeline run={r} />

      {pendingMcp.length > 0 && (
        <section className="mb-3 rounded-xl border border-[#E5A158]/40 bg-[#1A1B20] p-3 shadow-sm" aria-label="MCP approval required">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Icon name="pan_tool" size={15} className="text-[#E5A158]" />
              <h2 className="text-[13px] font-medium leading-[18px] text-[#ECEEF0]">MCP approval required</h2>
              <StatusPill tone="warning">{pendingMcp.length} waiting</StatusPill>
            </div>
            <Button variant="danger-ghost" loading={acting === "mcp-cancel"} onClick={() => act("mcp-cancel", "/mcp/cancel")}>
              Deny all & cancel pending
            </Button>
          </div>
          <p className="text-[12px] leading-4 text-[#8A8F98]">
            The agent is paused until you decide. Approval applies only to the exact invocation shown (Level 3) or to a run-scoped grant for this tool (Level 2). Denied calls never execute.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {pendingMcp.map((approval) => (
              <McpApprovalCard
                key={approval.id}
                approval={approval}
                busy={acting !== null}
                onApprove={() => act(`mcp-approve-${approval.id}`, `/mcp/approvals/${approval.id}`, { decision: "approve" })}
                onDeny={() => act(`mcp-deny-${approval.id}`, `/mcp/approvals/${approval.id}`, { decision: "deny" })}
              />
            ))}
          </div>
        </section>
      )}

      {r.error && <Alert message={r.error} />}
      {actionError && <Alert message={actionError} prefix="Action failed: " />}

      {r.state === "NEEDS_CLARIFICATION" && (
        <section className="mb-3 rounded-xl border border-[#E5A158]/30 bg-[#1A1B20] p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-1.5">
            <Icon name="help" size={15} className="text-[#E5A158]" />
            <h2 className="text-[13px] font-medium leading-[18px] text-[#ECEEF0]">Clarification needed</h2>
          </div>
          <div className="rounded-lg border border-[#26282E] bg-[#141518] p-2">
            <ProposalList items={r.plan?.unresolvedQuestions ?? []} />
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
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              variant="primary"
              loading={acting === "clarify"}
              disabled={!clarification.trim()}
              onClick={() => act("clarify", "/clarification", { answer: clarification })}
            >
              Submit clarification
            </Button>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-3 lg:col-span-8">
          {r.intelligence && (
            <Card index="02" title="Project DNA Evidence">
              <dl>
                <Row label="Architecture">{r.intelligence.architecture.summary}</Row>
                <Row label="Layers">{r.intelligence.architecture.layers.join(", ") || "—"}</Row>
                <Row label="Analysis" mono>
                  {r.intelligence.complete ? "Complete" : "Incomplete — see warnings"}
                </Row>
                {r.intelligence.warnings.length > 0 && <Row label="Warnings">{r.intelligence.warnings.join("; ")}</Row>}
                {r.intelligence.criticalComponents.length > 0 && (
                  <Row label="Critical components">{r.intelligence.criticalComponents.map((c) => c.name).join(", ")}</Row>
                )}
              </dl>
              {r.intelligence.targets.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {r.intelligence.targets.map((t) => (
                    <div key={t.targetPath} className="rounded-lg border border-[#26282E] bg-[#141518] p-2">
                      <code className="block truncate font-mono text-[11px] leading-[18px] text-[#BDC2FF]" title={t.targetPath}>
                        {t.targetPath}
                      </code>
                      <p className="mt-0.5 text-[12px] leading-4 text-[#8A8F98]">
                        Direct impact: {t.directImpacted.join(", ") || "none"} · Transitive: {t.transitiveImpacted.join(", ") || "none"}
                        {t.truncations.length > 0 && <span className="text-[#E5A158]"> · truncated ({t.truncations.join(", ")})</span>}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {r.analysis && (
            <Card index="03" title="Issue Analysis">
              <p className="mb-2 text-[12px] leading-4 text-[#8A8F98]">{r.analysis.summary}</p>
              <dl>
                <Row label="Risk level" mono>
                  {r.analysis.riskLevel}
                </Row>
                <Row label="Requirements">{r.analysis.requirements.join("; ")}</Row>
              </dl>
              <h3 className="mb-1 mt-2 font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">Acceptance criteria</h3>
              <ProposalList items={r.analysis.acceptanceCriteria} />
              {r.analysis.ambiguities.length > 0 && (
                <>
                  <h3 className="mb-1 mt-2 font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">Ambiguities</h3>
                  <ProposalList items={r.analysis.ambiguities} />
                </>
              )}
            </Card>
          )}

          {r.plan && (
            <Card
              index="04"
              title="Implementation Plan"
              actions={
                r.state === "AWAITING_PLAN_APPROVAL" ? (
                  <Button variant="primary" loading={acting === "plan"} onClick={() => act("plan", "/approve-plan")}>
                    Approve plan and execute
                  </Button>
                ) : undefined
              }
            >
              <div className="flex flex-col gap-1">
                {r.plan.tasks.map((t) => (
                  <div key={t.id} className="rounded-lg border border-[#26282E] bg-[#141518] p-2">
                    <p className="flex items-baseline gap-1.5 text-[12px] font-medium leading-[18px] text-[#ECEEF0]">
                      <span className="min-w-0">{t.title}</span>
                      <span className="shrink-0 font-mono text-[10px] font-normal text-[#5E626E]">{t.id}</span>
                    </p>
                    <p className="mt-0.5 text-[12px] leading-4 text-[#8A8F98]">{t.description}</p>
                    <p className="mt-1 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]">
                      scope: {t.fileScope.join(", ")}
                      {t.dependsOn.length > 0 && <> · after: {t.dependsOn.join(", ")}</>}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-2 truncate font-mono text-[11px] leading-[18px] text-[#5E626E]" title={r.plan.predictedAffectedPaths.map((p) => `${p.path} (${p.source})`).join(", ")}>
                predicted impact: {r.plan.predictedAffectedPaths.map((p) => `${p.path} (${p.source})`).join(", ") || "—"}
              </p>
            </Card>
          )}

          {r.tasks.length > 0 && (
            <Card index="05" title="Coding Tasks">
              <ul className="flex flex-col">
                {r.tasks.map((t) => (
                  <li key={t.taskId} className="border-b border-[#26282E]/60 py-2 last:border-0 first:pt-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] font-medium leading-[18px] text-[#ECEEF0]">{t.taskId}</span>
                      <StatusPill
                        tone={t.status === "completed" ? "success" : t.status === "failed" ? "danger" : t.status === "running" ? "accent" : "neutral"}
                      >
                        {t.status}
                      </StatusPill>
                      {t.commitSha && (
                        <span className="ml-auto font-mono text-[10px] leading-[14px] text-[#5E626E]">commit {t.commitSha.slice(0, 10)}</span>
                      )}
                    </div>
                    {(t.patchSummary || t.error) && (
                      <p className={`mt-1 text-[12px] leading-4 ${t.error ? "text-[#E5484D]" : "text-[#8A8F98]"}`}>{t.error ?? t.patchSummary}</p>
                    )}
                    {t.changedPaths.length > 0 && (
                      <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={t.changedPaths.join(", ")}>
                        changed: {t.changedPaths.join(", ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2 lg:col-span-4">
          {verificationReady && (
            <RailCard
              icon="verified"
              title="Verification"
              actions={
                r.state === "AWAITING_PR_APPROVAL" ? (
                  <Button variant="primary" loading={acting === "pr"} onClick={() => act("pr", "/approve-pr")}>
                    Create draft PR
                  </Button>
                ) : undefined
              }
            >
              <p className="truncate font-mono text-[11px] leading-[14px] text-[#5E626E]" title={r.baselineChecks.map((c) => `${c.kind} ${c.status}`).join(" · ")}>
                baseline: {r.baselineChecks.map((c) => `${c.kind} ${c.status}`).join(" · ") || "—"}
              </p>
              <ul className="mt-1 flex flex-col">
                {(r.verificationChecks ?? []).map((c) => (
                  <li key={c.kind} className="border-b border-[#26282E]/60 py-1.5 text-[12px] last:border-0">
                    <div className="flex items-center gap-2">
                      <span className="capitalize leading-[18px] text-[#ECEEF0]">{c.kind}</span>
                      <StatusPill tone={c.status === "passed" ? "success" : c.status === "failed" ? "danger" : c.status === "pre-existing-failure" || c.status === "blocked" ? "warning" : "neutral"}>{c.status}</StatusPill>
                    </div>
                    {c.result && (
                      <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]" title={`${c.result.argv.join(" ")} · exit ${c.result.exitCode ?? "—"}`}>
                        {c.result.argv.join(" ")} · exit {c.result.exitCode ?? "—"}
                      </p>
                    )}
                  </li>
                ))}
                {!r.verificationChecks?.length && (
                  <li className="py-1.5 text-[12px] leading-4 text-[#5E626E]">No verification checks have run yet.</li>
                )}
              </ul>

              {r.verifierReview && (
                <div className="mt-2 rounded-lg border border-[#26282E] bg-[#141518] p-2">
                  <p className="text-[12px] leading-[18px] text-[#8A8F98]">
                    Independent verifier:{" "}
                    <strong className={r.verifierReview.verdict === "approve" ? "font-medium text-[#34D399]" : "font-medium text-[#E5A158]"}>
                      {r.verifierReview.verdict}
                    </strong>
                  </p>
                  <p className="mt-0.5 text-[12px] leading-4 text-[#8A8F98]">{r.verifierReview.summary}</p>
                  {r.verifierReview.unintendedChanges.length > 0 && (
                    <p className="mt-1 text-[12px] leading-4 text-[#E5A158]">Unintended changes: {r.verifierReview.unintendedChanges.join("; ")}</p>
                  )}
                  {r.verifierReview.missingTests.length > 0 && (
                    <p className="mt-1 text-[12px] leading-4 text-[#E5A158]">Missing tests: {r.verifierReview.missingTests.join("; ")}</p>
                  )}
                </div>
              )}

              <h3 className="mb-1 mt-2 font-mono text-[10px] uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">Changed files</h3>
              <p className="break-all font-mono text-[11px] leading-[18px] text-[#8A8F98]">{r.changedPaths.join(", ") || "none"}</p>

              {r.pullRequestUrl && (
                <a
                  className="mt-2 flex items-center gap-1 text-[12px] leading-4 text-[#BDC2FF] hover:text-white hover:underline"
                  href={r.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open draft pull request
                  <Icon name="arrow_forward" size={13} />
                </a>
              )}
              {r.state === "COMPLETED" && !r.pullRequestUrl && (
                <p className="mt-2 text-[12px] leading-4 text-[#5E626E]">Completed as a local patch — no GitHub pull request was created.</p>
              )}
              {r.diff && (
                <pre
                  className="mt-2 max-h-[420px] overflow-auto rounded-lg border border-[#26282E] bg-[#141518] p-2 font-mono text-[11px] leading-relaxed text-[#8A8F98]"
                  aria-label="Diff"
                >
                  {r.diff}
                </pre>
              )}
            </RailCard>
          )}

          {(r.remoteExecutions ?? []).length > 0 && (
            <RailCard icon="cloud" title="Cloud Executions">
              <ul className="flex flex-col">
                {(r.remoteExecutions ?? []).map((e, i) => (
                  <li key={i} className="border-b border-[#26282E]/60 py-2 last:border-0 first:pt-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-medium capitalize leading-[18px] text-[#ECEEF0]">{e.phase} verification</span>
                      <StatusPill tone={e.status === "SUCCEEDED" ? "success" : "danger"}>{e.status}</StatusPill>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] leading-[14px] text-[#5E626E]">{e.buildId}</p>
                    <p className="mt-0.5 text-[11px] leading-4 text-[#8A8F98]">
                      containment: {e.containmentStatus ?? "—"} · role state: {e.lifecycleState ?? "—"}
                      {e.deleteNotBefore && <> · deletion eligible after {new Date(e.deleteNotBefore).toLocaleString()}</>}
                    </p>
                  </li>
                ))}
              </ul>
            </RailCard>
          )}

          <RailCard
            icon="hub"
            title="MCP Activity"
            actions={
              <Link to="/connectors/docker" className="text-[11px] text-[#BDC2FF] hover:text-white hover:underline">
                Manage
              </Link>
            }
          >
            {mcpView.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <>
                <p className="text-[11px] leading-4 text-[#5E626E]">
                  {pendingMcp.length > 0 ? `${pendingMcp.length} approval(s) waiting — the run is paused.` : "No MCP approval is waiting."}
                </p>
                <ul className="mt-1 flex flex-col">
                  {(mcpView.data?.activity ?? []).slice(0, 8).map((call) => (
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
                  {(mcpView.data?.activity ?? []).length === 0 && (
                    <li className="py-1.5 text-[12px] leading-4 text-[#5E626E]">No MCP tool calls were made in this run.</li>
                  )}
                </ul>
                {(mcpView.data?.approvals ?? []).length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">
                      Approval history ({(mcpView.data?.approvals ?? []).length})
                    </summary>
                    <ul className="mt-1">
                      {(mcpView.data?.approvals ?? []).map((approval) => (
                        <li key={approval.id} className="border-b border-[#26282E]/60 py-1 text-[11px] leading-4 text-[#8A8F98] last:border-0">
                          <span className="font-mono text-[10px] text-[#ECEEF0]">{approval.serverName}/{approval.toolName}</span> · {approval.kind} · {approval.status}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </RailCard>

          <RailCard icon="history" title="Audit History">
            {audit.isLoading && <Skeleton className="h-20 w-full" />}
            <ul className="max-h-[420px] overflow-auto">
              {(audit.data ?? []).map((e) => (
                <li key={e.id} className="flex gap-2 border-b border-[#26282E]/60 py-1.5 last:border-0 first:pt-0">
                  <span className="shrink-0 font-mono text-[10px] leading-[18px] text-[#5E626E]">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  <span className="min-w-0">
                    <span className="text-[12px] leading-[18px] text-[#8A8F98]">{e.actor}</span>
                    <span className="text-[12px] leading-[18px] text-[#5E626E]"> · </span>
                    <span className="font-mono text-[11px] leading-[18px] text-[#ECEEF0]">{e.action}</span>
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
          </RailCard>
        </div>
      </div>
    </div>
  );
}
