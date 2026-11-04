import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";
import { useConfigStatus } from "../lib/config-status";
import { api, type McpApproval, type Run } from "../lib/api";
import { readinessItems } from "../lib/status";

interface Notice {
  id: string;
  tone: "blocked" | "attention" | "info";
  title: string;
  message: string;
  href: string;
}

const SEEN_KEY = "dnafix-notifications-seen";

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

const RECOVERY_HREF: Record<string, string> = {
  planner: "/settings#model",
  dna: "/settings#dna",
  github: "/connectors/github",
  execution: "/settings#execution",
  workflow: "/settings#workflow",
};

/** The bell is a summary surface: backend errors can run to several sentences and the run page carries all of them. */
function brief(message: string): string {
  const first = (message.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? message).trim();
  return first.length > 180 ? `${first.slice(0, 179).trimEnd()}…` : first;
}

export function NotificationsBell() {
  const config = useConfigStatus();
  const approvals = useQuery({
    queryKey: ["mcp-approvals-pending"],
    queryFn: () => api<McpApproval[]>("/mcp/approvals?status=pending"),
    refetchInterval: 10_000,
    retry: false,
  });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 15_000 });
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  const panelRef = useRef<HTMLDivElement>(null);

  const notices = useMemo<Notice[]>(() => {
    const list: Notice[] = [];
    if (config.isError) {
      list.push({
        id: "api-offline",
        tone: "blocked",
        title: "API unreachable",
        message: (config.error as Error)?.message ?? "The backend could not be reached.",
        href: "/settings",
      });
    }
    if (config.data) {
      for (const item of readinessItems(config.data)) {
        if (item.tone === "blocked" || item.tone === "attention") {
          list.push({
            id: `readiness-${item.id}`,
            tone: item.tone === "blocked" ? "blocked" : "attention",
            title: `${item.label} — ${item.state}`,
            message: item.recovery ? `${item.explanation} ${item.recovery}` : item.explanation,
            href: RECOVERY_HREF[item.id] ?? "/settings",
          });
        }
      }
    }
    for (const approval of approvals.data ?? []) {
      list.push({
        id: `mcp-${approval.id}`,
        tone: "attention",
        title: `MCP approval: ${approval.serverName}/${approval.toolName}`,
        message: approval.summary,
        href: `/runs/${approval.runId}`,
      });
    }
    const badRuns = (runs.data ?? []).filter((r) => r.state === "FAILED" || r.state === "BLOCKED").slice(0, 5);
    for (const run of badRuns) {
      list.push({
        id: `run-${run.id}`,
        tone: "blocked",
        title: `Run ${run.state.toLowerCase()}: ${run.issueTitle.slice(0, 60)}`,
        message: run.error ? brief(run.error) : "Check the run for details.",
        href: `/runs/${run.id}`,
      });
    }
    return list;
  }, [config.isError, config.error, config.data, approvals.data, runs.data]);

  const unread = notices.filter((n) => !seen.has(n.id));

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  function markAllRead() {
    const next = new Set([...seen, ...notices.map((n) => n.id)]);
    setSeen(next);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-200)));
    } catch {
      /* storage is best-effort */
    }
  }

  const dot = (tone: Notice["tone"]) => (tone === "blocked" ? "bg-[#E5484D]" : tone === "attention" ? "bg-[#E5A158]" : "bg-[#5E6AD2]");

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread.length > 0 ? `${unread.length} unread notifications` : "Notifications"}
        aria-expanded={open}
        className="relative flex h-7 w-7 items-center justify-center rounded-full border border-[#2E3038] bg-[#1A1B20] text-[#8A8F98] transition-colors hover:border-[#424652] hover:text-white"
      >
        <Icon name="notifications" size={16} />
        {unread.length > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#E5484D] px-1 font-mono text-[10px] font-bold text-white">
            {unread.length > 9 ? "9+" : unread.length}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 top-9 z-[90] w-[min(360px,80vw)] overflow-hidden rounded-xl border border-[#363840] bg-[#222328] shadow-[0_4px_20px_0_rgba(0,0,0,0.45)]">
          <div className="flex items-center justify-between border-b border-[#2E3038] px-3 py-2">
            <span className="text-[13px] font-medium text-[#ECEEF0]">Notifications</span>
            <button type="button" onClick={markAllRead} disabled={unread.length === 0} className="text-[11px] text-[#BDC2FF] hover:text-white disabled:opacity-40">
              Mark all read
            </button>
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            {notices.length === 0 && <p className="px-3 py-6 text-center text-[12px] text-[#8A8F98]">All clear — no issues detected.</p>}
            {notices.map((notice) => (
              <Link
                key={notice.id}
                to={notice.href}
                onClick={() => setOpen(false)}
                className={`block border-b border-[#26282E]/60 px-3 py-2 transition-colors last:border-0 hover:bg-[#282A31] ${seen.has(notice.id) ? "opacity-70" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dot(notice.tone)}`} aria-hidden />
                  <span className="truncate text-[12px] font-medium text-[#ECEEF0]">{notice.title}</span>
                </span>
                <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-[#8A8F98]">{notice.message}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
