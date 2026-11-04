import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Pipeline, type PipelineDeps } from "@dnafix/application";
import { HostCommandRunner } from "@dnafix/execution";
import { GitWorktreeManager } from "@dnafix/git-engine";
import { GitHubAdapter } from "@dnafix/github";
import { MemoryStore, SqliteStore, type RunRecord, type Store } from "@dnafix/persistence";
import type { RepositoryIntelligence } from "@dnafix/repository-intelligence";
import type { ModelProvider } from "@dnafix/model-provider";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "fixtures", "sample-repo");

/** Pushing to github.com is not part of this test; the branch name is what the run records. */
class OfflinePushWorktrees extends GitWorktreeManager {
  readonly pushed: string[] = [];
  async pushBranchWithToken(_worktreePath: string, remoteUrl: string, branch: string, _token: string): Promise<void> {
    this.pushed.push(`${branch} -> ${remoteUrl}`);
  }
}

/** The pull-request stage reaches neither of these; if it does, the test setup is wrong. */
const unreachableIntelligence = {
  providerName: "unreachable",
  analyze: async () => {
    throw new Error("PULL_REQUEST_CREATION must not re-run repository analysis");
  },
} as unknown as RepositoryIntelligence;

const unreachableModel = {
  name: "unreachable",
  modelId: "unreachable",
  analyzeAndPlan: async () => {
    throw new Error("PULL_REQUEST_CREATION must not re-pay the planner");
  },
} as unknown as ModelProvider;

interface FakePr {
  number: number;
  head: string;
  base: string;
}

/** A GitHub that behaves like the real one about duplicates: one open pull request per head/base pair. */
function fakeGitHub(prs: FakePr[]) {
  let nextNumber = 1;
  const created: number[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
    }
    if (url.includes("/pulls?")) {
      return new Response(
        JSON.stringify(
          prs.map((pr) => ({
            number: pr.number,
            html_url: `https://github.com/acme/sample/pull/${pr.number}`,
            draft: true,
            head: { ref: pr.head },
            base: { ref: pr.base },
          })),
        ),
        { status: 200 },
      );
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { head: string; base: string };
      if (prs.some((pr) => pr.head === body.head && pr.base === body.base)) {
        return new Response(JSON.stringify({ message: "Validation Failed: a pull request already exists for this head" }), { status: 422 });
      }
      const pr = { number: nextNumber++, head: body.head, base: body.base };
      prs.push(pr);
      created.push(pr.number);
      return new Response(JSON.stringify({ number: pr.number, html_url: `https://github.com/acme/sample/pull/${pr.number}`, draft: true }), { status: 201 });
    }
    throw new Error(`Unexpected GitHub request in test: ${method} ${url}`);
  }) as typeof fetch;
  return { fetchFn, created };
}

/**
 * A run parked in PULL_REQUEST_CREATION — what a restarted process, an approval or a
 * manual resume finds. `effects: [startedEffect]` is precisely what a crash leaves behind.
 */
const startedEffect = { key: "github.draft-pr", kind: "github.pull-request", status: "started" as const, detail: null, startedAt: "2026-11-04T10:01:00.000Z", completedAt: null };

function pullRequestStageRun(runId: string, repositoryPath: string, baseCommitSha: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: runId,
    repositoryId: "acme-sample",
    repositoryPath,
    issueTitle: "Percentage discounts are calculated as flat amounts",
    issueBody: "applyDiscount(200, 10) should be 180.",
    issueNumber: null,
    baseRef: "HEAD",
    baseCommitSha,
    repositorySnapshotId: "fixture-repo@v1",
    state: "PULL_REQUEST_CREATION",
    modelProvider: "scripted-test-double",
    workflowEngine: "in-process-durable",
    analysis: null,
    plan: null,
    intelligence: null,
    tasks: [{ taskId: "fix-discount", status: "completed", worktreePath: null, branch: null, changedPaths: ["src/discount.ts"], commitSha: null, patchSummary: "Fixed", attempts: 1, error: null }],
    baselineChecks: [],
    verificationChecks: [],
    verifierReview: null,
    diff: "",
    changedPaths: ["src/discount.ts"],
    repairAttempts: 0,
    pullRequestUrl: null,
    pullRequestNumber: null,
    error: null,
    clarificationAnswer: null,
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
    githubInstallationId: 2,
    ...overrides,
  } as RunRecord;
}

interface Workspace {
  root: string;
  repo: string;
  baseCommitSha: string;
}

async function workspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(tmpdir(), "dnafix-effects-"));
  const repo = path.join(root, "repo");
  await cp(FIXTURE, repo, { recursive: true });
  const git = (args: string[]) => exec("git", args, { cwd: repo });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "init"]);
  const baseCommitSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  return { root, repo, baseCommitSha };
}

interface Process {
  deps: PipelineDeps;
  store: Store;
  worktrees: OfflinePushWorktrees;
  created: number[];
}

/**
 * One process' view of the system. Passing the same `sqliteFile` twice is how a
 * restart is modelled: the second call sees only what the first one wrote to disk.
 */
