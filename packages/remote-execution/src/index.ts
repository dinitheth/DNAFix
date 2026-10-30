import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Remote execution port. Domain/orchestration code depends only on this
 * interface; AWS CodeBuild is one adapter behind it. No AWS SDK types leak
 * into the application layer. See docs/AWS_EXECUTION.md.
 */
export interface RemoteJobSpec {
  /** Local workspace directory to upload and execute in. Treated as untrusted content. */
  workspacePath: string;
  /** Command as an argv array. Never a shell string. Rendered into the buildspec by the adapter. */
  argv: string[];
  timeoutMinutes: number;
}

export interface RemoteJobResult {
  provider: string;
  jobId: string;
  status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ERROR";
  /** Console deep link (CloudWatch Logs / CodeBuild console) when the provider supplies one. */
  logsReference: string | null;
  artifactsDownloadedTo: string | null;
  summary: string;
}

export interface RemoteExecutionProvider {
  readonly name: string;
  /** True only when every required configuration value is present. Never fabricates availability. */
  configured(): boolean;
  runJob(spec: RemoteJobSpec): Promise<RemoteJobResult>;
}

export type CliRunner = (argv: string[]) => Promise<string>;

export function spawnCliRunner(): CliRunner {
  return (argv) =>
    new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { shell: false, windowsHide: true, env: process.env });
      let out = "";
      let err = "";
      child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${argv.join(" ")} exited ${code}: ${err.slice(0, 500)}`))));
    });
}

const StartBuildOutputSchema = z.object({ build: z.object({ id: z.string(), arn: z.string().optional() }).passthrough() }).passthrough();
const BatchGetBuildsOutputSchema = z
  .object({
    builds: z.array(
      z
        .object({
          id: z.string(),
          buildStatus: z.string(),
          logs: z.object({ deepLink: z.string().optional() }).passthrough().optional(),
          artifacts: z.object({ location: z.string().optional() }).passthrough().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function posixQuote(arg: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function buildspecFor(argv: string[]): string {
  return [
    "version: 0.2",
    "phases:",
    "  build:",
    "    commands:",
    `      - ${argv.map(posixQuote).join(" ")}`,
    "artifacts:",
    "  files:",
    "    - '**/*'",
    "  discard-paths: no",
    "",
  ].join("\n");
}

export interface CodeBuildConfig {
  profile: string;
  region: string;
  projectName: string;
  artifactsBucket: string;
  cleanupInputs?: boolean;
}

/**
 * AWS CodeBuild adapter. Invokes the AWS CLI (profile-based credentials from
 * `aws login`) so DNAFix carries no AWS SDK dependency. Security properties:
 * credentials come from the local AWS profile only and are never placed in the
 * build environment; repository code runs in CodeBuild's managed environment,
 * never with DNAFix host credentials; privileged mode is never requested.
 * Requires a pre-provisioned CodeBuild project + S3 bucket (see AWS_EXECUTION.md);
 * it creates no infrastructure itself.
 */
export class CodeBuildExecutionProvider implements RemoteExecutionProvider {
  readonly name = "aws-codebuild";
  constructor(
    private readonly config: CodeBuildConfig,
    private readonly cli: CliRunner = spawnCliRunner(),
    private readonly pollIntervalMs = 15_000,
  ) {}

  configured(): boolean {
    return Boolean(this.config.profile && this.config.region && this.config.projectName && this.config.artifactsBucket);
  }

  private aws(args: string[]): string[] {
    return ["aws", ...args, "--profile", this.config.profile, "--region", this.config.region, "--output", "json"];
  }

  async runJob(spec: RemoteJobSpec): Promise<RemoteJobResult> {
    if (!this.configured()) {
      throw new Error("CodeBuild provider is not configured (AWS_CODEBUILD_PROJECT and AWS_ARTIFACTS_BUCKET required). No remote job was started.");
    }
    if (spec.timeoutMinutes < 1 || spec.timeoutMinutes > 120) throw new Error("timeoutMinutes must be between 1 and 120 (cost bound)");
    const jobId = `dnafix-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const staging = await mkdtemp(path.join(tmpdir(), "dnafix-remote-"));
    const zipPath = path.join(staging, `${jobId}.zip`);
    const inputKey = `input/${jobId}.zip`;
    const fingerprint = createHash("sha256").update(spec.workspacePath).digest("hex").slice(0, 12);
    try {
      await this.cli(["tar", "-a", "-cf", zipPath, "-C", spec.workspacePath, "."]);
      await this.cli(this.aws(["s3", "cp", zipPath, `s3://${this.config.artifactsBucket}/${inputKey}`, "--metadata", `workspace=${fingerprint}`]));
      const started = StartBuildOutputSchema.parse(
        JSON.parse(
          await this.cli(
            this.aws([
              "codebuild",
              "start-build",
              "--project-name",
              this.config.projectName,
              "--source-type-override",
              "S3",
              "--source-location",
              `${this.config.artifactsBucket}/${inputKey}`,
              "--buildspec-override",
              buildspecFor(spec.argv),
              "--timeout-in-minutes-override",
              String(spec.timeoutMinutes),
              "--compute-type-override",
              "BUILD_GENERAL1_SMALL",
              "--idempotency-token",
              jobId,
            ]),
          ),
        ),
      );
      const buildId = started.build.id;
      const deadline = Date.now() + (spec.timeoutMinutes + 5) * 60_000;
      for (;;) {
        const status = BatchGetBuildsOutputSchema.parse(JSON.parse(await this.cli(this.aws(["codebuild", "batch-get-builds", "--ids", buildId]))));
        const build = status.builds[0];
        if (!build) throw new Error(`CodeBuild build ${buildId} disappeared`);
        if (build.buildStatus === "IN_PROGRESS") {
          if (Date.now() > deadline) {
            await this.cli(this.aws(["codebuild", "stop-build", "--id", buildId])).catch(() => "");
            return { provider: this.name, jobId: buildId, status: "TIMED_OUT", logsReference: build.logs?.deepLink ?? null, artifactsDownloadedTo: null, summary: "Local poll deadline exceeded; build stop requested." };
          }
          await new Promise((r) => setTimeout(r, this.pollIntervalMs));
          continue;
        }
        let artifactsDownloadedTo: string | null = null;
        const location = build.artifacts?.location;
        if (build.buildStatus === "SUCCEEDED" && location?.startsWith("arn:aws:s3:::")) {
          const s3Path = `s3://${location.slice("arn:aws:s3:::".length)}`;
          artifactsDownloadedTo = path.join(staging, "artifacts");
          await this.cli(this.aws(["s3", "cp", s3Path, artifactsDownloadedTo, "--recursive"])).catch(() => {
            artifactsDownloadedTo = null;
          });
        }
        return {
          provider: this.name,
          jobId: buildId,
          status: build.buildStatus === "SUCCEEDED" ? "SUCCEEDED" : build.buildStatus === "TIMED_OUT" ? "TIMED_OUT" : "FAILED",
          logsReference: build.logs?.deepLink ?? null,
          artifactsDownloadedTo,
          summary: `CodeBuild status: ${build.buildStatus}`,
        };
      }
    } finally {
      if (this.config.cleanupInputs !== false) {
        await this.cli(this.aws(["s3", "rm", `s3://${this.config.artifactsBucket}/${inputKey}`])).catch(() => undefined);
      }
    }
  }
}

export function codeBuildProviderFromEnv(cli?: CliRunner): CodeBuildExecutionProvider {
  return new CodeBuildExecutionProvider(
    {
      profile: process.env.AWS_PROFILE ?? "dnafix-dev",
      region: process.env.AWS_REGION ?? "ap-southeast-2",
      projectName: process.env.AWS_CODEBUILD_PROJECT ?? "",
      artifactsBucket: process.env.AWS_ARTIFACTS_BUCKET ?? "",
      cleanupInputs: process.env.AWS_REMOTE_CLEANUP !== "false",
    },
    cli,
  );
}
