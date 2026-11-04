import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent, CreateRunRequest } from "@dnafix/contracts";
import { assertTransition, canRunInParallel, findOverlappingChanges, integrationOrder, validatePlanSemantics } from "@dnafix/domain";
import { createCommandRunner, type CommandRunner } from "@dnafix/execution";
import { GitWorktreeManager, cloneRepository, cloneRepositoryWithToken } from "@dnafix/git-engine";
import { GitHubAdapter, GitHubNotConfiguredError } from "@dnafix/github";
import { McpConnectorService } from "@dnafix/mcp";
import { MetaModelProvider, ModelNotConfiguredError, createModelProviderFromEnv, type ModelProvider } from "@dnafix/model-provider";
import { FileStore, SqliteStore, importLegacyJson, isStaleWrite, isTerminalRunWrite, type LegacyImportReport, type RunRecord, type Store } from "@dnafix/persistence";
import { ProjectDNAAdapter, RepositoryIntelligenceError, type RepositoryIntelligence } from "@dnafix/repository-intelligence";
import { compareImpact, discoverChecks, evaluateVerification, runChecks } from "@dnafix/verification";
import { codeBuildProviderFromEnv, type RemoteExecutionProvider } from "@dnafix/remote-execution";
import { CodingAgent, VerificationAgent, readScopedFiles } from "@dnafix/agent-orchestrator";

export interface PipelineDeps {
  store: Store;
  intelligence: RepositoryIntelligence;
  /** Lead planner model (Muse Wonder by default). Planning and replanning only. */
  model: ModelProvider;
  /** Sub-agent model for coding + verification work (Muse Spark by default). Defaults to `model`. */
  subAgentModel?: ModelProvider;
  /** Cloud execution provider for verification (CodeBuild when DNAFIX_EXECUTION_PROVIDER=codebuild). Null = local runner. Never a silent fallback. */
  remoteExecution?: RemoteExecutionProvider | null;
  worktrees: GitWorktreeManager;
  runner: CommandRunner;
  github: GitHubAdapter;
  dataRoot: string;
  maxRepairAttempts: number;
  sandboxNote: string;
  /** Docker Desktop MCP connector. Optional: absent disables the MCP evidence phase entirely. */
  mcp?: McpConnectorService | null;
}

/**
 * Repository root, derived from this package's own location. The API and the
 * worker are started from their own package directories, so `process.cwd()`
 * cannot anchor shared data: `.data` under one cwd and `.data` under the other
 * are two databases, and the worker never sees the runs the API creates.
 */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Where runs, worktrees and the store live. A relative DNAFIX_DATA_DIR is read
 * against the repository root, not the cwd, so both processes agree by default.
 */
export function resolveDataRoot(configured = process.env.DNAFIX_DATA_DIR): string {
  const value = configured?.trim() || ".data";
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

/**
 * The store the API and the worker share. SQLite is the default because both
 * processes write the same rows: the JSON file store caches its whole database
 * in each process, so two of them overwrite each other's runs.
 *
 * There is no automatic fallback. An unusable store stops startup.
 */
export function createStore(dataRoot: string): Store {
  const mode = (process.env.DNAFIX_STORE?.trim() || "sqlite").toLowerCase();
  if (mode === "file") {
    console.warn("DNAFIX_STORE=file: the JSON store cannot be shared safely between the API and the worker. Tests and fixtures only.");
    return new FileStore(path.join(dataRoot, "dnafix.json"));
  }
  if (mode !== "sqlite") throw new Error(`Unknown DNAFIX_STORE '${mode}'. Expected 'sqlite' (default) or 'file'.`);
  const configured = process.env.DNAFIX_DATABASE_PATH?.trim();
  // Relative to the data root, not the cwd, for the same reason as above.
  const dbPath = configured ? (path.isAbsolute(configured) ? configured : path.join(dataRoot, configured)) : path.join(dataRoot, "dnafix.sqlite");
  const busyTimeoutMs = Number(process.env.DNAFIX_SQLITE_BUSY_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(busyTimeoutMs) || busyTimeoutMs < 0) throw new Error(`DNAFIX_SQLITE_BUSY_TIMEOUT_MS must be a non-negative number, got '${process.env.DNAFIX_SQLITE_BUSY_TIMEOUT_MS}'.`);
  return new SqliteStore(dbPath, { busyTimeoutMs });
}

/** What the running process actually stores data in, for the status surface. */
export function describeStore(store: Store): { kind: "sqlite" | "file"; location: string } {
  if (store instanceof SqliteStore) return { kind: "sqlite", location: store.location };
  if (store instanceof FileStore) return { kind: "file", location: store.location };
  return { kind: "file", location: "in-memory" };
}

/**
 * Copies an existing .data/dnafix.json database into the active store on first
 * run. Idempotent, so api and worker starting together is safe, and the source
 * file is left exactly where it is.
 */
export async function migrateLegacyStore(deps: PipelineDeps): Promise<LegacyImportReport | null> {
  if (!(deps.store instanceof SqliteStore)) return null;
  const report = await importLegacyJson(path.join(deps.dataRoot, "dnafix.json"), deps.store, deps.store.location);
  if (report) {
    const moved = Object.entries(report.imported).filter(([, count]) => count > 0);
    if (moved.length > 0) {
      console.log(`Imported legacy store ${report.source} into ${report.target}: ${moved.map(([name, count]) => `${count} ${name}`).join(", ")}`);
    }
  }
  return report;
}

export function createDefaultDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  const dataRoot = resolveDataRoot();
  const runner = createCommandRunner();
  const base: PipelineDeps = {
    store: createStore(dataRoot),
    intelligence: new ProjectDNAAdapter(),
    model: createModelProviderFromEnv(),
    // Sub-agents (coding + verification) use Muse Spark for cost; the lead
    // planner remains Muse Wonder. Explicit configuration, never a silent downgrade.
    subAgentModel: new MetaModelProvider({ model: process.env.MUSE_SPARK_MODEL ?? "muse-spark-1.3" }),
    worktrees: new GitWorktreeManager(path.join(dataRoot, "worktrees")),
    runner,
    github: new GitHubAdapter(),
    remoteExecution: process.env.DNAFIX_EXECUTION_PROVIDER === "codebuild" ? codeBuildProviderFromEnv() : null,
    dataRoot,
    maxRepairAttempts: Number(process.env.MAX_REPAIR_ATTEMPTS ?? 2),
    sandboxNote: runner.mode === "docker" ? "docker" : "host (reduced isolation — explicit SANDBOX_MODE=host)",
  };
  const merged: PipelineDeps = { ...base, ...overrides };
  // Bind the connector to the store that is actually used (tests inject stores).
  if (overrides.mcp === undefined) merged.mcp = new McpConnectorService({ store: merged.store });
  return merged;
}

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