async function startProcess(ws: Workspace, options: { prs?: FakePr[]; sqlite?: string; seedRepository?: boolean } = {}): Promise<Process> {
  const prs = options.prs ?? [];
  const { fetchFn, created } = fakeGitHub(prs);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const store: Store = options.sqlite ? new SqliteStore(options.sqlite) : new MemoryStore();
  const worktrees = new OfflinePushWorktrees(path.join(ws.root, "worktrees"));
  if (options.seedRepository !== false) {
    await store.saveRepository({
      id: "acme-sample",
      localPath: ws.repo,
      githubOwner: "acme",
      githubRepo: "sample",
      defaultBranch: "main",
      lastAnalyzedCommitSha: ws.baseCommitSha,
      createdAt: "2026-11-04T09:00:00.000Z",
      githubInstallationId: 2,
    });
  }
  const deps: PipelineDeps = {
    store,
    intelligence: unreachableIntelligence,
    model: unreachableModel,
    remoteExecution: null,
    worktrees,
    runner: new HostCommandRunner(),
    github: new GitHubAdapter({
      appId: "1",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      installationId: "2",
      fetchFn,
    }),
    dataRoot: ws.root,
    maxRepairAttempts: 2,
    sandboxNote: "host (test)",
  };
  return { deps, store, worktrees, created };
}

describe("external-effect journal around draft PR creation", () => {
  it("records the intent before the pull request exists and its result after", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const run = pullRequestStageRun("run_journal_fresh", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);

    const current = await proc.store.getRun(run.id);
    expect(current?.state).toBe("COMPLETED");
    expect(proc.created).toEqual([1]);
    expect(current?.pullRequestUrl).toBe("https://github.com/acme/sample/pull/1");
    expect(current?.effects).toHaveLength(1);
    expect(current?.effects?.[0]).toMatchObject({
      key: "github.draft-pr",
      kind: "github.pull-request",
      status: "completed",
      detail: "https://github.com/acme/sample/pull/1",
    });
    expect(proc.worktrees.pushed).toEqual([`dnafix/${run.id}/integration -> https://github.com/acme/sample.git`]);
    const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
    expect(actions).toContain("pull-request.created");
  });

  it("adopts the pull request a crashed process already created instead of opening a second one", async () => {
    const ws = await workspace();
    const branch = "dnafix/run_journal_crashed/integration";
    const prs: FakePr[] = [{ number: 41, head: branch, base: "main" }];
    const proc = await startProcess(ws, { prs });
    const run = pullRequestStageRun("run_journal_crashed", ws.repo, ws.baseCommitSha, { effects: [startedEffect] });
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);

    const current = await proc.store.getRun(run.id);
    expect(proc.created).toEqual([]); // no create request was made at all
    expect(prs).toHaveLength(1);
    expect(current?.pullRequestUrl).toBe("https://github.com/acme/sample/pull/41");
    expect(current?.pullRequestNumber).toBe(41);
    expect(current?.effects?.[0]).toMatchObject({ status: "completed", detail: "https://github.com/acme/sample/pull/41" });
    const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
    expect(actions).toContain("pull-request.adopted");
    expect(actions).not.toContain("pull-request.created");
  });

  it("creates the pull request when the crashed process never reached GitHub", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const run = pullRequestStageRun("run_journal_no_effect", ws.repo, ws.baseCommitSha, { effects: [startedEffect] });
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);

    const current = await proc.store.getRun(run.id);
    expect(proc.created).toEqual([1]);
    expect(current?.state).toBe("COMPLETED");
    expect(current?.effects?.[0]).toMatchObject({ status: "completed", detail: "https://github.com/acme/sample/pull/1" });
  });

  it("re-driving a completed run changes nothing outward", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const run = pullRequestStageRun("run_journal_twice", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);
    const pipeline = new Pipeline(proc.deps);

    await pipeline.process(run.id);
    await pipeline.process(run.id);

    expect(proc.created).toEqual([1]);
    const current = await proc.store.getRun(run.id);
    expect(current?.state).toBe("COMPLETED");
    expect(current?.effects).toHaveLength(1);
  });

  it("resumes from the journal written by a previous process, through the shared database", async () => {
    const ws = await workspace();
    const file = path.join(ws.root, "dnafix.sqlite");
    const crashed = await startProcess(ws, { sqlite: file });
    const run = pullRequestStageRun("run_journal_sqlite", ws.repo, ws.baseCommitSha, { effects: [startedEffect] });
    await crashed.store.saveRun(run);
    // The process that recorded the intent is gone; the pull request it created is not.
    const reopened = await startProcess(ws, { sqlite: file, seedRepository: false, prs: [{ number: 77, head: `dnafix/${run.id}/integration`, base: "main" }] });

    await new Pipeline(reopened.deps).process(run.id);

    const current = await reopened.store.getRun(run.id);
    expect(reopened.created).toEqual([]);
    expect(current?.state).toBe("COMPLETED");
    expect(current?.pullRequestNumber).toBe(77);
    expect(current?.effects?.[0]).toMatchObject({ status: "completed", detail: "https://github.com/acme/sample/pull/77" });
    (crashed.store as SqliteStore).close();
    (reopened.store as SqliteStore).close();
  });
});
