import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent, CreateRunRequest } from "@dnafix/contracts";
import { assertTransition, canRunInParallel, findOverlappingChanges, integrationOrder, validatePlanSemantics } from "@dnafix/domain";
import { createCommandRunner, type CommandRunner } from "@dnafix/execution";
import { GitWorktreeManager, cloneRepository } from "@dnafix/git-engine";
import { GitHubAdapter, GitHubNotConfiguredError } from "@dnafix/github";
import { MetaModelProvider, ModelNotConfiguredError, createModelProviderFromEnv, type ModelProvider } from "@dnafix/model-provider";
import { FileStore, type RunRecord, type Store } from "@dnafix/persistence";
import { ProjectDNAAdapter, RepositoryIntelligenceError, type RepositoryIntelligence } from "@dnafix/repository-intelligence";
import { checksPassed, compareImpact, discoverChecks, runChecks } from "@dnafix/verification";
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
}

export function createDefaultDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  const dataRoot = process.env.DNAFIX_DATA_DIR ?? path.resolve(process.cwd(), ".data");
  const runner = createCommandRunner();
  return {
    store: new FileStore(path.join(dataRoot, "dnafix.json")),
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
    ...overrides,
  };
}

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

export class RunService {
  constructor(private readonly deps: PipelineDeps) {}

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
    await this.deps.store.saveRepository({
      id: repositoryId,
      localPath: repositoryPath,
      githubOwner: req.githubOwner ?? null,
      githubRepo: req.githubRepo ?? null,
      defaultBranch: null,
      lastAnalyzedCommitSha: null,
      createdAt: now(),
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
    };
    await this.deps.store.saveRun(run);
    await this.audit(run.id, run.repositoryId, "user", "run.created", "ok", `issue: ${req.issueTitle}`);
    return run;
  }

  async audit(runId: string | null, repositoryId: string | null, actor: AuditEvent["actor"], action: string, result: AuditEvent["result"], evidence: string | null): Promise<void> {
    await this.deps.store.appendAudit({ id: id("evt"), runId, repositoryId, actor, action, result, evidence, createdAt: now() });
  }

  async transition(run: RunRecord, to: RunRecord["state"]): Promise<RunRecord> {
    assertTransition(run.state, to);
    run.state = to;
    run.updatedAt = now();
    await this.deps.store.saveRun(run);
    await this.audit(run.id, run.repositoryId, "system", `workflow.${to.toLowerCase()}`, "info", null);
    return run;
  }

  async save(run: RunRecord): Promise<void> {
    run.updatedAt = now();
    await this.deps.store.saveRun(run);
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
    const initial = await store.getRun(runId);
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
          await cloneRepository(`https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`, run.repositoryPath);
          await this.runs.audit(run.id, run.repositoryId, "system", "repository.cloned", "ok", run.repositoryPath);
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
            const result = await codingAgent.execute(task, { issueTitle: run.issueTitle, issueBody: run.issueBody, worktreePath: wt.path });
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
          run = (await store.getRun(runId))!;
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
          run.verifierReview = await verifier.review({
            issueTitle: run.issueTitle,
            acceptanceCriteria: run.plan!.tasks.flatMap((t) => t.acceptanceCriteria),
            predictedPaths: run.plan!.predictedAffectedPaths.map((p) => p.path),
            changedPaths: run.changedPaths,
            diff: run.diff,
            checks: run.verificationChecks,
          });
          await this.runs.audit(
            run.id,
            run.repositoryId,
            "verification-agent",
            "verification.completed",
            "ok",
            `checks=${run.verificationChecks.map((c) => `${c.kind}:${c.status}`).join(",")} unexpected=${comparison.unexpected.join(",") || "none"} verdict=${run.verifierReview.verdict} sandbox=${this.deps.sandboxNote}`,
          );
          const ok = checksPassed(run.verificationChecks) && run.verifierReview.verdict !== "request-changes";
          if (ok) break;
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
            await codingAgent.execute(repairTask, { issueTitle: run.issueTitle, issueBody: run.issueBody, worktreePath: integration.path, failureContext });
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
        if (!repo?.githubOwner || !repo.githubRepo || !this.deps.github.configured) {
          // Local-patch delivery: honest completion without GitHub.
          await this.runs.audit(run.id, run.repositoryId, "system", "pull-request.skipped", "info", "GitHub not configured or repository is local-only; patch delivered as run diff.");
          run = await this.runs.transition(run, "COMPLETED");
          return;
        }
        const branch = `dnafix/${run.id}/integration`;
        const token = await this.deps.github.pushToken();
        await worktrees.pushBranch(integration.path, `https://x-access-token:${token}@github.com/${repo.githubOwner}/${repo.githubRepo}.git`, branch);
        const prBody = buildPrBody(run);
        const pr = await this.deps.github.createDraftPullRequest({
          owner: repo.githubOwner,
          repo: repo.githubRepo,
          title: `[DNAFix] ${run.issueTitle}`,
          body: prBody,
          head: branch,
          base: repo.defaultBranch ?? "main",
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
      const fresh = await store.getRun(runId);
      if (!fresh || fresh.state === "CANCELLED") return;
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