/** Fields the store manages itself; never treated as a writer's change. */
const STORE_MANAGED_FIELDS: (keyof RunRecord)[] = ["revision", "updatedAt"];
const TERMINAL_STATES: RunRecord["state"][] = ["COMPLETED", "FAILED", "CANCELLED"];
const STALE_WRITE_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Key order is stable because both sides come from the same JSON round-trip. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/** Another writer holds a different view of this run, so this write was dropped. */
export class RunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

export class RunService {
  /** The row each writer last saw or wrote, per run, so a rejected write can be re-applied field by field. */
  private readonly baselines = new Map<string, RunRecord>();

  constructor(private readonly deps: PipelineDeps) {}

  /**
   * Read a run for writing. The returned copy is tracked, so a later save that
   * the store rejects can tell "what this writer changed" from "what drifted".
   */
  async load(runId: string): Promise<RunRecord | null> {
    const run = await this.deps.store.getRun(runId);
    if (run) {
      this.baselines.set(runId, structuredClone(run));
      if (TERMINAL_STATES.includes(run.state)) this.baselines.delete(runId);
    }
    return run;
  }

  private remember(run: RunRecord): void {
    if (TERMINAL_STATES.includes(run.state)) this.baselines.delete(run.id);
    else this.baselines.set(run.id, structuredClone(run));
  }

