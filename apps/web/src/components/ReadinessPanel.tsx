import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, Info, XCircle } from "lucide-react";
import { useState } from "react";
import { api, type ConfigStatus } from "../lib/api";
import { readinessItems, type ReadinessTone } from "../lib/status";
import { Skeleton } from "./ui";

const TONE_ICON: Record<ReadinessTone, { icon: typeof CheckCircle2; className: string }> = {
  ready: { icon: CheckCircle2, className: "text-success" },
  attention: { icon: AlertTriangle, className: "text-warning" },
  blocked: { icon: XCircle, className: "text-danger" },
  optional: { icon: CircleDashed, className: "text-text-muted" },
};

export function useConfigStatus() {
  return useQuery({ queryKey: ["config-status"], queryFn: () => api<ConfigStatus>("/config/status"), refetchInterval: 15_000 });
}

export function ReadinessPanel({ config, compact = false }: { config?: ConfigStatus; compact?: boolean }) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  if (!config) {
    return (
      <div className="space-y-2" aria-label="Loading system readiness">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  const items = readinessItems(config);
  const blockedCount = items.filter((i) => i.tone === "blocked").length;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-text-primary">System readiness</h2>
        <span className={`text-xs ${blockedCount ? "text-danger" : "text-success"}`}>
          {blockedCount ? `${blockedCount} blocker${blockedCount > 1 ? "s" : ""}` : "Ready to run"}
        </span>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
        {items.map((item) => {
          const { icon: Icon, className } = TONE_ICON[item.tone];
          return (
            <li key={item.id} className="px-3.5 py-3">
              <div className="flex items-center gap-2">
                <Icon size={15} className={className} aria-hidden />
                <span className="text-[13px] font-medium text-text-primary">{item.label}</span>
                <span className="ml-auto text-xs text-text-secondary">{item.state}</span>
              </div>
              {!compact && (
                <>
                  <p className="mt-1 pl-[23px] text-xs leading-relaxed text-text-secondary">{item.explanation}</p>
                  {item.recovery && (
                    <p className="mt-1 flex gap-1.5 pl-[23px] text-xs leading-relaxed text-text-muted">
                      <Info size={12} className="mt-0.5 shrink-0" aria-hidden />
                      <span>{item.recovery}</span>
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => setShowDiagnostics((v) => !v)}
        aria-expanded={showDiagnostics}
        className="mt-2 inline-flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text-primary"
      >
        <ChevronDown size={13} className={`transition-transform ${showDiagnostics ? "rotate-180" : ""}`} aria-hidden />
        Diagnostics
      </button>
      {showDiagnostics && (
        <dl className="mt-2 space-y-1 rounded-lg border border-border bg-background px-3.5 py-3 font-mono text-[11px] leading-relaxed text-text-secondary">
          <div>planner.provider = {config.model.provider}</div>
          <div>planner.model = {config.model.modelId}</div>
          <div>subAgents.model = {config.model.subAgentModelId}</div>
          <div>model.transport = {config.model.transport}</div>
          <div>model.baseUrl = {config.model.baseUrl}</div>
          <div>projectDna.path = {config.projectDna.path ?? "(unset)"}</div>
          <div>execution.provider = {config.execution.provider}</div>
          <div>execution.project = {config.execution.project ?? "(unset)"}</div>
          <div>execution.region = {config.execution.region}</div>
          <div>sandbox.mode = {config.sandboxMode}</div>
          <div>workflow.engine = {config.workflowEngine}</div>
        </dl>
      )}
    </div>
  );
}
