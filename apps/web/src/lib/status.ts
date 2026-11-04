import type { AuditEvent, ConfigStatus, GitHubStatus, McpConnectorView, Run } from "./api";

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
          explanation: "No MODEL_API_KEY in the API process.",
          recovery: "Configure MODEL_API_KEY →",
        },
    config.projectDna.configured
      ? {
          id: "dna",
          label: "Structural Analysis",
          tone: "ready",
          state: "Available",
          explanation: "Deterministic AST and dependency-graph analysis available.",
        }
      : {
          id: "dna",
          label: "Structural Analysis",
          tone: "blocked",
          state: "Unconfigured",
          explanation: "Runs stop before planning.",
          recovery: "Install submodule deps or set PROJECT_DNA_PATH →",
        },
    (config.github.userIntegrationConfigured ?? config.github.configured)
      ? {
          id: "github",
          label: "GitHub Integration",
          tone: "ready",
          state: "App configured",
          explanation: "GitHub App ready. Connect your account to import issues and open draft PRs.",
        }
      : {
          id: "github",
          label: "GitHub Integration",
          tone: "optional",
          state: "Not configured",
          explanation: config.github.missing?.length
            ? `Optional. Missing: ${config.github.missing.join(", ")}.`
            : "Optional. Without it, runs end in local Git diffs.",
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
      explanation: "Runs directly on this host with no OS isolation. Trusted repositories only.",
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
      : config.store?.kind === "file"
        ? {
            id: "workflow",
            label: "Workflow Persistence",
            tone: "attention",
            state: "JSON file",
            explanation: "Single-process JSON store; API and worker overwrite each other. Use the SQLite default.",
          }
        : {
            id: "workflow",
            label: "Workflow Persistence",
            tone: "ready",
            state: "Durable",
            explanation: "Every transition commits to shared SQLite; one process leases a run at a time and a restart picks up where it stopped.",
          },
  );
  return items;
}

/** Where an operator goes to clear each readiness item. */
export function readinessHref(id: string): string {
  const map: Record<string, string> = {
    planner: "/settings#model",
    dna: "/settings#dna",
    github: "/connectors/github",
    execution: "/settings#execution",
    workflow: "/settings#workflow",
  };
  return map[id] ?? "/settings";
}

/** Required dependencies that block starting a new analysis (GitHub and workflow choice never block). */
export function blockingReasons(config: ConfigStatus): string[] {
  return readinessItems(config)
    .filter((i) => i.tone === "blocked")
    .map((i) => `${i.label}: ${i.explanation}${i.recovery ? ` ${i.recovery}` : ""}`);
}

/**
 * Plain-text snapshot of the configuration the backend actually resolved, for
 * pasting into a bug report. Secrets are reported as presence only, never values.
 */