  /**
   * Re-read the row, move only this writer's own fields onto it and retry, up to
   * STALE_WRITE_ATTEMPTS times. Merging is safe only when the other writer left
   * those fields alone; a field both changed is reported, never guessed. The
   * write transaction is held only across the row update — model, test, MCP and
   * GitHub calls all happen before it.
   */
  private async write(run: RunRecord): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.deps.store.saveRun(run);
        this.remember(run);
        return;
      } catch (err) {
        if (isTerminalRunWrite(err)) throw new RunConflictError((err as Error).message);
        if (!isStaleWrite(err)) throw err;
        const fresh = await this.deps.store.getRun(run.id);
        if (!fresh) throw err;
        const conflict = this.reapply(run, fresh);
        if (conflict) {
          // The caller's copy is now known-bad: it must re-read, and a retry with
          // this same object reports the conflict again instead of overwriting.
          throw new RunConflictError(conflict);
        }
        if (attempt >= STALE_WRITE_ATTEMPTS) throw new RunConflictError(`Run ${run.id} kept changing under this writer; the write was dropped.`);
        await sleep(2 * attempt + Math.floor(Math.random() * 5));
      }
    }
  }

  /**
   * Human cancellation wins over a running worker: re-read the row and apply only
   * the cancellation, retrying while a mid-phase writer keeps bumping the revision,
   * so the decision is never lost to whichever process happened to write last.
   */
  async cancel(runId: string): Promise<RunRecord | null> {
    for (let attempt = 1; ; attempt++) {
      const run = await this.load(runId);
      if (!run) return null;
      run.state = "CANCELLED";
      run.updatedAt = now();
      try {
        await this.deps.store.saveRun(run);
        this.remember(run);
        return run;
      } catch (err) {
        // The run reached a terminal state while the cancellation was in flight;
        // that outcome stands and is reported instead of being overwritten.
        if (isTerminalRunWrite(err)) return this.load(runId);
        if (!isStaleWrite(err) || attempt >= STALE_WRITE_ATTEMPTS) throw err;
        await sleep(2 * attempt + Math.floor(Math.random() * 5));
      }
    }
  }

  /** Returns null when the merge is safe, otherwise a message naming the conflict. */
  private reapply(run: RunRecord, fresh: RunRecord): string | null {
    const baseline = this.baselines.get(run.id);
    if (!baseline) {
      return `Run ${run.id} was not read through this writer, so its changes cannot be merged onto the current row. Read it again and retry.`;
    }
    const ours: (keyof RunRecord)[] = [];
    const shared: (keyof RunRecord)[] = [];
    for (const key of Object.keys(run) as (keyof RunRecord)[]) {
      if (STORE_MANAGED_FIELDS.includes(key)) continue;
      if (sameJson(run[key], baseline[key])) continue;
      ours.push(key);
      if (!sameJson(fresh[key], baseline[key])) shared.push(key);
    }
    if (shared.length > 0) {
      if (shared.includes("state")) return `Run ${run.id} moved to ${fresh.state} under this writer (it held ${baseline.state}); this writer's change to ${shared.join(", ")} was dropped instead of overwriting it.`;
      return `Run ${run.id} had ${shared.map((k) => String(k)).join(", ")} changed by another writer at the same time; nothing was overwritten.`;
    }
    const overlay: Partial<RunRecord> = {};
    for (const key of ours) overlay[key] = run[key] as never;
    Object.assign(run, fresh, overlay, { revision: fresh.revision, updatedAt: now() });
    return null;
  }

  async createRun(req: CreateRunRequest, repositoryIdForPath?: string): Promise<RunRecord> {
    let repositoryPath = req.repositoryPath ?? "";
    let repositoryId: string;
    if (req.githubOwner && req.githubRepo) {
      repositoryId = repositoryIdForPath ?? `gh_${req.githubOwner}_${req.githubRepo}`.replaceAll(/[^a-zA-Z0-9-_]/g, "-");
      if (!repositoryPath) repositoryPath = path.join(this.deps.dataRoot, "repos", `${req.githubOwner}-${req.githubRepo}`);
    } else if (repositoryPath) {
      repositoryId = repositoryIdForPath ?? `local_${createHash("sha256").update(path.resolve(repositoryPath)).digest("hex").slice(0, 16)}`;
    } else {
      throw new Error("CreateRun requires repositoryPath or githubOwner/githubRepo");
    }
    const existingRepository = await this.deps.store.getRepository(repositoryId);
    await this.deps.store.saveRepository({
      id: repositoryId,
      localPath: repositoryPath,
      githubOwner: req.githubOwner ?? null,
      githubRepo: req.githubRepo ?? null,
      defaultBranch: existingRepository?.defaultBranch ?? null,
      lastAnalyzedCommitSha: existingRepository?.lastAnalyzedCommitSha ?? null,
      createdAt: existingRepository?.createdAt ?? now(),
      githubInstallationId: req.githubInstallationId ?? existingRepository?.githubInstallationId ?? null,
    });
    const run: RunRecord = {
      id: id("run"),
      repositoryId,
      repositoryPath,
      issueTitle: req.issueTitle,
      issueBody: req.issueBody,
      issueNumber: req.issueNumber ?? null,
      baseRef: req.baseRef ?? "HEAD",
      baseCommitSha: null,
      repositorySnapshotId: null,
      state: "QUEUED",
      modelProvider: `${this.deps.model.name} lead=${this.deps.model.modelId}, sub-agents=${(this.deps.subAgentModel ?? this.deps.model).modelId}`,
      workflowEngine: process.env.WORKFLOW_ENGINE === "temporal" ? "temporal" : "in-process-durable",
      analysis: null,
      plan: null,
      intelligence: null,
      tasks: [],
      baselineChecks: [],
      verificationChecks: null,
      verifierReview: null,
      diff: "",
      changedPaths: [],
      repairAttempts: 0,
      pullRequestUrl: null,
      pullRequestNumber: null,
      error: null,
      clarificationAnswer: null,
      idempotency: {},
      createdAt: now(),
      updatedAt: now(),
      githubInstallationId: req.githubInstallationId ?? null,
      issueUrl: req.issueUrl ?? null,
    };
    await this.write(run);
    await this.audit(run.id, run.repositoryId, "user", "run.created", "ok", `issue: ${req.issueTitle}`);
    return run;
  }

  /**
   * Request remote cancellation: StopBuild for the run's active build, persist
   * the request and CodeBuild's reported status. A submitted stop request is
   * never reported as safe termination — the worker observing the terminal
   * state (and completing role revocation/cleanup) is the authority.
   */
  async requestRemoteCancellation(run: RunRecord): Promise<void> {
    const remote = this.deps.remoteExecution;
    const active = [...(run.remoteExecutions ?? [])].reverse().find((e) => e.buildId && !["SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"].includes(e.status));
    if (!remote || !active?.buildId) return;
    const reported = await remote.cancel(active.buildId).catch((err: Error) => ({ status: `stop-request-failed: ${err.message}` }));
    active.cancellation = { requestedAt: new Date().toISOString(), reportedStatus: reported.status, outcome: "stop-requested; terminal state to be confirmed by the executing worker" };
    run.remoteExecutions = [...(run.remoteExecutions ?? [])];
    await this.save(run);
    await this.audit(run.id, run.repositoryId, "user", "execution.codebuild.cancel-requested", "info", `build=${active.buildId} reportedStatus=${reported.status}`);
  }

  async audit(runId: string | null, repositoryId: string | null, actor: AuditEvent["actor"], action: string, result: AuditEvent["result"], evidence: string | null): Promise<void> {
    await this.deps.store.appendAudit({ id: id("evt"), runId, repositoryId, actor, action, result, evidence, createdAt: now() });
  }

  async transition(run: RunRecord, to: RunRecord["state"]): Promise<RunRecord> {
    assertTransition(run.state, to);
    run.state = to;
    run.updatedAt = now();
    await this.write(run);
    await this.audit(run.id, run.repositoryId, "system", `workflow.${to.toLowerCase()}`, "info", null);
    return run;
  }

  async save(run: RunRecord): Promise<void> {
    run.updatedAt = now();
    await this.write(run);
  }
}

const running = new Set<string>();

export class Pipeline {
  private readonly runs: RunService;
  constructor(private readonly deps: PipelineDeps) {
    this.runs = new RunService(deps);
  }

  /** Execute until a pause state, terminal state, or blocker. Safe to call repeatedly; per-process lock prevents duplicate execution. */
  async process(runId: string): Promise<void> {
    if (running.has(runId)) return;
    running.add(runId);
    try {
      await this.execute(runId);
    } finally {
      running.delete(runId);
    }
  }

