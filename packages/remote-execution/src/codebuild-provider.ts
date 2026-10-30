import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { buildspecForCommands } from "./buildspec.js";
import { createSourceBundle, s3KeysForRun } from "./bundle.js";
import { idempotencyTokenFor, validateManifest, type ExecutionCommand, type ExecutionManifest } from "./manifest.js";
import { isTerminalStatus, mapBuildStatus, parseCheckMarkers, type ExecutionStatus } from "./status.js";
import type { AwsClients } from "./aws-operations.js";
import { createAwsClients } from "./aws-operations.js";
import { RunRoleManager } from "./run-role.js";

/**
 * Remote execution port. Domain/orchestration code depends only on this
 * interface; AWS is one adapter behind it. No AWS SDK types leak upward.
 */
export interface RemoteJobSpec {
  runId: string;
  workspacePath: string;
  baseCommitSha: string;
  /** Approved verification commands (validated argv arrays). Never shell strings, never repo-supplied buildspec. */
  commands: ExecutionCommand[];
  timeoutMinutes: number;
}

export interface RemoteCheckResult {
  id: string;
  kind: string;
  exitCode: number | null;
}

export interface RemoteJobResult {
  provider: string;
  runId: string;
  jobId: string | null;
  status: ExecutionStatus;
  sourceKey: string | null;
  manifestKey: string | null;
  sourceSha256: string | null;
  artifactsLocation: string | null;
  logsReference: string | null;
  logExcerpt: string;
  checkResults: RemoteCheckResult[];
  summary: string;
  durationMs: number;
  /** Per-run scoped IAM role used for this build, and whether cleanup deleted it. */
  executionRole?: { arn: string; deleted: boolean } | null;
}

export interface RemoteExecutionProvider {
  readonly name: string;
  configured(): boolean;
  runJob(spec: RemoteJobSpec): Promise<RemoteJobResult>;
  cancel(jobId: string): Promise<void>;
}

export interface CodeBuildConfig {
  profile: string;
  region: string;
  projectName: string;
  artifactsBucket: string;
  logGroupName: string;
  /** AWS account ID (for log-group ARNs in per-run role policies). Not a secret. */
  accountId?: string;
  /** Per-run scoped IAM roles. Default true; disabling requires an explicit, recorded decision. */
  perRunRoles?: boolean;
}

