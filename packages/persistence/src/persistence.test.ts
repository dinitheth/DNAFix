import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, MemoryStore, type GitHubConnectionRecord, type RunRecord } from "./index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "dnafix-persistence-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "db.json"), store: new FileStore(path.join(dir, "db.json")) };
}

const connection: GitHubConnectionRecord = {
  id: "ghconn_1",
  sessionId: "a".repeat(64),
  githubUserId: 7,
  login: "octocat",
  name: "The Octocat",
  avatarUrl: null,
  htmlUrl: "https://github.com/octocat",
  installationId: 42,
  installationAccountLogin: "octocat",
  installationAccountType: "User",
  accessTokenCiphertext: "v1.aaa.bbb.ccc",
  refreshTokenCiphertext: "v1.ddd.eee.fff",
  accessTokenExpiresAt: "2026-11-02T12:00:00.000Z",
  refreshTokenExpiresAt: "2027-02-01T12:00:00.000Z",
  scopes: [],
  tokenType: "bearer",
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
  lastVerifiedAt: "2026-11-02T10:00:00.000Z",
};

const historicalRun = {
  id: "run_old",
  repositoryId: "repo_old",
  repositoryPath: "/tmp/repo",
  issueTitle: "Legacy issue",
  issueBody: "Legacy body",
  issueNumber: null,
  baseRef: "HEAD",
  baseCommitSha: null,
  repositorySnapshotId: null,
  state: "COMPLETED",
  modelProvider: "test",
  workflowEngine: "in-process-durable",
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
} as RunRecord;

describe("backward-compatible persistence", () => {
  it("loads a legacy JSON database without GitHub fields and keeps old runs intact", async () => {
    const { file, store } = await tempStore();
    await writeFile(file, JSON.stringify({ repositories: [], runs: [historicalRun], audit: [] }), "utf8");
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.issueTitle).toBe("Legacy issue");
    expect(runs[0]?.issueUrl).toBeUndefined();
    await store.saveRun({ ...historicalRun, issueUrl: "https://github.com/octocat/demo/issues/1", githubInstallationId: 42 });
    const updated = await store.getRun("run_old");
    expect(updated?.issueUrl).toBe("https://github.com/octocat/demo/issues/1");
    const raw = JSON.parse(await readFile(file, "utf8")) as { githubConnections?: unknown };
    expect(raw.githubConnections).toEqual([]);
  });

  it("round-trips encrypted connections and deletes them", async () => {
    const { store } = await tempStore();
    await store.saveGitHubConnection(connection);
    expect(await store.getGitHubConnection(connection.sessionId)).toEqual(connection);
    await store.deleteGitHubConnection(connection.sessionId);
    expect(await store.getGitHubConnection(connection.sessionId)).toBeNull();
  });

  it("never writes plaintext access tokens through the store interface", async () => {
    const { file, store } = await tempStore();
    await store.saveGitHubConnection(connection);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("v1.aaa.bbb.ccc");
    expect(raw).not.toContain("ghu_plaintext");
  });

  it("supports the same connection API in memory for tests", async () => {
    const store = new MemoryStore();
    await store.saveGitHubConnection(connection);
    expect((await store.getGitHubConnection(connection.sessionId))?.login).toBe("octocat");
    await store.deleteGitHubConnection(connection.sessionId);
    expect(await store.getGitHubConnection(connection.sessionId)).toBeNull();
  });
});