  /**
   * Verification checks via the configured execution path.
   * Cloud mode: the worktree is bundled and the approved discovered commands run
   * on CodeBuild; per-command exit codes come from CloudWatch log markers.
   * AWS failures are rethrown as RemoteExecutionError (pipeline marks BLOCKED) —
   * there is no silent fallback to local execution.
   */
  private async runVerificationChecks(run: RunRecord, worktreePath: string, phase: "baseline" | "final", baselineFailingIds?: Set<string>): Promise<import("@dnafix/contracts").VerificationCheck[]> {
    const remote = this.deps.remoteExecution;
    if (!remote) return runChecks(this.deps.runner, worktreePath, { baselineFailingIds });
    if (!remote.configured()) {
      throw Object.assign(new Error("DNAFIX_EXECUTION_PROVIDER=codebuild but the CodeBuild provider is not configured (AWS_CODEBUILD_PROJECT/AWS_ARTIFACT_BUCKET). Refusing local fallback."), { name: "RemoteExecutionError" });
    }
    const discovered = await discoverChecks(worktreePath);
    if (discovered.length === 0) return runChecks(this.deps.runner, worktreePath, { baselineFailingIds });
    let result;
    try {
      result = await remote.runJob({
        runId: `${run.id}-${phase}`,
        workspacePath: worktreePath,
        baseCommitSha: run.baseCommitSha!,
        commands: discovered.map((c) => ({ id: c.kind, kind: c.kind, argv: c.argv })),
        timeoutMinutes: 20,
      });
    } catch (err) {
      throw Object.assign(new Error(`AWS execution failed (${phase}): ${err instanceof Error ? err.message : String(err)}`), { name: "RemoteExecutionError" });
    }
    run.remoteExecutions = [
      ...(run.remoteExecutions ?? []),
      {
        phase,
        provider: result.provider,
        buildId: result.jobId,
        status: result.status,
        sourceKey: result.sourceKey,
        sourceSha256: result.sourceSha256,
        artifactsLocation: result.artifactsLocation,
        logsReference: result.logsReference,
        summary: result.summary,
        createdAt: new Date().toISOString(),
        roleArn: result.executionRole?.roleArn ?? null,
        trustPolicyVersion: result.executionRole?.trustPolicyVersion ?? null,
        revocationStatus: result.executionRole ? result.executionRole.revocation.confirmationStatus : null,
        deletionStatus: result.executionRole ? (result.executionRole.deletion.deleted ? "deleted" : "not-deleted") : null,
        containmentStatus: result.executionRole?.containmentStatus ?? null,
        lifecycleState: result.executionRole?.lifecycleState ?? null,
        quarantinedAt: result.executionRole?.quarantinedAt ?? null,
        deleteNotBefore: result.executionRole?.deleteNotBefore ?? null,
        cleanupAttempts: result.executionRole?.cleanupAttempts ?? 0,
        sourceVerified: result.sourceVerified,
        artifactVerified: result.artifactIntegrity?.verified,
      },
    ];
    await this.runs.audit(run.id, run.repositoryId, "system", `execution.codebuild.${phase}`, result.status === "SUCCEEDED" ? "ok" : "error", `build=${result.jobId} status=${result.status} sourceSha256=${result.sourceSha256} logs=${result.logsReference}`);
    return discovered.map((check) => {
      const remoteCheck = result.checkResults.find((c) => c.id === check.kind);
      const exitCode = remoteCheck?.exitCode ?? null;
      return {
        id: check.kind,
        kind: check.kind,
        status: exitCode === 0 ? ("passed" as const) : exitCode === null ? ("blocked" as const) : baselineFailingIds?.has(check.kind) ? ("pre-existing-failure" as const) : ("failed" as const),
        result: {
          argv: check.argv,
          cwd: `codebuild://${result.sourceKey}`,
          exitCode,
          timedOut: result.status === "TIMED_OUT",
          durationMs: result.durationMs,
          stdoutSummary: result.logExcerpt.slice(-8_000),
          stderrSummary: "",
          sandboxMode: "codebuild" as const,
        },
        notes: `CodeBuild build ${result.jobId} (${result.status}); logs: ${result.logsReference}`,
      };
    });
  }

