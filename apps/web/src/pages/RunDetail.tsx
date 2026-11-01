import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleAlert, CircleDashed, Hand, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, KeyValue, Panel, Skeleton, StatusPill } from "../components/ui";
import { api, type AuditEvent, type Run } from "../lib/api";
import { runStages, stateLabel, stateTone, type StageStatus } from "../lib/status";

const API = "/api/v1";

const STAGE_ICON: Record<StageStatus, { icon: typeof Circle; className: string }> = {
  completed: { icon: CheckCircle2, className: "text-success" },
  running: { icon: Loader2, className: "animate-spin text-accent" },
  pending: { icon: Circle, className: "text-text-muted" },
  failed: { icon: XCircle, className: "text-danger" },
  blocked: { icon: CircleAlert, className: "text-danger" },
  "requires-approval": { icon: Hand, className: "text-warning" },
};

function Timeline({ run }: { run: Run }) {
  const stages = runStages(run);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Run stages">
      {stages.map((stage, i) => {
        const { icon: Icon, className } = STAGE_ICON[stage.status];
        return (
          <li key={stage.id} className="flex items-center gap-1">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                stage.status === "running" || stage.status === "requires-approval" ? "bg-surface-elevated ring-border-strong text-text-primary" : "ring-border text-text-secondary"
              }`}
              title={`${stage.label}: ${stage.status}`}
            >
              <Icon size={13} className={className} aria-hidden />
              {stage.label}
            </span>
            {i < stages.length - 1 && <span className="mx-0.5 h-px w-3 bg-border-strong" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export function RunDetail() {
  const { id } = useParams();
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api<Run>(`/runs/${id}`), refetchInterval: 5_000 });
  const audit = useQuery({ queryKey: ["audit", id], queryFn: () => api<AuditEvent[]>(`/audit?runId=${id}`), refetchInterval: 5_000 });
  const [clarification, setClarification] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`${API}/runs/${id}/events`);
    source.addEventListener("state", () => {
      void run.refetch();
      void audit.refetch();
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
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActing(null);
    }
  }

  if (run.isLoading) {
    return (
      <div className="space-y-3" aria-label="Loading run">
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (run.isError) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-danger" role="alert">
        Could not load this run: {(run.error as Error).message}
        <button className="ml-3 underline" onClick={() => void run.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  const r = run.data!;
  const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(r.state);

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 text-lg font-semibold tracking-tight">{r.issueTitle}</h1>
          <StatusPill tone={stateTone(r.state)}>{stateLabel(r.state)}</StatusPill>
          {!terminal && (
            <Button variant="danger-ghost" className="ml-auto" loading={acting === "cancel"} onClick={() => act("cancel", "/cancel")}>
              Cancel run
            </Button>
          )}
        </div>
        <p className="mt-1 font-mono text-[11px] text-text-muted">
          {r.id} · model {r.modelProvider} · base {r.baseCommitSha ? r.baseCommitSha.slice(0, 12) : "pending"} · snapshot {r.repositorySnapshotId ?? "pending"} · started{" "}
          {new Date(r.createdAt).toLocaleString()}
        </p>
        <div className="mt-3">
          <Timeline run={r} />
        </div>
        {r.error && (
          <p className="mt-3 rounded-md border border-red-500/25 bg-red-500/5 px-3.5 py-2.5 text-[13px] text-danger" role="alert">
            {r.error}
          </p>
        )}
        {actionError && (
          <p className="mt-3 rounded-md border border-red-500/25 bg-red-500/5 px-3.5 py-2.5 text-[13px] text-danger" role="alert">
            Action failed: {actionError}
          </p>
        )}
      </header>

      {r.state === "NEEDS_CLARIFICATION" && (
        <Panel title="Clarification needed" className="border-amber-500/30">
          <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
            {r.plan?.unresolvedQuestions.map((q) => <li key={q}>{q}</li>)}
          </ul>
          <label className="mt-3 block text-[13px] font-medium">
            Your answer
            <textarea
              value={clarification}
              onChange={(e) => setClarification(e.target.value)}
              rows={3}
              className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </label>
          <Button variant="primary" className="mt-3" loading={acting === "clarify"} disabled={!clarification.trim()} onClick={() => act("clarify", "/clarification", { answer: clarification })}>
            Submit clarification
          </Button>
        </Panel>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          {r.intelligence && (
            <Panel title="Project DNA evidence">
              <KeyValue
                rows={[
                  ["Architecture", r.intelligence.architecture.summary],
                  ["Layers", r.intelligence.architecture.layers.join(", ") || "—"],
                  ["Analysis", r.intelligence.complete ? "Complete" : "Incomplete — see warnings"],
                  ...(r.intelligence.warnings.length ? [["Warnings", r.intelligence.warnings.join("; ")] as [string, string]] : []),
                  ...(r.intelligence.criticalComponents.length
                    ? [["Critical components", r.intelligence.criticalComponents.map((c) => c.name).join(", ")] as [string, string]]
                    : []),
                ]}
              />
              {r.intelligence.targets.length > 0 && (
                <div className="mt-3 space-y-2">
                  {r.intelligence.targets.map((t) => (
                    <div key={t.targetPath} className="rounded-md bg-background px-3 py-2 text-[13px]">
                      <code className="font-mono text-xs text-accent">{t.targetPath}</code>
                      <p className="mt-0.5 text-text-secondary">
                        Direct impact: {t.directImpacted.join(", ") || "none"} · Transitive: {t.transitiveImpacted.join(", ") || "none"}
                        {t.truncations.length > 0 && <span className="text-warning"> · truncated ({t.truncations.join(", ")})</span>}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {r.analysis && (
            <Panel title="Issue analysis">
              <p className="text-sm text-text-secondary">{r.analysis.summary}</p>
              <KeyValue
                rows={[
                  ["Risk level", r.analysis.riskLevel],
                  ["Requirements", r.analysis.requirements.join("; ")],
                ]}
              />
              <h4 className="mb-1 mt-3 text-[13px] font-medium">Acceptance criteria</h4>
              <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-text-secondary">
                {r.analysis.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {r.analysis.ambiguities.length > 0 && (
                <>
                  <h4 className="mb-1 mt-3 text-[13px] font-medium">Ambiguities</h4>
                  <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-text-secondary">
                    {r.analysis.ambiguities.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </>
              )}
            </Panel>
          )}

          {r.plan && (
            <Panel
              title="Implementation plan"
              actions={
                r.state === "AWAITING_PLAN_APPROVAL" ? (
                  <Button variant="primary" loading={acting === "plan"} onClick={() => act("plan", "/approve-plan")}>
                    Approve plan and execute
                  </Button>
                ) : undefined
              }
            >
              <div className="space-y-2">
                {r.plan.tasks.map((t) => (
                  <div key={t.id} className="rounded-md bg-background px-3 py-2.5">
                    <p className="text-[13px] font-medium">
                      {t.title} <span className="ml-1 font-mono text-[11px] text-text-muted">{t.id}</span>
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{t.description}</p>
                    <p className="mt-1.5 font-mono text-[11px] text-text-muted">
                      scope: {t.fileScope.join(", ")}
                      {t.dependsOn.length > 0 && <> · after: {t.dependsOn.join(", ")}</>}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-text-muted">
                Predicted impact: {r.plan.predictedAffectedPaths.map((p) => `${p.path} (${p.source})`).join(", ") || "—"}
              </p>
            </Panel>
          )}

          {r.tasks.length > 0 && (
            <Panel title="Coding tasks">
              <ul className="divide-y divide-border">
                {r.tasks.map((t) => (
                  <li key={t.taskId} className="py-2.5 text-[13px]">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.taskId}</span>
                      <StatusPill tone={t.status === "completed" ? "success" : t.status === "failed" ? "danger" : t.status === "running" ? "accent" : "neutral"}>{t.status}</StatusPill>
                      {t.commitSha && <span className="ml-auto font-mono text-[11px] text-text-muted">commit {t.commitSha.slice(0, 10)}</span>}
                    </div>
                    {(t.patchSummary || t.error) && <p className={`mt-1 ${t.error ? "text-danger" : "text-text-secondary"}`}>{t.error ?? t.patchSummary}</p>}
                    {t.changedPaths.length > 0 && <p className="mt-0.5 font-mono text-[11px] text-text-muted">changed: {t.changedPaths.join(", ")}</p>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          {(r.verificationChecks || r.diff) && (
            <Panel
              title="Verification"
              actions={
                r.state === "AWAITING_PR_APPROVAL" ? (
                  <Button variant="primary" loading={acting === "pr"} onClick={() => act("pr", "/approve-pr")}>
                    Approve and create draft PR
                  </Button>
                ) : undefined
              }
            >
              <p className="text-xs text-text-muted">Baseline: {r.baselineChecks.map((c) => `${c.kind} ${c.status}`).join(" · ") || "—"}</p>
              <ul className="mt-2 divide-y divide-border">
                {(r.verificationChecks ?? []).map((c) => (
                  <li key={c.kind} className="flex items-center gap-2 py-2 text-[13px]">
                    <span className="capitalize">{c.kind}</span>
                    <StatusPill tone={c.status === "passed" ? "success" : c.status === "failed" ? "danger" : "neutral"}>{c.status}</StatusPill>
                    {c.result && (
                      <span className="ml-auto font-mono text-[11px] text-text-muted">
                        {c.result.argv.join(" ")} · exit {c.result.exitCode ?? "—"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {r.verifierReview && (
                <div className="mt-3 rounded-md bg-background px-3 py-2.5 text-[13px]">
                  <p>
                    Independent verifier:{" "}
                    <strong className={r.verifierReview.verdict === "approve" ? "text-success" : "text-warning"}>{r.verifierReview.verdict}</strong>
                  </p>
                  <p className="mt-0.5 text-text-secondary">{r.verifierReview.summary}</p>
                  {r.verifierReview.unintendedChanges.length > 0 && <p className="mt-1 text-warning">Unintended changes: {r.verifierReview.unintendedChanges.join("; ")}</p>}
                  {r.verifierReview.missingTests.length > 0 && <p className="mt-1 text-warning">Missing tests: {r.verifierReview.missingTests.join("; ")}</p>}
                </div>
              )}
              <h4 className="mb-1 mt-3 text-[13px] font-medium">Changed files</h4>
              <p className="font-mono text-xs text-text-secondary">{r.changedPaths.join(", ") || "none"}</p>
              {r.pullRequestUrl && (
                <p className="mt-2 text-sm">
                  Draft PR:{" "}
                  <a className="text-accent hover:underline" href={r.pullRequestUrl} target="_blank" rel="noreferrer">
                    {r.pullRequestUrl}
                  </a>
                </p>
              )}
              {r.state === "COMPLETED" && !r.pullRequestUrl && <p className="mt-2 text-xs text-text-muted">Completed as a local patch — no GitHub pull request was created.</p>}
              {r.diff && (
                <pre className="scroll-thin mt-3 max-h-[480px] overflow-auto rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed text-text-secondary" aria-label="Diff">
                  {r.diff}
                </pre>
              )}
            </Panel>
          )}

          {(r.remoteExecutions ?? []).length > 0 && (
            <Panel title="Cloud executions">
              <ul className="divide-y divide-border">
                {(r.remoteExecutions ?? []).map((e, i) => (
                  <li key={i} className="py-2.5 text-[13px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium capitalize">{e.phase} verification</span>
                      <StatusPill tone={e.status === "SUCCEEDED" ? "success" : "danger"}>{e.status}</StatusPill>
                      <span className="ml-auto font-mono text-[11px] text-text-muted">{e.buildId}</span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-text-muted">
                      containment: {e.containmentStatus ?? "—"} · role state: {e.lifecycleState ?? "—"}
                      {e.deleteNotBefore && <> · deletion eligible after {new Date(e.deleteNotBefore).toLocaleString()}</>}
                    </p>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Audit history">
            {audit.isLoading && <Skeleton className="h-20 w-full" />}
            <ul className="scroll-thin max-h-[380px] space-y-1.5 overflow-auto text-xs">
              {(audit.data ?? []).map((e) => (
                <li key={e.id} className="flex gap-2 leading-relaxed">
                  <span className="shrink-0 font-mono text-[11px] text-text-muted">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  <span>
                    <span className="text-text-secondary">{e.actor}</span> · <span className="font-medium text-text-primary">{e.action}</span>
                    {e.evidence && <span className="block truncate text-text-muted" title={e.evidence}>{e.evidence}</span>}
                  </span>
                </li>
              ))}
              {audit.data?.length === 0 && (
                <li className="flex items-center gap-2 text-text-muted">
                  <CircleDashed size={13} aria-hidden /> No events yet.
                </li>
              )}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
