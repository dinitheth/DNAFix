import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { PipelineDeps } from "@dnafix/application";
import { HostCommandRunner } from "@dnafix/execution";
import { GitWorktreeManager } from "@dnafix/git-engine";
import { GitHubAdapter } from "@dnafix/github";
import { MemoryStore, SqliteStore, type RunRecord, type Store } from "@dnafix/persistence";
import type { RepositoryIntelligence } from "@dnafix/repository-intelligence";
import type { ModelProvider } from "@dnafix/model-provider";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "..", "fixtures", "sample-repo");

/** Pushing to github.com is not part of these tests; the branch name is what the run records. */
export class OfflinePushWorktrees extends GitWorktreeManager {
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

export interface FakePr {
  number: number;
  head: string;
  base: string;
}

/** A GitHub that behaves like the real one about duplicates: one open pull request per head/base pair. */
export function fakeGitHub(prs: FakePr[]) {
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

/** What a crash leaves on disk: the intent recorded, the result not. Fresh per call — the pipeline completes the record it is given. */
export function startedEffect() {
  return { key: "github.draft-pr", kind: "github.pull-request", status: "started" as const, detail: null, startedAt: "2026-11-04T10:01:00.000Z", completedAt: null };
}

/**
 * A run parked in PULL_REQUEST_CREATION — what a restarted process, an approval or a
 * poll finds. It needs no plan, no model and no tests: only the branch and the diff.
 */
export function pullRequestStageRun(runId: string, repositoryPath: string, baseCommitSha: string, overrides: Partial<RunRecord> = {}): RunRecord {
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

export interface Workspace {
  root: string;
  repo: string;
  baseCommitSha: string;
}

export async function workspace(): Promise<Workspace> {
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

export interface Process {
  deps: PipelineDeps;
  store: Store;
  worktrees: OfflinePushWorktrees;
  created: number[];
}

/**
 * One process' view of the system. Passing the same `sqlite` file twice is how a
 * restart is modelled: the second call sees only what the first wrote to disk.
 */
export async function startProcess(ws: Workspace, options: { prs?: FakePr[]; sqlite?: string; seedRepository?: boolean } = {}): Promise<Process> {
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