  private async execute(runId: string): Promise<void> {
    const { store, worktrees, intelligence, model } = this.deps;
    const initial = await this.runs.load(runId);
    if (!initial) return;
    let run: RunRecord = initial;
    const codingAgent = new CodingAgent(this.deps.subAgentModel ?? model);
    const verifier = new VerificationAgent(this.deps.subAgentModel ?? model);
    try {
      // ── REPOSITORY_PREPARATION ──────────────────────────────────────────
      if (run.state === "QUEUED") run = await this.runs.transition(run, "REPOSITORY_PREPARATION");
      if (run.state === "REPOSITORY_PREPARATION") {
        const repo = await store.getRepository(run.repositoryId);
        if (repo?.githubOwner && repo.githubRepo && !existsSync(path.join(run.repositoryPath, ".git"))) {
          await mkdir(path.dirname(run.repositoryPath), { recursive: true });
          const url = `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`;
          const installationId = repo.githubInstallationId ?? run.githubInstallationId ?? process.env.GITHUB_INSTALLATION_ID;
          if (installationId && this.deps.github.appConfigured) {
            const token = await this.deps.github.installationToken(installationId);
            await cloneRepositoryWithToken(url, run.repositoryPath, token);
            await this.runs.audit(run.id, run.repositoryId, "system", "repository.cloned", "ok", `authenticated installation ${installationId}`);
          } else {
            await cloneRepository(url, run.repositoryPath);
            await this.runs.audit(run.id, run.repositoryId, "system", "repository.cloned", "ok", run.repositoryPath);
          }
        }
        if (!(await worktrees.isGitRepository(run.repositoryPath))) {
          run.error = `Repository path is not a git repository: ${run.repositoryPath}`;
          run = await this.runs.transition(run, "BLOCKED");
          await this.runs.audit(run.id, run.repositoryId, "system", "repository.invalid", "error", run.error);
          return;
        }
        run.baseCommitSha = await worktrees.headSha(run.repositoryPath);
        if (run.baseRef !== "HEAD") {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          run.baseCommitSha = (await promisify(execFile)("git", ["rev-parse", run.baseRef], { cwd: run.repositoryPath })).stdout.trim();
        }
        await this.runs.save(run);
        run = await this.runs.transition(run, "BASELINE_VERIFICATION");
      }

      const integrationTaskId = "integration";
      // Reuse only a validated existing worktree; unexpected git errors propagate.
      const { info: integration } = await worktrees.createOrReuseWorktree(run.repositoryPath, run.id, integrationTaskId, run.baseCommitSha!);

      // ── BASELINE_VERIFICATION ───────────────────────────────────────────
      if (run.state === "BASELINE_VERIFICATION") {
        run.baselineChecks = await this.runVerificationChecks(run, integration.path, "baseline").catch((err: Error) => {
          throw Object.assign(err, { blocked: true });
        });
        await this.runs.audit(run.id, run.repositoryId, "system", "verification.baseline", "ok", run.baselineChecks.map((c) => `${c.kind}:${c.status}`).join(", "));
        await this.runs.save(run);
        run = await this.runs.transition(run, "PROJECT_DNA_ANALYSIS");
      }

      // ── PROJECT_DNA_ANALYSIS + IMPACT + PLANNING ────────────────────────
      if (run.state === "PROJECT_DNA_ANALYSIS") {
        run.intelligence = await intelligence.analyze({ rootPath: integration.path, baseCommitSha: run.baseCommitSha!, targetPaths: [] });
        run.repositorySnapshotId = `${run.intelligence.repositoryId}@v${run.intelligence.analysisVersion ?? "unknown"}`;
        await this.runs.audit(run.id, run.repositoryId, "system", "project-dna.analysis", "ok", `snapshot=${run.repositorySnapshotId} complete=${run.intelligence.complete}`);
        await this.runs.save(run);
        run = await this.runs.transition(run, "IMPACT_ANALYSIS");
      }
      if (run.state === "IMPACT_ANALYSIS") {
        const files = run.intelligence?.files ?? [];
        const excerptPaths = files.filter((f) => /\.(ts|tsx|js|jsx|py)$/.test(f)).slice(0, 12);
        const excerpts = await readScopedFiles(integration.path, excerptPaths);
        const output = await model.analyzeAndPlan({
          issueTitle: run.issueTitle,
          issueBody: run.issueBody,
          clarificationAnswer: run.clarificationAnswer,
          baseCommitSha: run.baseCommitSha!,
          repositorySnapshotId: run.repositorySnapshotId!,
          intelligence: run.intelligence!,
          fileExcerpts: excerpts,
        });
        if (output.plan.baseCommitSha.toLowerCase() !== run.baseCommitSha!.toLowerCase()) {
          throw new Error(`Plan baseCommitSha ${output.plan.baseCommitSha} does not match run base ${run.baseCommitSha}`);
        }
        validatePlanSemantics(output.plan);
        run.analysis = output.analysis;
        run.plan = output.plan;
        // Resolve model-nominated targets against the real tree, then query Project DNA impact for them.
        const known = new Set(run.intelligence!.files);
        const targets = output.nominatedTargets.filter((t) => known.has(t)).slice(0, 20);
        run.nominatedTargets = targets;
        if (targets.length > 0) {
          run.intelligence = await intelligence.analyze({ rootPath: integration.path, baseCommitSha: run.baseCommitSha!, targetPaths: targets });
          run.impactSnapshotId = `${run.intelligence.repositoryId}@v${run.intelligence.analysisVersion ?? "unknown"}`;
          await this.runs.audit(run.id, run.repositoryId, "lead-planner", "project-dna.impact", "ok", `targets=${targets.join(",")} snapshot=${run.impactSnapshotId}`);
        }
        run.tasks = output.plan.tasks.map((t) => ({
          taskId: t.id,
          status: "pending",
          worktreePath: null,
          branch: null,
          changedPaths: [],
          commitSha: null,
          patchSummary: null,
          attempts: 0,
          error: null,
        }));
        await this.runs.save(run);
        run = await this.runs.transition(run, "ISSUE_PLANNING");
      }
      if (run.state === "ISSUE_PLANNING") {
        if (run.plan!.requiresHumanClarification && !run.clarificationAnswer) {
          run = await this.runs.transition(run, "NEEDS_CLARIFICATION");
          await this.runs.audit(run.id, run.repositoryId, "lead-planner", "clarification.requested", "info", run.plan!.unresolvedQuestions.join(" | "));
          return;
        }
        run = await this.runs.transition(run, "AWAITING_PLAN_APPROVAL");
        await this.runs.audit(run.id, run.repositoryId, "lead-planner", "plan.created", "ok", `tasks=${run.plan!.tasks.map((t) => t.id).join(",")}`);
        return; // pause for human approval
      }
      if (run.state === "NEEDS_CLARIFICATION" || run.state === "AWAITING_PLAN_APPROVAL") return;

      // ── AGENT_EXECUTION ─────────────────────────────────────────────────
      // Up to 2 tasks run concurrently, only when dependency-free relative to
      // each other and with disjoint file scopes (canRunInParallel). Each task
      // gets its own worktree; overlap is re-checked at integration time.
      if (run.state === "AGENT_EXECUTION") {
        const planTasks = new Map(run.plan!.tasks.map((t) => [t.id, t]));
        const executeOne = async (taskId: string): Promise<"ok" | "blocked" | "retry"> => {
          const task = planTasks.get(taskId)!;
          const record = run.tasks.find((t) => t.taskId === taskId)!;
          record.status = "running";
          record.attempts += 1;
          await this.runs.save(run);
          const { info: wt, reused: reusedWorktree } = await worktrees.createOrReuseWorktree(run.repositoryPath, run.id, task.id, run.baseCommitSha!);
          if (reusedWorktree) {
            // Retry/resume: a previous attempt may have left partial changes. Reset to the pinned base.
            await worktrees.resetToCommit(wt.path, run.baseCommitSha!);
            await this.runs.audit(run.id, run.repositoryId, "system", `task.${task.id}.worktree-reset`, "info", `reset to ${run.baseCommitSha}`);
          }
          record.worktreePath = wt.path;
          record.branch = wt.branch;
          try {
            const result = await codingAgent.execute(task, {
              issueTitle: run.issueTitle,
              issueBody: run.issueBody,
              worktreePath: wt.path,
              mcp: this.deps.mcp
                ? { runtime: this.deps.mcp, runId: run.id, repositoryId: run.repositoryId, signal: this.deps.mcp.signalForRun(run.id) }
                : undefined,
            });
            if (result.mcp?.warning) {
              await this.runs.audit(run.id, run.repositoryId, "mcp-orchestrator", `task.${task.id}.mcp`, "error", result.mcp.warning);
            }
            const { changedPaths } = await worktrees.collectDiff(wt.path);
            record.changedPaths = changedPaths;
            record.commitSha = await worktrees.commitAll(wt.path, `dnafix(${run.id}): ${task.title}`);
            record.patchSummary = result.summary;
            record.status = "completed";
            await this.runs.audit(run.id, run.repositoryId, "coding-agent", `task.${task.id}.completed`, "ok", `files=${changedPaths.join(",")} commit=${record.commitSha}`);
            await this.runs.save(run);
            return "ok";
          } catch (err) {
            record.status = "failed";
            record.error = err instanceof Error ? err.message : String(err);
            await this.runs.audit(run.id, run.repositoryId, "coding-agent", `task.${task.id}.failed`, "error", record.error);
            await this.runs.save(run);
            return record.attempts > task.retryLimit ? "blocked" : "retry";
          }
        };
        for (;;) {
          const pending = run.tasks.filter((t) => t.status !== "completed");
          if (pending.length === 0) break;
          const completedIds = new Set(run.tasks.filter((t) => t.status === "completed").map((t) => t.taskId));
          const ready = pending.filter((t) => (planTasks.get(t.taskId)?.dependsOn ?? []).every((d) => completedIds.has(d)));
          if (ready.length === 0) {
            run.error = "No runnable tasks remain (dependency failure or cycle)";
            await this.runs.save(run);
            run = await this.runs.transition(run, "BLOCKED");
            return;
          }
          const first = ready[0]!;
          const partner = ready.slice(1).find((other) => canRunInParallel(planTasks.get(first.taskId)!, planTasks.get(other.taskId)!));
          const batch = partner ? [first, partner] : [first];
          if (batch.length > 1) {
            await this.runs.audit(run.id, run.repositoryId, "lead-planner", "tasks.parallel", "info", batch.map((t) => t.taskId).join(" + "));
          }
          const outcomes = await Promise.all(batch.map((t) => executeOne(t.taskId)));
          run = (await this.runs.load(runId))!;
          if (outcomes.includes("blocked")) {
            const failed = run.tasks.find((t) => t.status === "failed");
            run.error = `Task ${failed?.taskId} failed after ${failed?.attempts} attempt(s): ${failed?.error}`;
            await this.runs.save(run);
            run = await this.runs.transition(run, "BLOCKED");
            return;
          }
          if (outcomes.includes("retry")) return this.execute(runId);
        }
        run = await this.runs.transition(run, "TASK_INTEGRATION");
      }

      // ── TASK_INTEGRATION ────────────────────────────────────────────────
      if (run.state === "TASK_INTEGRATION") {
        const overlaps = findOverlappingChanges(new Map(run.tasks.map((t) => [t.taskId, t.changedPaths])));
        if (overlaps.length > 0) {
          run.error = `Overlapping changes detected, integration unsafe: ${overlaps.map((o) => `${o.path} (${o.taskIds.join(", ")})`).join("; ")}`;
          await this.runs.audit(run.id, run.repositoryId, "system", "integration.overlap", "error", run.error);
          await this.runs.save(run);
          run = await this.runs.transition(run, "BLOCKED");
          return;
        }
        for (const task of integrationOrder(run.plan!.tasks)) {
          const record = run.tasks.find((t) => t.taskId === task.id)!;
          if (record.commitSha) await worktrees.integrateCommit(integration.path, record.commitSha);
        }
        const integrated = await worktrees.diffRange(integration.path, run.baseCommitSha!);
        run.diff = integrated.diff;
        run.changedPaths = integrated.changedPaths;
        await this.runs.audit(run.id, run.repositoryId, "system", "integration.completed", "ok", `files=${integrated.changedPaths.join(",")}`);
        await this.runs.save(run);
        run = await this.runs.transition(run, "FINAL_VERIFICATION");
      }

      // ── FINAL_VERIFICATION (+ bounded repair) ───────────────────────────
      if (run.state === "FINAL_VERIFICATION") {
        const baselineFailing = new Set(run.baselineChecks.filter((c) => c.status === "failed").map((c) => c.id));
        for (;;) {
          run.verificationChecks = await this.runVerificationChecks(run, integration.path, "final", baselineFailing);
          const comparison = compareImpact(
            run.plan!.predictedAffectedPaths.map((p) => p.path),
            run.changedPaths,
          );
          const reviewInput = {
            issueTitle: run.issueTitle,
            acceptanceCriteria: run.plan!.tasks.flatMap((t) => t.acceptanceCriteria),
            predictedPaths: run.plan!.predictedAffectedPaths.map((p) => p.path),
            changedPaths: run.changedPaths,
            diff: run.diff,
            checks: run.verificationChecks,
          };
          if (this.deps.mcp) {
            const { review, mcp: mcpPhase } = await verifier.reviewWithMcp(reviewInput, {
              runtime: this.deps.mcp,
              runId: run.id,
              repositoryId: run.repositoryId,
              signal: this.deps.mcp.signalForRun(run.id),
            });
            run.verifierReview = review;
            if (mcpPhase.warning) {
              await this.runs.audit(run.id, run.repositoryId, "mcp-orchestrator", "verification.mcp", "error", mcpPhase.warning);
            } else if (mcpPhase.calls > 0) {
              await this.runs.audit(run.id, run.repositoryId, "verification-agent", "verification.mcp", "ok", `calls=${mcpPhase.calls}`);
            }
          } else {
            run.verifierReview = await verifier.review(reviewInput);
          }
          await this.runs.audit(
            run.id,
            run.repositoryId,
            "verification-agent",
            "verification.completed",
            "ok",
            `checks=${run.verificationChecks.map((c) => `${c.kind}:${c.status}`).join(",")} unexpected=${comparison.unexpected.join(",") || "none"} verdict=${run.verifierReview.verdict} sandbox=${this.deps.sandboxNote}`,
          );
          const evaluation = evaluateVerification(run.verificationChecks, {
            baselineFailingIds: baselineFailing,
            waivers: run.verificationWaivers,
          });
          const review = run.verifierReview;
          await this.runs.audit(
            run.id,
            run.repositoryId,
            "verification-agent",
            "verification.completed",
            evaluation.ok && review?.verdict === "approve" ? "ok" : "info",
            `checks=${run.verificationChecks.map((c) => `${c.kind}:${c.status}`).join(",")} unexpected=${comparison.unexpected.join(",") || "none"} verdict=${review?.verdict ?? "missing"} evidence=${evaluation.regressionEvidence ? "baseline-failure-fixed" : "none"} repairable=${evaluation.repairable.length} needsHuman=${evaluation.needsHuman.length} sandbox=${this.deps.sandboxNote}`,
          );
          // Missing evidence is not repairable by an agent: it needs a waiver,
          // a test, or a human decision. Report the gap before the verdict so
          // the operator sees the root cause rather than the symptom.
          if (evaluation.needsHuman.length > 0) {
            run.error = `Verification evidence is incomplete: ${evaluation.needsHuman.join(" ")}${review ? ` Verifier: ${review.summary}` : ""}`;
            await this.runs.save(run);
            run = await this.runs.transition(run, "BLOCKED");
            return;
          }
          // An inconclusive or missing review is a human decision: repairing
          // cannot turn "we do not know" into evidence.
          if (!review || review.verdict === "uncertain") {
            run.error = `Verification requires human review: verifier verdict was ${review?.verdict ?? "missing"}. ${review?.summary ?? ""}`.trim();
            await this.runs.save(run);
            run = await this.runs.transition(run, "BLOCKED");
            return;
          }
          if (evaluation.ok && review.verdict === "approve") break;
          if (run.repairAttempts >= this.deps.maxRepairAttempts) {
            run.error = `Verification failed after ${run.repairAttempts} repair attempt(s). Checks: ${run.verificationChecks.map((c) => `${c.kind}:${c.status}`).join(", ")}; verifier: ${run.verifierReview.summary}`;
            await this.runs.save(run);
            run = await this.runs.transition(run, "BLOCKED");
            return;
          }
          run.repairAttempts += 1;
          await this.runs.save(run);
          await this.runs.audit(run.id, run.repositoryId, "lead-planner", "repair.attempt", "info", `attempt ${run.repairAttempts}/${this.deps.maxRepairAttempts}`);
          const failureContext = run.verificationChecks
            .filter((c) => c.status === "failed")
            .map((c) => `${c.kind}: exit=${c.result?.exitCode}\n${(c.result?.stderrSummary ?? "") + (c.result?.stdoutSummary ?? "")}`.slice(0, 3000))
            .join("\n---\n");
          const repairTask = {
            id: `repair-${run.repairAttempts}`,
            title: `Repair attempt ${run.repairAttempts}`,
            description: "Fix the failing verification checks with a minimal change.",
            expectedOutcome: "All previously failing checks pass.",
            fileScope: [...new Set([...run.changedPaths, ...run.plan!.predictedAffectedPaths.map((p) => p.path)])],
            dependsOn: [],
            acceptanceCriteria: run.plan!.tasks.flatMap((t) => t.acceptanceCriteria),
            testExpectations: [],
            retryLimit: 0,
          };
          try {
            // Repair tasks carry no approvedDeletions, so the deny-by-default
            // deletion policy rejects any delete they attempt (eval-v1 finding).
            const repair = await codingAgent.execute(repairTask, {
              issueTitle: run.issueTitle,
              issueBody: run.issueBody,
              worktreePath: integration.path,
              failureContext,
              mcp: this.deps.mcp
                ? { runtime: this.deps.mcp, runId: run.id, repositoryId: run.repositoryId, signal: this.deps.mcp.signalForRun(run.id) }
                : undefined,
            });
            if (repair.mcp?.warning) {
              await this.runs.audit(run.id, run.repositoryId, "mcp-orchestrator", "repair.mcp", "error", repair.mcp.warning);
            }
          } catch (err) {
            await this.runs.audit(run.id, run.repositoryId, "lead-planner", "repair.rejected", "error", err instanceof Error ? err.message.slice(0, 500) : String(err));
            continue; // counts as a failed repair attempt; loop re-verifies and enforces the attempt bound
          }
          await worktrees.commitAll(integration.path, `dnafix(${run.id}): repair ${run.repairAttempts}`);
          const refreshed = await worktrees.diffRange(integration.path, run.baseCommitSha!);
          run.diff = refreshed.diff;
          run.changedPaths = refreshed.changedPaths;
          await this.runs.save(run);
        }
        run = await this.runs.transition(run, "AWAITING_PR_APPROVAL");
        return; // pause for PR approval
      }
      if (run.state === "AWAITING_PR_APPROVAL") return;

      // ── PULL_REQUEST_CREATION ───────────────────────────────────────────
      if (run.state === "PULL_REQUEST_CREATION") {
        if (run.pullRequestUrl) {
          run = await this.runs.transition(run, "COMPLETED");
          return;
        }
        const repo = await store.getRepository(run.repositoryId);
        const installationId = repo?.githubInstallationId ?? run.githubInstallationId ?? process.env.GITHUB_INSTALLATION_ID;
        if (!repo?.githubOwner || !repo.githubRepo || !this.deps.github.appConfigured || !installationId) {
          // Local-patch delivery: honest completion without GitHub.
          await this.runs.audit(run.id, run.repositoryId, "system", "pull-request.skipped", "info", "GitHub App is not configured for this repository or repository is local-only; patch delivered as run diff.");
          run = await this.runs.transition(run, "COMPLETED");
          return;
        }
        const branch = `dnafix/${run.id}/integration`;
        const token = await this.deps.github.pushToken(installationId);
        await worktrees.pushBranchWithToken(integration.path, `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`, branch, token);
        const prBody = buildPrBody(run);
        const pr = await this.deps.github.createDraftPullRequest({
          owner: repo.githubOwner,
          repo: repo.githubRepo,
          title: `[DNAFix] ${run.issueTitle}`,
          body: prBody,
          head: branch,
          base: repo.defaultBranch ?? "main",
          installationId,
        });
        run.pullRequestUrl = pr.url;
        run.pullRequestNumber = pr.number;
        run.idempotency["create-pr"] = pr.url;
        await this.runs.audit(run.id, run.repositoryId, "user", "pull-request.created", "ok", pr.url);
        await this.runs.save(run);
        run = await this.runs.transition(run, "COMPLETED");
        return;
      }
    } catch (err) {
      const fresh = await this.runs.load(runId);
      if (!fresh || fresh.state === "CANCELLED") return;
      if (err instanceof RunConflictError) {
        // Another writer owns the row now (a cancel or a second worker). Stopping
        // here is the correct outcome; overwriting it would not be.
        await this.runs.audit(fresh.id, fresh.repositoryId, "system", "workflow.conflict", "error", err.message.slice(0, 500));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const blocked =
        err instanceof ModelNotConfiguredError ||
        err instanceof RepositoryIntelligenceError ||
        err instanceof GitHubNotConfiguredError ||
        (err as { name?: string }).name === "SandboxUnavailableError" ||
        (err as { name?: string }).name === "RemoteExecutionError" ||
        (err as { blocked?: boolean }).blocked === true;
      fresh.error = message;
      await this.runs.save(fresh);
      await this.runs.audit(fresh.id, fresh.repositoryId, "system", blocked ? "workflow.blocked" : "workflow.failed", "error", message.slice(0, 1000));
      if (blocked && fresh.state !== "BLOCKED") await this.runs.transition(fresh, "BLOCKED").catch(() => undefined);
      else if (!blocked && fresh.state !== "FAILED") await this.runs.transition(fresh, "FAILED").catch(() => undefined);
    } finally {
      this.deps.mcp?.releaseRun(runId);
    }
  }
}

export function buildPrBody(run: RunRecord): string {
  const checks = (run.verificationChecks ?? []).map((c) => `| ${c.kind} | ${c.status} | ${c.result ? `exit ${c.result.exitCode}` : "not executed"} |`).join("\n");
  const impact = (run.intelligence?.targets ?? [])
    .map((t) => `- \`${t.targetPath}\`: direct=${t.directImpacted.join(", ") || "none"}; transitive=${t.transitiveImpacted.join(", ") || "none"}`)
    .join("\n");
  return [
    run.issueNumber ? `Refs #${run.issueNumber}` : "",
    `## Problem\n${run.issueBody}`,
    `## Implementation summary\n${run.tasks.map((t) => `- ${t.taskId}: ${t.patchSummary ?? t.status} (${t.changedPaths.join(", ")})`).join("\n")}`,
    `## Files changed\n${run.changedPaths.map((p) => `- \`${p}\``).join("\n")}`,
    `## Project DNA impact\n${impact || "No targeted impact queries were run."}\nAnalysis complete: ${run.intelligence?.complete ?? "unknown"}. Warnings: ${(run.intelligence?.warnings ?? []).join("; ") || "none"}`,
    `## Verification\n| Check | Status | Evidence |\n|---|---|---|\n${checks}`,
    `Verifier verdict: ${run.verifierReview?.verdict ?? "not run"} — ${run.verifierReview?.summary ?? ""}`,
    `## Risks and remaining concerns\n${(run.verifierReview?.unintendedChanges ?? []).join("; ") || "None recorded."} Repair attempts: ${run.repairAttempts}. Model provider: ${run.modelProvider}.`,
    `_Created by DNAFix as a draft for human review. DNAFix never merges._`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export { canRunInParallel };
