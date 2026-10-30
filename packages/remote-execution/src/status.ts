/** CodeBuild build-status mapping. A submitted/queued/in-progress build is never a success. */
export type ExecutionStatus = "SUBMITTED" | "QUEUED" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "FAULT" | "TIMED_OUT" | "STOPPED" | "UNKNOWN";

const KNOWN: ReadonlySet<string> = new Set(["SUBMITTED", "QUEUED", "IN_PROGRESS", "SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"]);

export function mapBuildStatus(raw: string | undefined | null): ExecutionStatus {
  if (!raw) return "UNKNOWN";
  return KNOWN.has(raw) ? (raw as ExecutionStatus) : "UNKNOWN";
}

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "FAULT" || status === "TIMED_OUT" || status === "STOPPED";
}

export function isSuccessStatus(status: ExecutionStatus): boolean {
  return status === "SUCCEEDED";
}

/** Parse per-command exit markers emitted by the DNAFix-generated buildspec from CloudWatch log text. */
export function parseCheckMarkers(logText: string): Map<string, number | null> {
  const results = new Map<string, number | null>();
  for (const match of logText.matchAll(/DNAFIX_CHECK_END\s+([A-Za-z0-9-_]+)\s+(-?\d+)/g)) {
    results.set(match[1]!, Number(match[2]));
  }
  for (const match of logText.matchAll(/DNAFIX_CHECK_BEGIN\s+([A-Za-z0-9-_]+)/g)) {
    if (!results.has(match[1]!)) results.set(match[1]!, null);
  }
  return results;
}
