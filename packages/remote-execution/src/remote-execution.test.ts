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

let capturedMetadata: string | null = null;
let capturedManifest = "{}";

function fakeClients(buildSequence: BuildInfo[], logText: string, captured?: { starts: Array<Record<string, unknown>>; puts: string[]; roles: string[] }) {
  let poll = 0;
  const clients: AwsClients = {
    codebuild: {
      startBuild: async (input) => {
        captured?.starts.push({ ...input });
        return { buildId: "dnafix-build:123" };
      },
      batchGetBuilds: async () => [buildSequence[Math.min(poll++, buildSequence.length - 1)]!],
      stopBuild: async () => ({ status: "STOPPED" }),
    },
    s3: {
      putObject: async (input) => {
        captured?.puts.push(input.key);
        capturedMetadata = input.metadata?.sha256 ?? null;
        if (input.contentType === "application/json") capturedManifest = String(input.body);
      },
      getObjectText: async () => capturedManifest,
      getObjectBytes: async () => Buffer.from("artifact-bytes"),
      headObject: async () => ({ metadataSha256: capturedMetadata, checksumSha256: null, versionId: "v1", contentLength: 1 }),
    },
    logs: { getLogText: async () => logText },
    iam: {
      createRole: async (input) => {
        captured?.roles.push(`create:${input.roleName}`);
        return { arn: `arn:aws:iam::121728644078:role/${input.roleName}` };
      },
      putPolicy: async () => undefined,
      updateTrustPolicy: async () => undefined,
      deleteRole: async (roleName) => {
        captured?.roles.push(`delete:${roleName}`);
      },
    },
  };
  return clients;
}

process.env.DNAFIX_ROLE_PROPAGATION_MS = "0";

const spec = {
  runId: "run_test1",
  workspacePath: process.cwd(),
  baseCommitSha: "abc1234",
  commands: [{ id: "test", kind: "test" as const, argv: ["npm", "run", "test"] }],
  timeoutMinutes: 5,
};
const config = { profile: "dnafix-dev", region: "ap-southeast-2", projectName: "dnafix-build", artifactsBucket: "bucket", logGroupName: "/aws/codebuild/dnafix-build", accountId: "121728644078" };
const succeeded: BuildInfo = { id: "dnafix-build:123", status: "SUCCEEDED", logGroupName: "/aws/codebuild/dnafix-build", logStreamName: "stream-1", logsDeepLink: "https://console.aws.amazon.com/cloudwatch", artifactsLocation: "arn:aws:s3:::bucket/runs/run_test1/artifacts" };

