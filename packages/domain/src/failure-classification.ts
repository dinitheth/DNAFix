/**
 * Structured failure classification for evaluation arms (replication-v1.3).
 * Separates the original technical failure (failureClass) from the recovery
 * outcome (recoveryStatus), and preserves the full ordered history of failure
 * events (failureEvents) instead of discarding everything after the first.
 */
export const FAILURE_CLASSES = [
  "invalid-patch-generation",
  "patch-application-error",
  "compilation-or-load-failure",
  "test-failure",
  "infrastructure-blocked",
  "budget-exceeded",
  "model-empty-response",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type RecoveryStatus = "not-needed" | "recovered" | "exhausted";

export interface FailureEvent {
  stage: string;
  failureClass: FailureClass;
  detail: string;
  attempt: number;
}

export interface FailureClassificationInput {
  finalState: string;
  error: string | null;
  repairAttempts: number;
  budgetExceeded: boolean;
  tasks: Array<{ taskId: string; status: string; error: string | null }>;
  verificationChecks: Array<{ kind: string; status: string }>;
  /** Scoring-stage acceptance outcome; null when scoring did not run or is not applicable. */
  acceptanceAllPassed: boolean | null;
  /** Changed source content, used only for the conservative invalid-patch-generation heuristic. */
  diff: string;
}

export interface FailureClassification {
  failureClass: FailureClass | null;
  recoveryStatus: RecoveryStatus;
  repairAttempts: number;
  failureEvents: FailureEvent[];
}

function classifyErrorText(error: string): FailureClass {
  const e = error.toLowerCase();
  if (e.includes("budget") && (e.includes("exceeded") || e.includes("refused") || e.includes("reservation"))) return "budget-exceeded";
  if (e.includes("project dna bridge") || e.includes("project_dna_path") || e.includes("not a git repository") || e.includes("sandbox unavailable") || e.includes("docker")) {
    return "infrastructure-blocked";
  }
  if (e.includes("returned no text output") || e.includes("status=incomplete") || e.includes("no usable structured output")) return "model-empty-response";
  if (e.includes("deny-by-default") || e.includes("outside the task file scope") || e.includes("anchor for") || e.includes("file not found") || e.includes("escapes its root")) {
    return "patch-application-error";
  }
  if (e.includes("cannot find module") || e.includes("syntaxerror") || e.includes("is not defined")) return "compilation-or-load-failure";
  return "patch-application-error";
}

/**
 * Conservative invalid-patch-generation heuristic: a diff hunk that replaces a
 * whole import/export statement with a single bare word (the eval-v1.2
 * baseline's literal `replace` import is the canonical example).
 */
export function diffShowsInvalidPatchGeneration(diff: string): boolean {
  const lines = diff.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    const removed = lines[i]!;
    const added = lines[i + 1]!;
    if (/^-\s*(import|export)\s/.test(removed) && /^\+\s*[A-Za-z][A-Za-z0-9_-]*\s*$/.test(added)) return true;
  }
  return false;
}

export function classifyArmFailure(input: FailureClassificationInput): FailureClassification {
  const events: FailureEvent[] = [];

  if (input.budgetExceeded) {
    events.push({ stage: "model", failureClass: "budget-exceeded", detail: input.error ?? "budget exceeded", attempt: 0 });
  }
  for (const task of input.tasks) {
    if (task.status === "failed" && task.error) {
      events.push({ stage: `task:${task.taskId}`, failureClass: classifyErrorText(task.error), detail: task.error.slice(0, 500), attempt: task.taskId.length });
    }
  }
  if (events.length === 0 && input.error && input.finalState !== "COMPLETED") {
    const stage = input.error.toLowerCase().includes("project dna") ? "repository-intelligence" : "pipeline";
    events.push({ stage, failureClass: classifyErrorText(input.error), detail: input.error.slice(0, 500), attempt: 0 });
  }
  const failedChecks = input.verificationChecks.filter((c) => c.status === "failed");
  if (failedChecks.length > 0) {
    events.push({
      stage: "final-verification",
      failureClass: "test-failure",
      detail: `verification checks failed: ${failedChecks.map((c) => c.kind).join(", ")}`,
      attempt: input.repairAttempts,
    });
  }
  if (input.acceptanceAllPassed === false && input.finalState === "COMPLETED") {
    events.push({ stage: "scoring", failureClass: "test-failure", detail: "hidden acceptance suite failed in scoring worktree", attempt: input.repairAttempts });
  }
  if (diffShowsInvalidPatchGeneration(input.diff)) {
    events.unshift({
      stage: "patch-generation",
      failureClass: "invalid-patch-generation",
      detail: "diff replaces an import/export statement with a bare word (corrupt patch content)",
      attempt: 0,
    });
  }

  // Deduplicate consecutive identical classes at the same stage, keep order.
  const deduped = events.filter((e, i) => i === 0 || e.failureClass !== events[i - 1]!.failureClass || e.stage !== events[i - 1]!.stage);
  const failureClass = deduped[0]?.failureClass ?? null;
  let recoveryStatus: RecoveryStatus;
  if (failureClass === null) recoveryStatus = "not-needed";
  else if (input.finalState === "COMPLETED") recoveryStatus = "recovered";
  else if (input.repairAttempts > 0) recoveryStatus = "exhausted";
  else recoveryStatus = "not-needed"; // failure occurred but no repair was triggered (e.g. infrastructure block)
  return { failureClass, recoveryStatus, repairAttempts: input.repairAttempts, failureEvents: deduped };
}