export function configurationSummary(
  config: ConfigStatus,
  github: Pick<GitHubStatus, "connected" | "account" | "installation"> | null,
  mcp: Pick<McpConnectorView, "state" | "serverCount" | "toolCount" | "enabledToolCount"> | null,
  now = new Date(),
): string {
  const s = config.security;
  const remote = config.execution.provider === "codebuild";
  return [
    `DNAFix configuration ${now.toISOString()}`,
    `model: ${config.model.provider} lead=${config.model.modelId} sub=${config.model.subAgentModelId} transport=${config.model.transport} endpoint=${config.model.baseUrl} key=${config.model.configured ? "present" : "missing"}`,
    `project-dna: ${config.projectDna.path ?? "not resolved"} runtime=${config.projectDna.runtime ?? "—"}`,
    `execution: provider=${config.execution.provider} sandbox=${config.sandboxMode}${remote ? ` project=${config.execution.project ?? "—"} bucket=${config.execution.bucket ?? "—"} region=${config.execution.region}` : ""}`,
    `workflow: engine=${config.workflowEngine}${config.temporalAddress ? ` address=${config.temporalAddress}` : ""} store=${config.store?.kind ?? "—"} ${config.store?.location ?? "—"}`,
    `security: bind=${s.bind} auth=${s.sessionTokenRequired ? "bearer" : "loopback-only"} roots=${s.repositoryRoots.join(", ") || "unrestricted"} webhook-secret=${s.webhookSecretConfigured ? "present" : "missing"} token-encryption=${s.tokenEncryptionKeyConfigured ? "present" : "missing"} cors=${s.corsOrigin}`,
    `github: app=${(config.github.appConfigured ?? config.github.configured) ? "configured" : "not configured"} ${github?.connected ? `account=${github.account?.login ?? "—"} installation=${github.installation?.id ?? "—"}` : "connection=none"}`,
    `docker-mcp: ${mcp ? `state=${mcp.state} servers=${mcp.serverCount} tools=${mcp.toolCount} enabled=${mcp.enabledToolCount}` : "status unavailable"}`,
  ]
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
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
export function runStages(run: Pick<Run, "state">, stoppedStage?: StageId | null): Stage[] {
  const { state } = run;
  let currentIndex = STAGE_ORDER.findIndex((s) => s.states.includes(state));
  // BLOCKED, FAILED and CANCELLED do not name a stage, so the caller supplies
  // the last stage the audit trail recorded instead of defaulting to stage one.
  if (currentIndex === -1 && stoppedStage) currentIndex = STAGE_ORDER.findIndex((s) => s.id === stoppedStage);
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

const STATE_TO_STAGE = new Map<string, StageId>(
  STAGE_ORDER.flatMap((stage) => stage.states.map((state) => [state, stage.id] as [string, StageId])),
);

/**
 * Which pipeline stage an audit action belongs to. `workflow.<state>` events
 * are the state transitions the engine recorded; the rest are the real
 * `runs.audit(...)` action names from packages/application and apps/api.
 * An action we do not recognise reports no stage instead of being guessed at.
 */
export function stageOfAction(action: string): StageId | null {
  if (action.startsWith("workflow.")) return STATE_TO_STAGE.get(action.slice("workflow.".length).toUpperCase()) ?? null;
  if (action === "execution.codebuild.baseline" || action.startsWith("repository.")) return "scanning";
  if (action === "verification.baseline") return "scanning";
  if (action.startsWith("project-dna.")) return "dna";
  if (action.startsWith("plan.") || action.startsWith("model.plan") || action.startsWith("clarification.")) return "planning";
  if (action.startsWith("task.") || action.startsWith("tasks.") || action.startsWith("integration.")) return "coding";
  if (action.startsWith("verification.") || action.startsWith("repair.") || action === "execution.codebuild.final") return "verification";
  if (action.startsWith("pull-request.")) return "review";
  return null;
}

const ATTEMPT_STARTS = ["run.created", "run.resumed"];

/** How many times the pipeline has been started for this run, from its own audit trail. */
export function runAttempts(audit: AuditEvent[]): number {
  return audit.filter((e) => ATTEMPT_STARTS.includes(e.action) && !Number.isNaN(Date.parse(e.createdAt))).length;
}

/** When the current attempt began, so a blocked-and-resumed run does not report idle gaps as stage time. */
function attemptStart(audit: AuditEvent[]): number | null {
  const restarts = audit
    .filter((e) => e.action === "run.resumed" || e.action === "workflow.queued")
    .map((e) => Date.parse(e.createdAt))
    .filter((ms) => !Number.isNaN(ms));
  return restarts.length ? Math.max(...restarts) : null;
}

export interface StageTiming {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  events: number;
  /** The audit record that best describes how the stage ended. */
  evidence: { action: string; detail: string | null; result: string } | null;
}

const STOPPED_STATES = ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"];

/**
 * Start, end and span of every stage in the current attempt, taken from the
 * timestamps of the audit events that belong to it. A stage ends when a later
 * stage records its first event after this stage's last one, so a repair loop
 * that returns to coding keeps coding open. Stages that never ran stay null,
 * and a stage still in progress has no end until the run stops.
 */
export function stageTimings(audit: AuditEvent[], run: Pick<Run, "state" | "updatedAt">): Record<StageId, StageTiming> {
  const from = attemptStart(audit);
  const byStage = new Map<StageId, AuditEvent[]>();
  for (const event of audit) {
    const stage = stageOfAction(event.action);
    const ms = Date.parse(event.createdAt);
    if (!stage || Number.isNaN(ms)) continue;
    if (from !== null && ms < from) continue;
    const list = byStage.get(stage);
    if (list) list.push(event);
    else byStage.set(stage, [event]);
  }
  const times = new Map<StageId, number[]>();
  for (const [stage, list] of byStage) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    times.set(stage, list.map((e) => Date.parse(e.createdAt)));
  }

  const stoppedAt = STOPPED_STATES.includes(run.state) ? Date.parse(run.updatedAt) : NaN;
  const ids = STAGE_ORDER.map((s) => s.id);
  const result = {} as Record<StageId, StageTiming>;

  ids.forEach((id, index) => {
    const own = times.get(id) ?? [];
    const startedMs = own[0] ?? null;
    let endedMs: number | null = null;
    if (startedMs !== null) {
      const lastOwn = own[own.length - 1]!;
      for (const later of ids.slice(index + 1)) {
        const next = (times.get(later) ?? []).find((ms) => ms >= lastOwn);
        if (next !== undefined && (endedMs === null || next < endedMs)) endedMs = next;
      }
      if (endedMs === null && !Number.isNaN(stoppedAt) && startedMs <= stoppedAt) endedMs = stoppedAt;
    }
    const events = byStage.get(id) ?? [];
    const failing = events.find((e) => e.result === "error");
    const anchor = failing ?? events[events.length - 1];
    result[id] = {
      startedAt: startedMs === null ? null : new Date(startedMs).toISOString(),
      endedAt: endedMs === null ? null : new Date(endedMs).toISOString(),
      durationMs: startedMs !== null && endedMs !== null && endedMs >= startedMs ? endedMs - startedMs : null,
      events: events.length,
      evidence: anchor ? { action: anchor.action, detail: anchor.evidence, result: anchor.result } : null,
    };
  });
  return result;
}

/** The furthest stage the audit trail recorded, used to place a BLOCKED/FAILED outcome on the right stage. */
export function lastStartedStage(timings: Record<StageId, StageTiming>): StageId | null {
  for (let index = STAGE_ORDER.length - 1; index >= 0; index -= 1) {
    const id = STAGE_ORDER[index]?.id;
    if (id && timings[id]?.startedAt) return id;
  }
  return null;
}

/** Wall-clock stamp for the dense pipeline band: `03:12:45`, never a guess. */
export function formatClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatSpan(durationMs: number | null): string {
  if (durationMs === null) return "";
  if (durationMs < 1000) return `${durationMs}ms`;
  const sec = Math.floor(durationMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function formatDuration(createdAt: string, updatedAt: string): string {
  const ms = Math.max(0, Date.parse(updatedAt) - Date.parse(createdAt));
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** How long ago a recorded timestamp is, from the clock the page already has. */
export function formatAgo(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Compact local start stamp for dense tables: `Nov 5 03:12`. */
export function formatStarted(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} ${time}`;
}

export function repositoryLabel(run: Pick<Run, "repositoryPath">, repos: Array<{ id: string; localPath: string | null; githubOwner: string | null; githubRepo: string | null }>, repositoryId: string): string {
  const repo = repos.find((r) => r.id === repositoryId);
  if (repo?.githubOwner && repo.githubRepo) return `${repo.githubOwner}/${repo.githubRepo}`;
  const p = repo?.localPath ?? run.repositoryPath;
  const parts = p.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || p;
}

/** Runs that carry recorded verification checks and are not finished. */
export function verificationCandidates<T extends Pick<Run, "state" | "verificationChecks">>(runs: T[]): T[] {
  return runs
    .filter((run) => (run.verificationChecks?.length ?? 0) > 0 && run.state !== "COMPLETED")
    .slice(0, 12);
}

/**
 * Everything the inbox treats as "waiting on you": the three run states that
 * pause for a human, the verdicts the server says need one, and open MCP
 * permission requests. Kept here so the sidebar badge and the page agree.
 */
export function decisionsWaiting(runs: Array<Pick<Run, "state">>, verificationDecisions: number, mcpPending: number): number {
  const paused = runs.filter((run) => ["AWAITING_PLAN_APPROVAL", "NEEDS_CLARIFICATION", "AWAITING_PR_APPROVAL"].includes(run.state)).length;
  return paused + verificationDecisions + mcpPending;
}

/**
 * Backend blockers run to several sentences. Summary surfaces show the first
 * sentence and keep the whole text available; the run page carries all of it.
 */
export function briefMessage(message: string): string {
  const first = (message.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? message).trim();
  return first.length > 180 ? `${first.slice(0, 179).trimEnd()}…` : first;
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
