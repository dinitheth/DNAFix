import type { ConfigStatus, Run } from "./api";

export type ReadinessTone = "ready" | "attention" | "blocked" | "optional";

export interface ReadinessItem {
  id: string;
  label: string;
  tone: ReadinessTone;
  state: string;
  explanation: string;
  recovery?: string;
}

/** Human-readable system readiness derived only from the real /config/status payload. */
export function readinessItems(config: ConfigStatus): ReadinessItem[] {
  const items: ReadinessItem[] = [
    config.model.configured
      ? {
          id: "planner",
          label: "Planner Model",
          tone: "ready",
          state: "Connected",
          explanation: "Planner and coding models connected.",
        }
      : {
          id: "planner",
          label: "Planner Model",
          tone: "blocked",
          state: "Unconfigured",
          explanation: "No active API key detected in the backend host runtime.",
          recovery: "Configure MODEL_API_KEY →",
        },
    config.projectDna.configured
      ? {
          id: "dna",
          label: "Structural Analysis",
          tone: "ready",
          state: "Available",
          explanation: "Deterministic AST parser and cross-file dependency graph engine available.",
        }
      : {
          id: "dna",
          label: "Structural Analysis",
          tone: "blocked",
          state: "Unconfigured",
          explanation: "Repository intelligence is unavailable. Runs stop before planning.",
          recovery: "Install submodule deps or set PROJECT_DNA_PATH →",
        },
    (config.github.userIntegrationConfigured ?? config.github.configured)
      ? {
          id: "github",
          label: "GitHub Integration",
          tone: "ready",
          state: "App configured",
          explanation: "GitHub App credentials are present. Connect your account in New Analysis to browse repositories and issues.",
        }
      : {
          id: "github",
          label: "GitHub Integration",
          tone: "optional",
          state: "Not configured",
          explanation: config.github.missing?.length
            ? `Optional. Missing: ${config.github.missing.join(", ")}.`
            : "Optional. Patches will be written directly as local Git diffs without automated PR generation.",
          recovery: "See docs/GITHUB_APP_SETUP.md →",
        },
  ];

  if (config.execution.provider === "codebuild") {
    items.push(
      config.execution.remoteConfigured
        ? {
            id: "execution",
            label: "Execution Engine",
            tone: "ready",
            state: "AWS CodeBuild",
            explanation: `Builds and tests run on ${config.execution.project} in ${config.execution.region} with per-run IAM isolation.`,
          }
        : {
            id: "execution",
            label: "Execution Engine",
            tone: "blocked",
            state: "Misconfigured",
            explanation: "AWS execution is selected but the CodeBuild project or bucket is not configured.",
            recovery: "Set AWS_CODEBUILD_PROJECT and AWS_ARTIFACT_BUCKET, or switch DNAFIX_EXECUTION_PROVIDER back to local.",
          },
    );
  } else if (config.sandboxMode === "docker") {
    items.push({
      id: "execution",
      label: "Execution Engine",
      tone: "ready",
      state: "Docker sandbox",
      explanation: "Tests run in isolated, network-restricted containers.",
    });
  } else {
    items.push({
      id: "execution",
      label: "Execution Engine",
      tone: "attention",
      state: "Host sandbox",
      explanation: "Builds and tests run directly on this host. No OS isolation — trusted repositories and fixtures only.",
    });
  }

  items.push(
    config.workflowEngine === "temporal"
      ? {
          id: "workflow",
          label: "Workflow Persistence",
          tone: "ready",
          state: "Temporal",
          explanation: `Durable workflows on ${config.temporalAddress ?? "the configured Temporal server"}.`,
        }
      : {
          id: "workflow",
          label: "Workflow Persistence",
          tone: "ready",
          state: "Durable",
          explanation: "Every state transition is journaled to SQLite and fully resumable after process kill.",
        },
  );
  return items;
}

/** Required dependencies that block starting a new analysis (GitHub and workflow choice never block). */
export function blockingReasons(config: ConfigStatus): string[] {
  return readinessItems(config)
    .filter((i) => i.tone === "blocked")
    .map((i) => `${i.label}: ${i.explanation}${i.recovery ? ` ${i.recovery}` : ""}`);
}

export type StageId = "scanning" | "dna" | "planning" | "coding" | "verification" | "review";
export type StageStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "requires-approval";

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
}

