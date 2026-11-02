import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { useState } from "react";
import { api, type ConfigStatus } from "../lib/api";
import { readinessItems, type ReadinessTone } from "../lib/status";
import { Skeleton } from "./ui";

export function useConfigStatus() {
  return useQuery({ queryKey: ["config-status"], queryFn: () => api<ConfigStatus>("/config/status"), refetchInterval: 15_000 });
}

const DOT: Record<ReadinessTone, string> = {
  ready: "bg-success",
  attention: "bg-warning",
  blocked: "bg-danger animate-pulse",
  optional: "border border-text-muted bg-transparent",
};

const STATE_COLOR: Record<ReadinessTone, string> = {
  ready: "text-success-light",
  attention: "text-warning",
  blocked: "text-danger",
  optional: "text-text-muted",
};

/** Real per-module footer metadata (from the live config payload — never invented). */
function moduleMeta(id: string, config: ConfigStatus): { left: string; right?: string } | null {
  switch (id) {
    case "planner":
      return { left: `Lead ${config.model.modelId}`, right: `Agents ${config.model.subAgentModelId}` };
    case "dna":
      return config.projectDna.path ? { left: config.projectDna.path.replaceAll("\\", "/").split("/").slice(-2).join("/") } : null;
    case "execution":
      return config.execution.provider === "codebuild"
        ? { left: config.execution.project ?? "", right: config.execution.region }
        : { left: `Mode ${config.sandboxMode}`, right: "Local" };
    case "workflow":
      return { left: `Engine ${config.workflowEngine}` };
    default:
      return null;
  }
}

export function ReadinessPanel({ config }: { config?: ConfigStatus }) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  if (!config) {
    return (
      <div className="space-y-2" aria-label="Loading system readiness">
        <Skeleton className="h-20 w-full" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[86px] w-full" />
        ))}
      </div>
    );
  }
  const items = readinessItems(config);
  const blockedCount = items.filter((i) => i.tone === "blocked").length;
  const readyCount = items.filter((i) => i.tone === "ready").length;

  return (
    <div className="flex flex-col gap-2">
      {/* Header card */}
      <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-text-primary">
            <ClipboardCheck size={15} className="text-accent" aria-hidden /> System Readiness
          </h2>
          {blockedCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-danger">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" aria-hidden />
              {blockedCount} Required Action{blockedCount > 1 ? "s" : ""}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-success-light">
              <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
              Ready
            </span>
          )}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">Continuous infrastructure status prior to dispatching an agentic plan.</p>
      </div>

      {/* Module cards */}
      {items.map((item) => {
        const meta = moduleMeta(item.id, config);
        return (
          <article key={item.id} className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-[#424652]">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${DOT[item.tone]}`} aria-hidden />
                <span className="text-[13px] font-medium text-text-primary">{item.label}</span>
              </span>
              <span className={`font-mono text-[11px] font-medium ${STATE_COLOR[item.tone]}`}>{item.state}</span>
            </div>
            <p className="text-xs leading-relaxed text-text-secondary">{item.explanation}</p>
            {item.recovery && <p className="pt-0.5 text-xs text-accent-soft">{item.recovery}</p>}
            {meta && (
              <div className="flex items-center justify-between gap-2 pt-1 font-mono text-[10px] uppercase tracking-wide text-text-muted">
                <span className="truncate">{meta.left}</span>
                {meta.right && <span className="shrink-0">{meta.right}</span>}
              </div>
            )}
          </article>
        );
      })}

      {/* Diagnostics accordion */}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          aria-expanded={showDiagnostics}
          className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-surface-hover"
        >
          <span className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
            <ChevronRight size={15} className={`text-text-muted transition-transform ${showDiagnostics ? "rotate-90" : ""}`} aria-hidden />
            Technical Diagnostics
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-success-light">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            {readyCount}/{items.length} ready
          </span>
        </button>
        {showDiagnostics && (
          <dl className="border-t border-border bg-background px-4 py-2">
            {[
              ["planner.provider", config.model.provider],
              ["planner.model", config.model.modelId],
              ["subAgents.model", config.model.subAgentModelId],
              ["model.transport", config.model.transport],
              ["model.baseUrl", config.model.baseUrl],
              ["projectDna.path", config.projectDna.path ?? "(unset)"],
              ["execution.provider", config.execution.provider],
              ["execution.project", config.execution.project ?? "(unset)"],
              ["execution.region", config.execution.region],
              ["sandbox.mode", config.sandboxMode],
              ["workflow.engine", config.workflowEngine],
            ].map(([key, value]) => (
              <div key={key} className="flex items-center justify-between border-b border-border/50 py-1.5 font-mono text-[11px] last:border-0">
                <dt className="text-text-secondary">{key}</dt>
                <dd className="text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