function defaultGitRunner(cwd: string): (args: string[]) => Promise<string> {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")} exited ${code}: ${err.slice(0, 300)}`))));
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CodeBuildExecutionProvider implements RemoteExecutionProvider {
  readonly name = "aws-codebuild";
  constructor(
    private readonly config: CodeBuildConfig,
    private readonly clients: AwsClients,
    private readonly pollIntervalMs = 15_000,
    private readonly pollTimeoutMs?: number,
  ) {}

  configured(): boolean {
    return Boolean(this.config.region && this.config.projectName && this.config.artifactsBucket);
  }

  async cancel(jobId: string): Promise<void> {
    await this.clients.codebuild.stopBuild(jobId);
  }

  async runJob(spec: RemoteJobSpec): Promise<RemoteJobResult> {
    const startedAt = Date.now();
    if (!this.configured()) {
      throw new Error("CodeBuild provider is not configured (AWS_CODEBUILD_PROJECT and AWS_ARTIFACT_BUCKET required). No remote job was started and no local fallback was attempted.");
    }
    if (spec.timeoutMinutes < 1 || spec.timeoutMinutes > 20) throw new Error("timeoutMinutes must be between 1 and 20 (project cost bound)");
    if (spec.commands.length === 0) throw new Error("Execution manifest requires at least one approved command");

    const keys = s3KeysForRun(spec.runId);
    const bundle = await createSourceBundle(spec.workspacePath, defaultGitRunner(spec.workspacePath));
    const manifest: ExecutionManifest = validateManifest({
      version: 1,
      runId: spec.runId,
      baseCommitSha: spec.baseCommitSha,
      createdAt: new Date().toISOString(),
      timeoutMinutes: spec.timeoutMinutes,
      sourceSha256: bundle.sha256,
      commands: spec.commands,
    });

    const base: RemoteJobResult = {
      provider: this.name,
      runId: spec.runId,
      jobId: null,
      status: "SUBMITTED",
      sourceKey: keys.sourceKey,
      manifestKey: keys.manifestKey,
      sourceSha256: bundle.sha256,
      artifactsLocation: null,
      logsReference: null,
      logExcerpt: "",
      checkResults: spec.commands.map((c) => ({ id: c.id, kind: c.kind, exitCode: null })),
      summary: "",
      durationMs: 0,
    };

    await this.clients.s3.putObject({
      bucket: this.config.artifactsBucket,
      key: keys.sourceKey,
      body: await readFile(bundle.zipPath),
      contentType: "application/zip",
      metadata: { sha256: bundle.sha256, runid: spec.runId },
    });
    await this.clients.s3.putObject({
      bucket: this.config.artifactsBucket,
      key: keys.manifestKey,
      body: JSON.stringify(manifest, null, 2),
      contentType: "application/json",
      metadata: { runid: spec.runId },
    });

    // Per-run scoped execution role. Failure here aborts the job: DNAFix never
    // falls back to the shared project role for untrusted code execution.
    let runRole: { roleName: string; arn: string } | null = null;
    let roleManager: RunRoleManager | null = null;
    if (this.config.perRunRoles !== false) {
      if (!this.config.accountId) {
        throw new Error("Per-run role isolation requires AWS_ACCOUNT_ID (used for log-group ARNs in the scoped policy). Refusing to run under the shared project role.");
      }
      roleManager = new RunRoleManager(
        this.clients.iam,
        {
          bucket: this.config.artifactsBucket,
          region: this.config.region,
          accountId: this.config.accountId,
          logGroupName: this.config.logGroupName,
        },
        Number(process.env.DNAFIX_ROLE_PROPAGATION_MS ?? 8_000),
      );
      runRole = await roleManager.createRunRole(spec.runId);
    }

    const { buildId } = await this.clients.codebuild.startBuild({
      projectName: this.config.projectName,
      sourceLocation: `${this.config.artifactsBucket}/${keys.sourceKey}`,
      buildspec: buildspecForCommands(manifest.commands),
      artifactsLocation: this.config.artifactsBucket,
      artifactsPath: `runs/${spec.runId}/artifacts`,
      timeoutInMinutes: manifest.timeoutMinutes,
      idempotencyToken: idempotencyTokenFor(spec.runId, bundle.sha256),
      ...(runRole ? { serviceRoleArn: runRole.arn } : {}),
    }).catch(async (err: Error) => {
      if (runRole && roleManager) await roleManager.deleteRunRole(runRole.roleName);
      throw err;
    });
    base.jobId = buildId;
    const cleanupRole = async (): Promise<boolean> => {
      if (!runRole || !roleManager) return true;
      const deleted = await roleManager.deleteRunRole(runRole.roleName);
      return deleted;
    };

    const deadline = Date.now() + (this.pollTimeoutMs ?? (manifest.timeoutMinutes + 2) * 60_000);
    let build: Awaited<ReturnType<AwsClients["codebuild"]["batchGetBuilds"]>>[number] | undefined;
    for (;;) {
      const builds = await this.clients.codebuild.batchGetBuilds([buildId]);
      build = builds[0];
      if (!build) throw new Error(`CodeBuild build ${buildId} disappeared`);
      const status = mapBuildStatus(build.status);
      if (isTerminalStatus(status)) break;
      if (Date.now() > deadline) {
        await this.clients.codebuild.stopBuild(buildId).catch(() => undefined);
        const deleted = await cleanupRole();
        return {
          ...base,
          status: "TIMED_OUT",
          artifactsLocation: build.artifactsLocation,
          logsReference: build.logsDeepLink,
          summary: `Poll deadline (${manifest.timeoutMinutes + 2} min) exceeded; stop requested for build ${buildId}.`,
          durationMs: Date.now() - startedAt,
          executionRole: runRole ? { arn: runRole.arn, deleted } : null,
        };
      }
      await sleep(this.pollIntervalMs);
    }

    let status = mapBuildStatus(build!.status);
    let logText = "";
    let logsError: string | null = null;
    const logGroupName = build!.logGroupName ?? this.config.logGroupName;
    if (build!.logStreamName) {
      try {
        logText = await this.clients.logs.getLogText({ logGroupName, logStreamName: build!.logStreamName, maxEvents: 5000 });
      } catch (err) {
        logsError = err instanceof Error ? err.message : String(err);
      }
    } else {
      logsError = "CodeBuild returned no log stream for this build";
    }
    if (logsError && status === "SUCCEEDED") {
      // Log retrieval failure must never be reported as a successful build.
      status = "FAILED";
    }
    const markers = parseCheckMarkers(logText);
    const checkResults = spec.commands.map((c) => ({ id: c.id, kind: c.kind, exitCode: markers.get(c.id) ?? null }));
    const roleDeleted = await cleanupRole();
    return {
      ...base,
      status,
      artifactsLocation: build!.artifactsLocation,
      logsReference: build!.logsDeepLink,
      logExcerpt: logText.slice(-12_000),
      checkResults,
      summary: logsError
        ? `CodeBuild status: ${build!.status}; log retrieval failed: ${logsError}`
        : `CodeBuild status: ${build!.status}; checks: ${checkResults.map((c) => `${c.id}=${c.exitCode ?? "unknown"}`).join(", ")}`,
      durationMs: Date.now() - startedAt,
      executionRole: runRole ? { arn: runRole.arn, deleted: roleDeleted } : null,
    };
  }
}

export function codeBuildProviderFromEnv(clients?: AwsClients): CodeBuildExecutionProvider {
  const region = process.env.AWS_REGION ?? "ap-southeast-2";
  return new CodeBuildExecutionProvider(
    {
      profile: process.env.AWS_PROFILE ?? "dnafix-dev",
      region,
      projectName: process.env.AWS_CODEBUILD_PROJECT ?? "",
      artifactsBucket: process.env.AWS_ARTIFACT_BUCKET ?? process.env.AWS_ARTIFACTS_BUCKET ?? "",
      logGroupName: process.env.AWS_CLOUDWATCH_LOG_GROUP ?? "/aws/codebuild/dnafix-build",
      accountId: process.env.AWS_ACCOUNT_ID ?? "",
      perRunRoles: process.env.DNAFIX_PER_RUN_ROLES !== "false",
    },
    clients ?? createAwsClients(region),
  );
}