const STAGE_ORDER: Array<{ id: StageId; label: string; states: string[] }> = [
  { id: "scanning", label: "Repository scanning", states: ["REPOSITORY_PREPARATION", "BASELINE_VERIFICATION"] },
  { id: "dna", label: "Project DNA analysis", states: ["PROJECT_DNA_ANALYSIS", "IMPACT_ANALYSIS"] },
  { id: "planning", label: "Planning", states: ["ISSUE_PLANNING", "AWAITING_PLAN_APPROVAL", "NEEDS_CLARIFICATION"] },
  { id: "coding", label: "Coding", states: ["AGENT_EXECUTION", "TASK_INTEGRATION"] },
  { id: "verification", label: "Verification", states: ["FINAL_VERIFICATION"] },
  { id: "review", label: "Human review", states: ["AWAITING_PR_APPROVAL", "PULL_REQUEST_CREATION", "COMPLETED"] },
];

/** Timeline derived from the run's actual backend state. No percentages, no invented progress. */
export function runStages(run: Pick<Run, "state">): Stage[] {
  const { state } = run;
  const currentIndex = STAGE_ORDER.findIndex((s) => s.states.includes(state));
  return STAGE_ORDER.map((stage, index) => {
    let status: StageStatus = "pending";
    if (state === "COMPLETED") status = "completed";
    else if (state === "CANCELLED") status = index < currentIndex ? "completed" : "blocked";
    else if (state === "FAILED" || state === "BLOCKED") {
      if (currentIndex === -1) status = index === 0 ? (state === "FAILED" ? "failed" : "blocked") : "pending";
      else status = index < currentIndex ? "completed" : index === currentIndex ? (state === "FAILED" ? "failed" : "blocked") : "pending";
    } else if (index < currentIndex) status = "completed";
    else if (index === currentIndex) {
      status = state === "AWAITING_PLAN_APPROVAL" || state === "AWAITING_PR_APPROVAL" || state === "NEEDS_CLARIFICATION" ? "requires-approval" : "running";
    }
    if (state === "QUEUED") status = index === 0 ? "pending" : "pending";
    return { id: stage.id, label: stage.label, status };
  });
}

export function formatDuration(createdAt: string, updatedAt: string): string {
  const ms = Math.max(0, Date.parse(updatedAt) - Date.parse(createdAt));
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function repositoryLabel(run: Pick<Run, "repositoryPath">, repos: Array<{ id: string; localPath: string | null; githubOwner: string | null; githubRepo: string | null }>, repositoryId: string): string {
  const repo = repos.find((r) => r.id === repositoryId);
  if (repo?.githubOwner && repo.githubRepo) return `${repo.githubOwner}/${repo.githubRepo}`;
  const p = repo?.localPath ?? run.repositoryPath;
  const parts = p.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

export function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    QUEUED: "Queued",
    REPOSITORY_PREPARATION: "Preparing repository",
    BASELINE_VERIFICATION: "Baseline verification",
    PROJECT_DNA_ANALYSIS: "Analysing repository",
    IMPACT_ANALYSIS: "Impact analysis",
    ISSUE_PLANNING: "Planning",
    AWAITING_PLAN_APPROVAL: "Awaiting plan approval",
    NEEDS_CLARIFICATION: "Needs clarification",
    AGENT_EXECUTION: "Coding",
    TASK_INTEGRATION: "Integrating changes",
    FINAL_VERIFICATION: "Verifying",
    AWAITING_PR_APPROVAL: "Awaiting PR approval",
    PULL_REQUEST_CREATION: "Creating draft PR",
    COMPLETED: "Completed",
    BLOCKED: "Blocked",
    FAILED: "Failed",
    CANCELLED: "Cancelled",
  };
  return labels[state] ?? state;
}

export function stateTone(state: string): "success" | "danger" | "warning" | "accent" | "neutral" {
  if (state === "COMPLETED") return "success";
  if (state === "FAILED" || state === "BLOCKED") return "danger";
  if (state === "AWAITING_PLAN_APPROVAL" || state === "AWAITING_PR_APPROVAL" || state === "NEEDS_CLARIFICATION") return "warning";
  if (state === "CANCELLED" || state === "QUEUED") return "neutral";
  return "accent";
}
