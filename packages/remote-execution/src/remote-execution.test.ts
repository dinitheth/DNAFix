import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildspecForCommands } from "./buildspec.js";
import { createSourceBundle, isExcludedFromBundle, s3KeysForRun } from "./bundle.js";
import { parsePolicyDocument, validateExecutionRolePolicy } from "./iam-validation.js";
import { idempotencyTokenFor, validateManifest } from "./manifest.js";
import { isSuccessStatus, mapBuildStatus, parseCheckMarkers } from "./status.js";
import { CodeBuildExecutionProvider } from "./codebuild-provider.js";
import type { AwsClients, BuildInfo } from "./aws-operations.js";

const exec = promisify(execFile);

describe("source bundle", () => {
  it("excludes secrets, credentials, node_modules, .git and build output", () => {
    for (const p of [".env", ".env.local", "config/.env.production", "node_modules/x/index.js", ".git/config", "certs/key.pem", "home/.aws/credentials", "dist/app.js", "src/id_rsa"]) {
      expect(isExcludedFromBundle(p), p).toBe(true);
    }
    for (const p of ["src/index.ts", "package.json", "test/a.test.mjs", "README.md"]) {
      expect(isExcludedFromBundle(p), p).toBe(false);
    }
  });

  it("uses the isolated runs/<run-id>/ S3 layout", () => {
    expect(s3KeysForRun("run_abc-123")).toEqual({
      sourceKey: "runs/run_abc-123/source.zip",
      manifestKey: "runs/run_abc-123/manifest.json",
      artifactsPrefix: "runs/run_abc-123/artifacts/",
      reportsPrefix: "runs/run_abc-123/reports/",
    });
    expect(() => s3KeysForRun("../evil")).toThrow(/Invalid runId/);
  });

  it("packages a real git worktree with exclusions and a stable SHA-256", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-bundle-"));
    const git = (args: string[]) => exec("git", args, { cwd: root }).then((r) => r.stdout);
    await git(["init", "-b", "main"]);
    await writeFile(path.join(root, "package.json"), "{}");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};");
    await writeFile(path.join(root, ".env"), "SECRET=1");
    await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "junk", "x.js"), "x");
    const bundle = await createSourceBundle(root, git);
    expect(bundle.files).toContain("src/index.ts");
    expect(bundle.files).not.toContain(".env");
    expect(bundle.files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.bytes).toBeGreaterThan(0);
  });
});

describe("execution manifest", () => {
  it("validates manifests and rejects unsafe commands", () => {
    const good = { version: 1, runId: "run_1", baseCommitSha: "abc1234", createdAt: new Date().toISOString(), timeoutMinutes: 10, sourceSha256: "a".repeat(64), commands: [{ id: "test", kind: "test", argv: ["npm", "run", "test"] }] };
    expect(validateManifest(good).commands[0]?.id).toBe("test");
    expect(() => validateManifest({ ...good, timeoutMinutes: 60 })).toThrow();
    expect(() => validateManifest({ ...good, commands: [] })).toThrow();
  });

  it("derives a stable idempotency token (duplicate submissions are safe)", () => {
    const sha = "b".repeat(64);
    expect(idempotencyTokenFor("run_1", sha)).toBe(idempotencyTokenFor("run_1", sha));
    expect(idempotencyTokenFor("run_1", sha)).not.toBe(idempotencyTokenFor("run_1", "c".repeat(64)));
  });
});

describe("buildspec + status", () => {
  it("generates marker-wrapped commands and fails the build if any check fails", () => {
    const spec = buildspecForCommands([{ id: "test", kind: "test", argv: ["npm", "run", "test"] }]);
    expect(spec).toContain("DNAFIX_CHECK_BEGIN test");
    expect(spec).toContain("DNAFIX_CHECK_END test");
    expect(spec).toContain("exit 1");
  });

  it("maps CodeBuild states without treating queued/submitted as success", () => {
    expect(mapBuildStatus("QUEUED")).toBe("QUEUED");
    expect(mapBuildStatus("SUBMITTED")).toBe("SUBMITTED");
    expect(isSuccessStatus(mapBuildStatus("QUEUED"))).toBe(false);
    expect(isSuccessStatus(mapBuildStatus("SUCCEEDED"))).toBe(true);
    expect(mapBuildStatus("WEIRD")).toBe("UNKNOWN");
    const markers = parseCheckMarkers("DNAFIX_CHECK_BEGIN test\nfoo\nDNAFIX_CHECK_END test 1\nDNAFIX_CHECK_BEGIN lint\n");
    expect(markers.get("test")).toBe(1);
    expect(markers.get("lint")).toBeNull();
  });
});

