import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { buildspecForCommands } from "./buildspec.js";
import { createSourceBundle, s3KeysForRun } from "./bundle.js";
import { idempotencyTokenFor, validateManifest, type ExecutionCommand, type ExecutionManifest } from "./manifest.js";
import { isTerminalStatus, mapBuildStatus, parseCheckMarkers, type ExecutionStatus } from "./status.js";
import type { AwsClients } from "./aws-operations.js";
import { createAwsClients } from "./aws-operations.js";
import { RunRoleManager, type RoleCleanupRecord } from "./run-role.js";
import { createHash } from "node:crypto";

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
  /** Full per-run role cleanup record (revocation + deletion + containment). */
  executionRole?: RoleCleanupRecord | null;
  sourceVerified?: boolean;
  sourceVersionId?: string | null;
  artifactIntegrity?: { location: string; sha256: string | null; verified: boolean; error: string | null } | null;
}

export interface RemoteExecutionProvider {
  readonly name: string;
  configured(): boolean;
  runJob(spec: RemoteJobSpec): Promise<RemoteJobResult>;
  cancel(jobId: string): Promise<{ status: string }>;
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

  /** Requests StopBuild and returns the status CodeBuild reports (the build may already have completed — races are reported, not assumed). */
  async cancel(jobId: string): Promise<{ status: string }> {
    return this.clients.codebuild.stopBuild(jobId);
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

    const checksumBase64 = Buffer.from(bundle.sha256, "hex").toString("base64");
    await this.clients.s3.putObject({
      bucket: this.config.artifactsBucket,
      key: keys.sourceKey,
      body: await readFile(bundle.zipPath),
      contentType: "application/zip",
      metadata: { sha256: bundle.sha256, runid: spec.runId },
      checksumSha256Base64: checksumBase64,
    });
    // Integrity: an upload acknowledgement is not proof. Verify the stored object.
    const head = await this.clients.s3.headObject({ bucket: this.config.artifactsBucket, key: keys.sourceKey });
    const sourceVerified = head.metadataSha256 === bundle.sha256 || head.checksumSha256 === checksumBase64;
    if (!sourceVerified) {
      throw new Error(`Source integrity verification failed for ${keys.sourceKey}: expected SHA-256 ${bundle.sha256}, S3 reports metadata=${head.metadataSha256} checksum=${head.checksumSha256}`);
    }
    base.sourceVerified = true;
    base.sourceVersionId = head.versionId;
    await this.clients.s3.putObject({
      bucket: this.config.artifactsBucket,
      key: keys.manifestKey,
      body: JSON.stringify(manifest, null, 2),
      contentType: "application/json",
      metadata: { runid: spec.runId },
    });
    // Manifest integrity: re-read and validate the stored manifest against this run.
    const storedManifest = validateManifest(JSON.parse(await this.clients.s3.getObjectText({ bucket: this.config.artifactsBucket, key: keys.manifestKey })) as unknown);
    if (storedManifest.runId !== spec.runId || storedManifest.sourceSha256 !== bundle.sha256) {
      throw new Error(`Manifest integrity verification failed for ${keys.manifestKey}: stored runId/sourceSha256 do not match this run`);
    }
    base.sourceVerified = true;

    // Per-run scoped execution role. Failure here aborts the job: DNAFix never
    // falls back to the shared project role for untrusted code execution.
    let cleanupRecord: RoleCleanupRecord | null = null;
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
          projectName: this.config.projectName,
        },
        Number(process.env.DNAFIX_ROLE_PROPAGATION_MS ?? 8_000),
      );
      const created = await roleManager.createRunRole(spec.runId);
      cleanupRecord = created.record;
    }

    const { buildId } = await this.clients.codebuild.startBuild({
      projectName: this.config.projectName,
      sourceLocation: `${this.config.artifactsBucket}/${keys.sourceKey}`,
      buildspec: buildspecForCommands(manifest.commands),
      artifactsLocation: this.config.artifactsBucket,
      artifactsPath: `runs/${spec.runId}/artifacts`,
      timeoutInMinutes: manifest.timeoutMinutes,
      idempotencyToken: idempotencyTokenFor(spec.runId, bundle.sha256),
      ...(cleanupRecord?.roleArn ? { serviceRoleArn: cleanupRecord.roleArn } : {}),
    }).catch(async (err: Error) => {
      if (cleanupRecord && roleManager) await roleManager.quarantine(cleanupRecord);
      throw err;
    });
    base.jobId = buildId;
    // Unified containment: every termination path quarantines the role
    // (deny-assume + deny-all + session revocation). Deletion is deferred to
    // the reaper after deleteNotBefore — never immediate.
    const cleanupRole = async (): Promise<void> => {
      if (cleanupRecord && roleManager) await roleManager.quarantine(cleanupRecord);
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
        await cleanupRole();
        return {
          ...base,
          status: "TIMED_OUT",
          artifactsLocation: build.artifactsLocation,
          logsReference: build.logsDeepLink,
          summary: `Poll deadline (${manifest.timeoutMinutes + 2} min) exceeded; stop requested for build ${buildId}.`,
          durationMs: Date.now() - startedAt,
          executionRole: cleanupRecord,
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

    // Artifact integrity: retrieve the produced artifact, confine it to this
    // run's prefix (cross-run artifacts are rejected), and hash it.
    let artifactIntegrity: RemoteJobResult["artifactIntegrity"] = null;
    if (build!.artifactsLocation) {
      const location = build!.artifactsLocation.replace(/^arn:aws:s3:::/, "");
      const slash = location.indexOf("/");
      const artifactBucket = slash > 0 ? location.slice(0, slash) : this.config.artifactsBucket;
      const artifactKey = slash > 0 ? location.slice(slash + 1) : location;
      try {
        if (artifactBucket !== this.config.artifactsBucket || !artifactKey.startsWith(`runs/${spec.runId}/artifacts`)) {
          throw new Error(`artifact location ${location} is outside runs/${spec.runId}/artifacts (possible cross-run artifact)`);
        }
        const bytes = await this.clients.s3.getObjectBytes({ bucket: artifactBucket, key: artifactKey });
        artifactIntegrity = { location, sha256: createHash("sha256").update(bytes).digest("hex"), verified: true, error: null };
      } catch (err) {
        artifactIntegrity = { location, sha256: null, verified: false, error: err instanceof Error ? err.message : String(err) };
        if (status === "SUCCEEDED") status = "FAILED";
      }
    } else if (status === "SUCCEEDED") {
      artifactIntegrity = { location: "", sha256: null, verified: false, error: "build succeeded but produced no artifact location" };
      status = "FAILED";
    }

    await cleanupRole();
    return {
      ...base,
      status,
      artifactsLocation: build!.artifactsLocation,
      logsReference: build!.logsDeepLink,
      logExcerpt: logText.slice(-12_000),
      checkResults,
      summary: logsError
        ? `CodeBuild status: ${build!.status}; log retrieval failed: ${logsError}`
        : `CodeBuild status: ${build!.status}; checks: ${checkResults.map((c) => `${c.id}=${c.exitCode ?? "unknown"}`).join(", ")}${artifactIntegrity && !artifactIntegrity.verified ? `; artifact integrity FAILED: ${artifactIntegrity.error}` : ""}`,
      durationMs: Date.now() - startedAt,
      executionRole: cleanupRecord,
      artifactIntegrity,
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
