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
          label: "AI planner",
          tone: "ready",
          state: "Connected",
          explanation: `${config.model.modelId} plans and reviews; ${config.model.subAgentModelId} executes coding and verification tasks.`,
        }
      : {
          id: "planner",
          label: "AI planner",
          tone: "blocked",
          state: "Not configured",
          explanation: "No model API key is available to the API process. Planning cannot start.",
          recovery: "Set MODEL_API_KEY in the API environment and restart the API.",
        },
    config.projectDna.configured
      ? {
          id: "dna",
          label: "Project DNA",
          tone: "ready",
          state: "Available",
          explanation: "Deterministic repository analysis and structural impact reporting are available.",
        }
      : {
          id: "dna",
          label: "Project DNA",
          tone: "blocked",
          state: "Not configured",
          explanation: "Repository intelligence is unavailable. Runs stop before planning.",
          recovery: "Initialize the vendor/Project-DNA submodule and install its dependencies, or set PROJECT_DNA_PATH.",
        },
    config.github.configured
      ? {
          id: "github",
          label: "GitHub integration",
          tone: "ready",
          state: "Connected",
          explanation: "Draft pull requests can be created after human approval.",
        }
      : {
          id: "github",
          label: "GitHub integration",
          tone: "optional",
          state: "Not configured",
          explanation: "Optional. Without it, verified runs complete as local patches instead of draft pull requests.",
          recovery: "Configure the GitHub App (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID) to enable draft PRs.",
        },
  ];

  if (config.execution.provider === "codebuild") {
    items.push(
      config.execution.remoteConfigured
        ? {
            id: "execution",
            label: "Execution provider",
            tone: "ready",
            state: "AWS CodeBuild",
            explanation: `Builds and tests run on ${config.execution.project} in ${config.execution.region} with per-run IAM isolation.`,
          }
        : {
            id: "execution",
            label: "Execution provider",
            tone: "blocked",
            state: "Misconfigured",
            explanation: "AWS execution is selected but the CodeBuild project or bucket is not configured.",
            recovery: "Set AWS_CODEBUILD_PROJECT and AWS_ARTIFACT_BUCKET, or switch DNAFIX_EXECUTION_PROVIDER back to local.",
          },
    );
  } else if (config.sandboxMode === "docker") {
    items.push({
      id: "execution",
      label: "Execution provider",
      tone: "ready",
      state: "Docker sandbox",
      explanation: "Tests run in isolated, network-restricted containers.",
    });
  } else {
    items.push({
      id: "execution",
      label: "Execution provider",
      tone: "attention",
      state: "Local host execution",
      explanation: "Builds and tests run directly on this machine. Suitable for trusted code only.",
      recovery: "For untrusted repositories, use SANDBOX_MODE=docker or DNAFIX_EXECUTION_PROVIDER=codebuild.",
    });
  }

  items.push(
    config.workflowEngine === "temporal"
      ? {
          id: "workflow",
          label: "Workflow persistence",
          tone: "ready",
          state: "Temporal",
          explanation: `Durable workflows on ${config.temporalAddress ?? "the configured Temporal server"}.`,
        }
      : {
          id: "workflow",
          label: "Workflow persistence",
          tone: "attention",
          state: "Local durable engine",
          explanation: "Runs persist every transition and resume after restart. Temporal is available for production durability.",
          recovery: "Set WORKFLOW_ENGINE=temporal with a running Temporal server for production use.",
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
