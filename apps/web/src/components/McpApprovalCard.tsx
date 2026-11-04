import { Link } from "react-router-dom";
import { Button, StatusPill } from "./ui";
import type { McpApproval } from "../lib/api";

/**
 * One pending MCP permission decision. The same card serves the run page and the
 * Approvals inbox, so a decision always shows the same evidence.
 */
export function McpApprovalCard({
  approval,
  busy,
  onApprove,
  onDeny,
  runLink,
}: {
  approval: McpApproval;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
  runLink?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[#2E3038] bg-[#141518] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] leading-[18px] text-[#ECEEF0]">
          {approval.serverName}/{approval.toolName}
        </span>
        <div className="flex items-center gap-1.5">
          <StatusPill tone={approval.kind === "per-call" ? "danger" : "warning"}>
            {approval.kind === "per-call" ? "Level 3 · per-call" : "Level 2 · run grant"}
          </StatusPill>
          <span className="font-mono text-[10px] text-[#5E626E]">expires {new Date(approval.expiresAt).toLocaleTimeString()}</span>
        </div>
      </div>
      <p className="mt-1 text-[12px] leading-4 text-[#8A8F98]">{approval.summary}</p>
      <p className="mt-1 text-[12px] leading-4 text-[#E5A158]">{approval.consequences}</p>
      <details className="mt-1">
        <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.03em] text-[#5E626E]">
          Redacted arguments · hash {approval.argumentsHash.slice(0, 12)}
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-[#26282E] bg-[#0F1013] p-2 font-mono text-[10px] leading-4 text-[#8A8F98]">
          {JSON.stringify(approval.argumentsRedacted, null, 2)}
        </pre>
      </details>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-[#5E626E]">
          {runLink ? (
            <Link to={`/runs/${approval.runId}`} className="text-[#BDC2FF] hover:underline">
              run {approval.runId}
            </Link>
          ) : (
            <>correlation {approval.correlationId}</>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <Button variant="danger-ghost" disabled={busy} onClick={onDeny}>
            Deny
          </Button>
          <Button variant="primary" disabled={busy} onClick={onApprove}>
            {approval.kind === "per-call" ? "Approve once" : "Approve for run"}
          </Button>
        </div>
      </div>
    </div>
  );
}
