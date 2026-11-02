import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { Skeleton } from "./ui";
import { api, type ConfigStatus } from "../lib/api";
import { readinessItems, type ReadinessTone } from "../lib/status";

export function useConfigStatus() {
  return useQuery({ queryKey: ["config-status"], queryFn: () => api<ConfigStatus>("/config/status"), refetchInterval: 15_000 });
}

const DOT: Record<ReadinessTone, string> = {
  ready: "bg-[#27A567]",
  attention: "bg-[#E5A158]",
  blocked: "animate-pulse bg-[#E5484D]",
  optional: "border border-[#5E626E] bg-transparent",
};

const STATE_COLOR: Record<ReadinessTone, string> = {
  ready: "text-[#34D399]",
  attention: "text-[#E5A158]",
  blocked: "text-[#E5484D]",
  optional: "text-[#5E626E]",
};

const RECOVERY_HREF: Record<string, string> = {
  planner: "/settings#model",
  dna: "/settings#dna",
  github: "/settings#github",
  execution: "/settings#execution",
  workflow: "/settings#workflow",
};

/** Real per-module footer metadata (from the live config payload — never invented). */
function moduleMeta(id: string, config: ConfigStatus): { left: string; right?: string; rightTone?: "warning" } | null {
  switch (id) {
    case "planner":
      return { left: `Provider ${config.model.provider}`, right: config.model.modelId };
    case "dna":
      return config.projectDna.path
        ? { left: config.projectDna.path.replaceAll("\\", "/").split("/").slice(-2).join("/"), right: "read-only" }
        : null;
    case "github":
      return config.github.configured ? { left: "Draft PRs", right: "Approval required" } : null;
    case "execution":
      return config.execution.provider === "codebuild"
        ? { left: config.execution.project ?? "CodeBuild", right: config.execution.region }
        : { left: `Mode ${config.sandboxMode}`, right: "No isolation", rightTone: "warning" };
    case "workflow":
      return { left: `Engine ${config.workflowEngine}`, right: "SQLite" };
    default:
      return null;
  }
}

function diagnosticRows(config: ConfigStatus): Array<[string, string]> {
  return [
    ["model.provider", config.model.provider],
    ["model.planner", config.model.modelId],
    ["model.subAgent", config.model.subAgentModelId],
    ["model.transport", config.model.transport],
    ["model.endpoint", config.model.baseUrl],
    ["projectDna.path", config.projectDna.path ?? "(unset)"],
    ["execution.provider", config.execution.provider],
    ["execution.region", config.execution.region],
    ["sandbox.mode", config.sandboxMode],
    ["workflow.engine", config.workflowEngine],
    ["github.app", config.github.configured ? "configured" : "not configured"],
  ];
}

export function ReadinessPanel({ config }: { config?: ConfigStatus }) {
  if (!config) {
    return (
      <div className="flex flex-col gap-1" aria-label="Loading system readiness">
        <Skeleton className="h-[86px] w-full rounded-xl" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[96px] w-full" />
        ))}
      </div>
    );
  }

  const items = readinessItems(config);
  const blockedCount = items.filter((i) => i.tone === "blocked").length;
  const diagnostics = diagnosticRows(config);

  return (
    <div className="flex flex-col gap-2">
      {/* Panel header card */}
      <div className="flex flex-col gap-1.5 rounded-xl border border-[#26282E] bg-[#1A1B20] p-2 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Icon name="fact_check" size={16} className="text-[#5E6AD2]" />
            <h2 className="text-[13px] font-medium leading-[18px] tracking-[-0.01em] text-[#ECEEF0]">System Readiness</h2>
          </div>
          {blockedCount > 0 ? (
            <span className="flex items-center gap-1 rounded-full border border-[#E5484D]/30 bg-[#E5484D]/10 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-[18px] text-[#E5484D]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#E5484D]" aria-hidden />
              {blockedCount} Required Action{blockedCount > 1 ? "s" : ""}
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full border border-[#27A567]/20 bg-[#27A567]/10 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-[18px] text-[#34D399]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#27A567]" aria-hidden />
              Ready
            </span>
          )}
        </div>
        <p className="text-[12px] leading-4 text-[#8A8F98]">Continuous infrastructure status prior to dispatching an agentic plan.</p>
      </div>

      {/* Module stack */}
      <div className="flex flex-col gap-1">
        {items.map((item) => {
          const meta = moduleMeta(item.id, config);
          return (
            <article
              key={item.id}
              className="flex flex-col gap-1.5 rounded-lg border border-[#26282E] bg-[#1A1B20] p-2 transition-colors hover:border-[#424652]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[item.tone]}`} aria-hidden />
                  <span className="truncate text-[13px] font-medium leading-[18px] text-[#ECEEF0]">{item.label}</span>
                </div>
                <span className={`shrink-0 font-mono text-[11px] font-medium leading-[14px] ${STATE_COLOR[item.tone]}`}>{item.state}</span>
              </div>
              <p className="text-[12px] leading-4 text-[#8A8F98]">{item.explanation}</p>

              {item.recovery ? (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Link
                    to={RECOVERY_HREF[item.id] ?? "/settings"}
                    className="group flex items-center gap-1 font-mono text-[12px] leading-4 text-[#BDC2FF] hover:text-white"
                  >
                    <span className="group-hover:underline">{item.recovery?.replace(" →", "")}</span>
                    <Icon name="arrow_forward" size={13} className="transition-transform group-hover:translate-x-0.5" />
                  </Link>
                  {meta?.right && <span className="shrink-0 font-mono text-[11px] leading-[14px] text-[#5E626E]">{meta.right}</span>}
                </div>
              ) : meta ? (
                <div className="flex items-center justify-between gap-2 pt-1 font-mono text-[11px] leading-[14px] text-[#5E626E]">
                  <span className="truncate">{meta.left}</span>
                  {meta.right && <span className={`shrink-0 ${meta.rightTone === "warning" ? "text-[#E5A158]" : ""}`}>{meta.right}</span>}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {/* Technical diagnostics */}
      <details className="group overflow-hidden rounded-xl border border-[#26282E] bg-[#1A1B20] transition-all">
        <summary className="flex cursor-pointer list-none select-none items-center justify-between p-2 transition-colors hover:bg-[#1E2026] [&::-webkit-details-marker]:hidden">
          <div className="flex items-center gap-1.5 text-[13px] font-medium leading-[18px] text-[#ECEEF0]">
            <Icon name="chevron_right" size={16} className="text-[#5E626E] transition-transform group-open:rotate-90" />
            <span>Technical Diagnostics ({diagnostics.length} checks)</span>
          </div>
          {blockedCount > 0 ? (
            <span className="flex items-center gap-1 font-mono text-[11px] font-medium leading-[14px] text-[#E5484D]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#E5484D]" aria-hidden />
              DEGRADED
            </span>
          ) : (
            <span className="flex items-center gap-1 font-mono text-[11px] font-medium leading-[14px] text-[#34D399]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#27A567]" aria-hidden />
              PASS
            </span>
          )}
        </summary>
        <div className="flex flex-col gap-1.5 border-t border-[#26282E] bg-[#18191D] px-2 pb-2 pt-1">
          {diagnostics.map(([key, value]) => (
            <div
              key={key}
              className="flex items-center justify-between gap-3 border-b border-[#26282E]/50 py-1 font-mono text-[12px] leading-[18px] last:border-0"
            >
              <span className="shrink-0 text-[#8A8F98]">{key}</span>
              <span className="min-w-0 truncate text-right text-[#ECEEF0]" title={value}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
