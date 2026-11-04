import { useQueries } from "@tanstack/react-query";
import { api, type Run, type RunVerification } from "./api";
import { verificationCandidates } from "./status";

export interface VerificationDecision {
  run: Run;
  evaluation: RunVerification["evaluation"];
}

/**
 * Runs whose verdict needs a human. The verdict is computed by the API from the
 * evidence stored with the run, never re-derived here, so every surface that
 * counts decisions (inbox, overview, sidebar) reports the same number the
 * server would accept a decision on.
 */
export function useVerificationDecisions(runs: Run[]): { decisions: VerificationDecision[]; isLoading: boolean } {
  const candidates = verificationCandidates(runs);
  const queries = useQueries({
    queries: candidates.map((run) => ({
      queryKey: ["run-verification", run.id],
      queryFn: () => api<RunVerification>(`/runs/${run.id}/verification`),
      refetchInterval: 10_000,
    })),
  });
  const decisions = candidates
    .map((run, index) => ({ run, evaluation: queries[index]?.data?.evaluation }))
    .filter((entry): entry is VerificationDecision => (entry.evaluation?.needsHuman.length ?? 0) > 0);
  return { decisions, isLoading: queries.some((q) => q.isLoading) };
}