describe("IAM policy validation", () => {
  const expected = { bucket: "dnafix-artifacts-121728644078", region: "ap-southeast-2", accountId: "121728644078", logGroupName: "/aws/codebuild/dnafix-build" };
  it("accepts the deployed least-privilege role policy", () => {
    const policy = {
      Statement: [
        { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: ["arn:aws:logs:ap-southeast-2:121728644078:log-group:/aws/codebuild/dnafix-build", "arn:aws:logs:ap-southeast-2:121728644078:log-group:/aws/codebuild/dnafix-build:*"] },
        { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "arn:aws:s3:::dnafix-artifacts-121728644078/*" },
      ],
    };
    expect(validateExecutionRolePolicy(policy, expected)).toEqual({ valid: true, findings: [] });
    expect(parsePolicyDocument(encodeURIComponent(JSON.stringify(policy))).Statement).toHaveLength(2);
  });
  it("flags wildcard resources and non-allowlisted actions", () => {
    const policy = { Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: "*" }] };
    const result = validateExecutionRolePolicy(policy, expected);
    expect(result.valid).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

function fakeClients(buildSequence: BuildInfo[], logText: string, captured?: { starts: Array<Record<string, unknown>>; puts: string[] }) {
  let poll = 0;
  const clients: AwsClients = {
    codebuild: {
      startBuild: async (input) => {
        captured?.starts.push({ ...input });
        return { buildId: "dnafix-build:123" };
      },
      batchGetBuilds: async () => [buildSequence[Math.min(poll++, buildSequence.length - 1)]!],
      stopBuild: async () => undefined,
    },
    s3: {
      putObject: async (input) => {
        captured?.puts.push(input.key);
      },
      getObjectText: async () => "{}",
    },
    logs: { getLogText: async () => logText },
  };
  return clients;
}

const spec = {
  runId: "run_test1",
  workspacePath: process.cwd(),
  baseCommitSha: "abc1234",
  commands: [{ id: "test", kind: "test" as const, argv: ["npm", "run", "test"] }],
  timeoutMinutes: 5,
};
const config = { profile: "dnafix-dev", region: "ap-southeast-2", projectName: "dnafix-build", artifactsBucket: "bucket", logGroupName: "/aws/codebuild/dnafix-build" };
const succeeded: BuildInfo = { id: "dnafix-build:123", status: "SUCCEEDED", logGroupName: "/aws/codebuild/dnafix-build", logStreamName: "stream-1", logsDeepLink: "https://console.aws.amazon.com/cloudwatch", artifactsLocation: "arn:aws:s3:::bucket/runs/run_test1/artifacts" };

describe("CodeBuildExecutionProvider (mocked AWS clients)", () => {
  it("runs a full job: bundle upload, manifest, start, poll, log-based check results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-provider-"));
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await writeFile(path.join(root, "package.json"), "{}");
    const captured = { starts: [] as Array<Record<string, unknown>>, puts: [] as string[] };
    const inProgress: BuildInfo = { ...succeeded, status: "IN_PROGRESS" };
    const provider = new CodeBuildExecutionProvider(config, fakeClients([inProgress, succeeded], "DNAFIX_CHECK_BEGIN test\nok\nDNAFIX_CHECK_END test 0", captured), 1);
    const result = await provider.runJob({ ...spec, workspacePath: root });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.jobId).toBe("dnafix-build:123");
    expect(result.checkResults).toEqual([{ id: "test", kind: "test", exitCode: 0 }]);
    expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(captured.puts).toEqual(["runs/run_test1/source.zip", "runs/run_test1/manifest.json"]);
    expect(captured.starts[0]?.idempotencyToken).toContain("run_test1");
    expect(captured.starts[0]?.buildspec).toContain("DNAFIX_CHECK_BEGIN");
  });

  it("fails the result when log retrieval fails after a SUCCEEDED build", async () => {
    const clients = fakeClients([succeeded], "");
    clients.logs.getLogText = async () => {
      throw new Error("cloudwatch unavailable");
    };
    const provider = new CodeBuildExecutionProvider(config, clients, 1);
    const result = await provider.runJob(spec);
    expect(result.status).toBe("FAILED");
    expect(result.summary).toMatch(/log retrieval failed/);
  });

  it("stops the build and reports TIMED_OUT when polling exceeds the deadline", async () => {
    let stopped = false;
    const clients = fakeClients([{ ...succeeded, status: "IN_PROGRESS" }], "");
    const origStop = clients.codebuild.stopBuild.bind(clients.codebuild);
    clients.codebuild.stopBuild = async (id) => {
      stopped = true;
      return origStop(id);
    };
    const provider = new CodeBuildExecutionProvider(config, clients, 1, 20);
    const result = await provider.runJob(spec);
    expect(result.status).toBe("TIMED_OUT");
    expect(stopped).toBe(true);
  });

  it("cancellation uses StopBuild", async () => {
    let stoppedId: string | null = null;
    const clients = fakeClients([succeeded], "");
    clients.codebuild.stopBuild = async (id) => {
      stoppedId = id;
    };
    const provider = new CodeBuildExecutionProvider(config, clients, 1);
    await provider.cancel("dnafix-build:999");
    expect(stoppedId).toBe("dnafix-build:999");
  });

  it("refuses to run when unconfigured (no silent local fallback)", async () => {
    const provider = new CodeBuildExecutionProvider({ ...config, projectName: "" }, fakeClients([succeeded], ""), 1);
    expect(provider.configured()).toBe(false);
    await expect(provider.runJob(spec)).rejects.toThrow(/not configured/);
  });
});