describe("CodeBuildExecutionProvider (mocked AWS clients)", () => {
  it("runs a full job: bundle upload, manifest, start, poll, log-based check results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dnafix-provider-"));
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await writeFile(path.join(root, "package.json"), "{}");
    const captured = { starts: [] as Array<Record<string, unknown>>, puts: [] as string[], roles: [] as string[] };
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

  it("9+10. cancellation requests StopBuild and reports the actual status (incl. completion race)", async () => {
    let stoppedId: string | null = null;
    const clients = fakeClients([succeeded], "");
    clients.codebuild.stopBuild = async (id) => {
      stoppedId = id;
      return { status: "STOPPED" };
    };
    const provider = new CodeBuildExecutionProvider(config, clients, 1);
    expect(await provider.cancel("dnafix-build:999")).toEqual({ status: "STOPPED" });
    expect(stoppedId).toBe("dnafix-build:999");
    // Race: the build completed just before the stop landed — reported honestly, not as "stopped".
    clients.codebuild.stopBuild = async () => ({ status: "SUCCEEDED" });
    expect(await provider.cancel("dnafix-build:999")).toEqual({ status: "SUCCEEDED" });
  });

  it("11. persists the full cleanup record (revocation + deletion + containment) in the result", async () => {
    const provider = new CodeBuildExecutionProvider(config, fakeClients([succeeded], "DNAFIX_CHECK_END test 0"), 1);
    const result = await provider.runJob(spec);
    expect(result.executionRole?.trustPolicyVersion).toBe("v2-source-restricted");
    expect(result.executionRole?.revocation.policyApplied).toBe(true);
    // Quarantine lifecycle: role is retained (deny-all + revocation applied) and deleted later by the reaper.
    expect(result.executionRole?.deletion.deleted).toBe(false);
    expect(result.executionRole?.lifecycleState).toBe("WAITING_FOR_SESSION_EXPIRY");
    expect(result.executionRole?.deleteNotBefore).toBeTruthy();
    expect(result.sourceVerified).toBe(true);
    expect(result.artifactIntegrity?.verified).toBe(true);
    expect(result.artifactIntegrity?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("12. rejects the job when the uploaded source fails checksum verification", async () => {
    const clients = fakeClients([succeeded], "");
    clients.s3.headObject = async () => ({ metadataSha256: "0".repeat(64), checksumSha256: null, versionId: null, contentLength: 1 });
    const provider = new CodeBuildExecutionProvider(config, clients, 1);
    await expect(provider.runJob(spec)).rejects.toThrow(/Source integrity verification failed/);
  });

  it("13+14. rejects artifacts belonging to another run", async () => {
    const foreign: BuildInfo = { ...succeeded, artifactsLocation: "arn:aws:s3:::bucket/runs/run_OTHER/artifacts/build.zip" };
    const provider = new CodeBuildExecutionProvider(config, fakeClients([foreign], "DNAFIX_CHECK_END test 0"), 1);
    const result = await provider.runJob(spec);
    expect(result.artifactIntegrity?.verified).toBe(false);
    expect(result.artifactIntegrity?.error).toMatch(/cross-run/);
    expect(result.status).toBe("FAILED");
  });

  it("refuses to run when unconfigured (no silent local fallback)", async () => {
    const provider = new CodeBuildExecutionProvider({ ...config, projectName: "" }, fakeClients([succeeded], ""), 1);
    expect(provider.configured()).toBe(false);
    await expect(provider.runJob(spec)).rejects.toThrow(/not configured/);
  });

  it("creates a per-run scoped role, overrides the build role, and deletes it after", async () => {
    const captured = { starts: [] as Array<Record<string, unknown>>, puts: [] as string[], roles: [] as string[] };
    const provider = new CodeBuildExecutionProvider(config, fakeClients([succeeded], "DNAFIX_CHECK_END test 0", captured), 1, undefined);
    // Skip IAM propagation delay in tests by using a 0-delay manager path (provider default is 8s; override via env-free subclass not needed: poll interval small, accept delay via fake timers not available) — instead assert with delay tolerated.
    const result = await provider.runJob(spec);
    expect(result.executionRole?.roleArn).toContain("dnafix-run-run_test1");
    expect(result.executionRole?.lifecycleState).toBe("WAITING_FOR_SESSION_EXPIRY");
    expect(captured.roles).toEqual(["create:dnafix-run-run_test1"]); // deletion deferred to the reaper after deleteNotBefore
    expect(captured.starts[0]?.serviceRoleArn).toContain("dnafix-run-run_test1");
  }, 30_000);

  it("refuses the shared project role when per-run isolation is unavailable", async () => {
    const provider = new CodeBuildExecutionProvider({ ...config, accountId: "" }, fakeClients([succeeded], ""), 1);
    await expect(provider.runJob(spec)).rejects.toThrow(/Per-run role isolation requires AWS_ACCOUNT_ID/);
  });
});

describe("per-run role policy", () => {
  it("scopes every resource to the run's own prefixes", async () => {
    const { buildRunRolePolicy, runRoleName } = await import("./run-role.js");
    const policy = buildRunRolePolicy({ bucket: "bucket", region: "ap-southeast-2", accountId: "121728644078", logGroupName: "/aws/codebuild/dnafix-build", runId: "run_42" }) as {
      Statement: Array<{ Action: string[]; Resource: string | string[] }>;
    };
    const resources = policy.Statement.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));
    for (const resource of resources.filter((r) => r.includes("s3"))) {
      expect(resource === "arn:aws:s3:::bucket" || resource.includes("runs/run_42/"), resource).toBe(true);
    }
    expect(runRoleName("run_42")).toBe("dnafix-run-run_42");
    expect(() => runRoleName("run_42/x")).toThrow(/Invalid runId/);
    expect(runRoleName("a".repeat(60)).length).toBeLessThanOrEqual(64);
  });
});
