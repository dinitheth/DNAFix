import type { WorkflowState } from "@dnafix/contracts";

const TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  QUEUED: ["REPOSITORY_PREPARATION", "CANCELLED", "FAILED"],
  REPOSITORY_PREPARATION: ["BASELINE_VERIFICATION", "BLOCKED", "FAILED", "CANCELLED"],
  BASELINE_VERIFICATION: ["PROJECT_DNA_ANALYSIS", "BLOCKED", "FAILED", "CANCELLED"],
  PROJECT_DNA_ANALYSIS: ["IMPACT_ANALYSIS", "BLOCKED", "FAILED", "CANCELLED"],
  IMPACT_ANALYSIS: ["ISSUE_PLANNING", "BLOCKED", "FAILED", "CANCELLED"],
  ISSUE_PLANNING: ["AWAITING_PLAN_APPROVAL", "NEEDS_CLARIFICATION", "BLOCKED", "FAILED", "CANCELLED"],
  NEEDS_CLARIFICATION: ["ISSUE_PLANNING", "CANCELLED", "FAILED"],
  AWAITING_PLAN_APPROVAL: ["AGENT_EXECUTION", "CANCELLED", "FAILED"],
  AGENT_EXECUTION: ["TASK_INTEGRATION", "BLOCKED", "FAILED", "CANCELLED"],
  TASK_INTEGRATION: ["FINAL_VERIFICATION", "AGENT_EXECUTION", "BLOCKED", "FAILED", "CANCELLED"],
  FINAL_VERIFICATION: ["AWAITING_PR_APPROVAL", "AGENT_EXECUTION", "BLOCKED", "FAILED", "CANCELLED"],
  AWAITING_PR_APPROVAL: ["PULL_REQUEST_CREATION", "COMPLETED", "CANCELLED"],
  PULL_REQUEST_CREATION: ["COMPLETED", "BLOCKED", "FAILED"],
  COMPLETED: [],
  BLOCKED: ["QUEUED", "CANCELLED", "FAILED"],
  FAILED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: WorkflowState,
    readonly to: WorkflowState,
  ) {
    super(`Invalid workflow transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(state: WorkflowState): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}

export function isPaused(state: WorkflowState): boolean {
  return state === "AWAITING_PLAN_APPROVAL" || state === "AWAITING_PR_APPROVAL" || state === "NEEDS_CLARIFICATION" || state === "BLOCKED";
}
