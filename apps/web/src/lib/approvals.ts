import { useQuery } from "@tanstack/react-query";
import { api, type McpApproval } from "./api";

export const PENDING_APPROVALS_KEY = ["mcp-approvals-pending"] as const;

function fetchPending() {
  return api<McpApproval[]>("/mcp/approvals?status=pending");
}

/**
 * One cache key for every pending-approval surface (bell, sidebar badge, overview,
 * inbox). Whoever polls keeps the rest current.
 */
export function usePendingApprovals(poll = false) {
  return useQuery({
    queryKey: PENDING_APPROVALS_KEY,
    queryFn: fetchPending,
    retry: false,
    ...(poll ? { refetchInterval: 10_000 } : {}),
  });
}
