import type { AuditEvent, McpApprovalRecord, McpConnectionRecord, McpInvocationRecord, McpRunGrantRecord, McpServerPermissionRecord, McpToolPermissionRecord } from "@dnafix/contracts";
import type { GitHubConnectionRecord, RepositoryRecord, RunRecord, Store } from "./index.js";

/** Shared fixtures for the persistence tests: one definition per record, used by every store implementation. */

export const repository: RepositoryRecord = {
  id: "repo_1",
  localPath: "/tmp/repo",
  githubOwner: "octocat",
  githubRepo: "demo",
  defaultBranch: "main",
  lastAnalyzedCommitSha: null,
  createdAt: "2026-11-04T10:00:00.000Z",
};

export function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_1",
    repositoryId: "repo_1",
    repositoryPath: "/tmp/repo",
    issueTitle: "Fix the flaky checkout test",
    issueBody: "Sometimes it times out.",
    issueNumber: 12,
    baseRef: "main",
    baseCommitSha: "abc123",
    repositorySnapshotId: null,
    state: "QUEUED",
    modelProvider: "scripted",
    workflowEngine: "in-process-durable",
    analysis: null,
    plan: null,
    intelligence: null,
    tasks: [{ taskId: "task_1", status: "pending", worktreePath: null, branch: null, changedPaths: [], commitSha: null, patchSummary: null, attempts: 0, error: null }],
    baselineChecks: [
      { id: "chk_test", kind: "test", status: "passed", result: { argv: ["pnpm", "test"], cwd: "/tmp/repo", exitCode: 0, timedOut: false, durationMs: 1200, stdoutSummary: "", stderrSummary: "", sandboxMode: "host" }, notes: "" },
    ],
    verificationChecks: [
      { id: "chk_test", kind: "test", status: "pre-existing-failure", result: { argv: ["pnpm", "test"], cwd: "/tmp/repo", exitCode: 1, timedOut: false, durationMs: 900, stdoutSummary: "", stderrSummary: "", sandboxMode: "host" }, notes: "" },
    ],
    verifierReview: null,
    verificationWaivers: [
      { checkId: "chk_test", reason: "Fails on main before this change", evidence: "CI run 4412 on the base commit", waivedBy: "dinith", waivedAt: "2026-11-04T11:00:00.000Z" },
    ],
    diff: "",
    changedPaths: [],
    repairAttempts: 1,
    pullRequestUrl: null,
    pullRequestNumber: null,
    error: null,
    clarificationAnswer: null,
    effects: [
      {
        key: "github.draft-pr",
        kind: "github.pull-request",
        status: "completed",
        detail: "https://github.com/acme/repo/pull/7",
        startedAt: "2026-11-04T10:06:00.000Z",
        completedAt: "2026-11-04T10:06:04.000Z",
      },
    ],
    createdAt: "2026-11-04T10:05:00.000Z",
    updatedAt: "2026-11-04T10:06:00.000Z",
    ...overrides,
  };
}

export const auditEvent = (id: string, overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id,
  runId: "run_1",
  repositoryId: "repo_1",
  actor: "coding-agent",
  action: "task.started",
  result: "ok",
  evidence: null,
  createdAt: "2026-11-04T10:07:00.000Z",
  ...overrides,
});

export const mcpConnection: McpConnectionRecord = {
  id: "docker-desktop-mcp",
  provider: "docker-desktop-mcp",
  profileId: "dnafix-dev",
  enabled: true,
  state: "connected",
  lastError: null,
  lastConnectedAt: null,
  lastHandshakeAt: null,
  inventory: null,
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z",
};

export const mcpToolPermission: McpToolPermissionRecord = {
  connectionId: "docker-desktop-mcp",
  serverName: "docker",
  toolName: "remove_container",
  enabled: true,
  allowedAgents: ["coding-agent"],
  reviewedLevel: 3,
  reviewedAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z",
};

export const mcpServerPermission: McpServerPermissionRecord = {
  connectionId: "docker-desktop-mcp",
  serverName: "docker",
  enabled: true,
  allowedAgents: ["coding-agent", "verification-agent"],
  updatedAt: "2026-11-04T10:00:00.000Z",
};

export const mcpRunGrant: McpRunGrantRecord = {
  id: "grant_1",
  runId: "run_1",
  connectionId: "docker-desktop-mcp",
  serverName: "docker",
  toolName: "create_container",
  permissionLevel: 2,
  workspaceScope: null,
  createdAt: "2026-11-04T10:00:00.000Z",
};

export const approval = (id: string, overrides: Partial<McpApprovalRecord> = {}): McpApprovalRecord => ({
  id,
  runId: "run_1",
  connectionId: "docker-desktop-mcp",
  serverName: "docker",
  toolName: "remove_container",
  kind: "per-call",
  permissionLevel: 3,
  correlationId: `cor_${id}`,
  argumentsRedacted: { container: "[REDACTED]" },
  argumentsHash: "hash",
  summary: "coding-agent wants to remove a container",
  consequences: "Destructive",
  status: "pending",
  requestedAt: "2026-11-04T10:08:00.000Z",
  expiresAt: "2026-11-04T10:09:00.000Z",
  decidedAt: null,
  decidedBy: null,
  ...overrides,
});

export const invocation = (id: string, startedAt: string): McpInvocationRecord => ({
  id,
  correlationId: `cor_${id}`,
  runId: "run_1",
  connectionId: "docker-desktop-mcp",
  serverName: "docker",
  toolName: "list_containers",
  agent: "coding-agent",
  modelId: "muse-spark-1.3",
  permissionLevel: 1,
  approvalId: null,
  approvalStatus: "not-required",
  executed: true,
  startedAt,
  completedAt: startedAt,
  durationMs: 5,
  success: true,
  argumentsRedacted: {},
  resultSummary: "3 containers",
  error: null,
});

export const ghConnection: GitHubConnectionRecord = {
  id: "ghconn_1",
  sessionId: "b".repeat(64),
  githubUserId: 7,
  login: "octocat",
  name: null,
  avatarUrl: null,
  htmlUrl: "https://github.com/octocat",
  installationId: 42,
  installationAccountLogin: "octocat",
  installationAccountType: "User",
  accessTokenCiphertext: "v1.aaa.bbb.ccc",
  refreshTokenCiphertext: null,
  accessTokenExpiresAt: "2026-11-05T10:00:00.000Z",
  refreshTokenExpiresAt: null,
  scopes: ["repo"],
  tokenType: "bearer",
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z",
  lastVerifiedAt: null,
};

/** One write per collection, in the order foreign keys require. */
export async function seedEveryCollection(store: Store): Promise<void> {
  await store.saveRepository(repository);
  await store.saveRun(runFixture());
  await store.appendAudit(auditEvent("aud_1"));
  await store.appendAudit(auditEvent("aud_2", { runId: null, action: "run.created" }));
  await store.saveGitHubConnection(ghConnection);
  await store.saveMcpConnection(mcpConnection);
  await store.saveMcpToolPermission(mcpToolPermission);
  await store.saveMcpServerPermission(mcpServerPermission);
  await store.saveMcpApproval(approval("apv_1"));
  await store.saveMcpRunGrant(mcpRunGrant);
  await store.saveMcpInvocation(invocation("inv_old", "2026-11-04T10:00:00.000Z"));
  await store.saveMcpInvocation(invocation("inv_new", "2026-11-04T10:20:00.000Z"));
}
