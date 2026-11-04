import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AuditEvent,
  ImplementationPlan,
  IssueAnalysis,
  McpApprovalRecord,
  McpConnectionRecord,
  McpInvocationRecord,
  McpRunGrantRecord,
  McpServerPermissionRecord,
  McpToolPermissionRecord,
  RepositoryIntelligenceReport,
  VerificationCheck,
  VerifierReview,
  WorkflowState,
} from "@dnafix/contracts";

export interface RepositoryRecord {
  id: string;
  localPath: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string | null;
  lastAnalyzedCommitSha: string | null;
  createdAt: string;
  /** Verified GitHub App installation that grants access to this repository. */
  githubInstallationId?: number | null;
}

/**
 * One connected GitHub account per DNAFix session. Token fields are AES-256-GCM
 * ciphertext; plaintext tokens never enter this record or the JSON database.
 */
export interface GitHubConnectionRecord {
  id: string;
  sessionId: string;
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
  installationId: number | null;
  installationAccountLogin: string | null;
  installationAccountType: string | null;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
  tokenType: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
}

export interface RemoteExecutionRecord {
  phase: "baseline" | "final";
  provider: string;
  buildId: string | null;
  status: string;
  sourceKey: string | null;
  sourceSha256: string | null;
  sourceVerified?: boolean;
  artifactsLocation: string | null;
  artifactVerified?: boolean;
  logsReference: string | null;
  summary: string;
  createdAt: string;
  roleArn?: string | null;
  trustPolicyVersion?: string | null;
  revocationStatus?: string | null;
  deletionStatus?: string | null;
  containmentStatus?: string | null;
  lifecycleState?: string | null;
  quarantinedAt?: string | null;
  deleteNotBefore?: string | null;
  cleanupAttempts?: number;
  cancellation?: { requestedAt: string; reportedStatus: string; outcome: string } | null;
}

export interface TaskRecord {
  taskId: string;
  status: "pending" | "running" | "completed" | "failed";
  worktreePath: string | null;
  branch: string | null;
  changedPaths: string[];
  commitSha: string | null;
  patchSummary: string | null;
  attempts: number;
  error: string | null;
}

export interface RunRecord {
  id: string;
  repositoryId: string;
  repositoryPath: string;
  issueTitle: string;
  issueBody: string;
  issueNumber: number | null;
  baseRef: string;
  baseCommitSha: string | null;
  repositorySnapshotId: string | null;
  /** Snapshot ID of the second (impact-stage) intelligence analysis, when it ran. */
  impactSnapshotId?: string | null;
  /** Repository-resolved targets the planner nominated for impact analysis. */
  nominatedTargets?: string[];
  state: WorkflowState;
  modelProvider: string;
  workflowEngine: string;
  analysis: IssueAnalysis | null;
  plan: ImplementationPlan | null;
  intelligence: RepositoryIntelligenceReport | null;
  tasks: TaskRecord[];
  baselineChecks: VerificationCheck[];
  verificationChecks: VerificationCheck[] | null;
  remoteExecutions?: RemoteExecutionRecord[];
  verifierReview: VerifierReview | null;
  diff: string;
  changedPaths: string[];
  repairAttempts: number;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  error: string | null;
  clarificationAnswer: string | null;
  idempotency: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** Provenance for an analysis seeded from a real GitHub issue (optional for historical runs). */
  githubInstallationId?: number | null;
  issueUrl?: string | null;
}

export interface Store {
  saveRepository(repo: RepositoryRecord): Promise<void>;
  getRepository(id: string): Promise<RepositoryRecord | null>;
  listRepositories(): Promise<RepositoryRecord[]>;
  saveRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(): Promise<RunRecord[]>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(runId?: string): Promise<AuditEvent[]>;
  saveGitHubConnection(connection: GitHubConnectionRecord): Promise<void>;
  getGitHubConnection(sessionId: string): Promise<GitHubConnectionRecord | null>;
  deleteGitHubConnection(sessionId: string): Promise<void>;
  saveMcpConnection(connection: McpConnectionRecord): Promise<void>;
  getMcpConnection(id: string): Promise<McpConnectionRecord | null>;
  listMcpConnections(): Promise<McpConnectionRecord[]>;
  saveMcpToolPermission(permission: McpToolPermissionRecord): Promise<void>;
  listMcpToolPermissions(connectionId?: string): Promise<McpToolPermissionRecord[]>;
  saveMcpServerPermission(permission: McpServerPermissionRecord): Promise<void>;
  listMcpServerPermissions(connectionId?: string): Promise<McpServerPermissionRecord[]>;
  saveMcpRunGrant(grant: McpRunGrantRecord): Promise<void>;
  listMcpRunGrants(runId?: string): Promise<McpRunGrantRecord[]>;
  saveMcpApproval(approval: McpApprovalRecord): Promise<void>;
  getMcpApproval(id: string): Promise<McpApprovalRecord | null>;
  listMcpApprovals(filter?: { runId?: string; status?: McpApprovalRecord["status"] }): Promise<McpApprovalRecord[]>;
  saveMcpInvocation(invocation: McpInvocationRecord): Promise<void>;
  listMcpInvocations(filter?: { runId?: string; limit?: number }): Promise<McpInvocationRecord[]>;
}

interface DbShape {
  repositories: RepositoryRecord[];
  runs: RunRecord[];
  audit: AuditEvent[];
  githubConnections: GitHubConnectionRecord[];
  mcpConnections: McpConnectionRecord[];
  mcpToolPermissions: McpToolPermissionRecord[];
  mcpServerPermissions: McpServerPermissionRecord[];
  mcpRunGrants: McpRunGrantRecord[];
  mcpApprovals: McpApprovalRecord[];
  mcpInvocations: McpInvocationRecord[];
}

const emptyDb = (): DbShape => ({
  repositories: [],
  runs: [],
  audit: [],
  githubConnections: [],
  mcpConnections: [],
  mcpToolPermissions: [],
  mcpServerPermissions: [],
  mcpRunGrants: [],
  mcpApprovals: [],
  mcpInvocations: [],
});

export class MemoryStore implements Store {
  private db: DbShape = emptyDb();
  async saveRepository(repo: RepositoryRecord): Promise<void> {
    this.db.repositories = [...this.db.repositories.filter((r) => r.id !== repo.id), repo];
  }
  async getRepository(id: string): Promise<RepositoryRecord | null> {
    return this.db.repositories.find((r) => r.id === id) ?? null;
  }
  async listRepositories(): Promise<RepositoryRecord[]> {
    return [...this.db.repositories];
  }
  async saveRun(run: RunRecord): Promise<void> {
    this.db.runs = [...this.db.runs.filter((r) => r.id !== run.id), run];
  }
  async getRun(id: string): Promise<RunRecord | null> {
    return this.db.runs.find((r) => r.id === id) ?? null;
  }
  async listRuns(): Promise<RunRecord[]> {
    return [...this.db.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    this.db.audit.push(event);
  }
  async listAudit(runId?: string): Promise<AuditEvent[]> {
    return this.db.audit.filter((e) => !runId || e.runId === runId);
  }
  async saveGitHubConnection(connection: GitHubConnectionRecord): Promise<void> {
    this.db.githubConnections = [...this.db.githubConnections.filter((c) => c.sessionId !== connection.sessionId), structuredClone(connection)];
  }
  async getGitHubConnection(sessionId: string): Promise<GitHubConnectionRecord | null> {
    const connection = this.db.githubConnections.find((c) => c.sessionId === sessionId);
    return connection ? structuredClone(connection) : null;
  }
  async deleteGitHubConnection(sessionId: string): Promise<void> {
    this.db.githubConnections = this.db.githubConnections.filter((c) => c.sessionId !== sessionId);
  }
  async saveMcpConnection(connection: McpConnectionRecord): Promise<void> {
    this.db.mcpConnections = [...this.db.mcpConnections.filter((c) => c.id !== connection.id), structuredClone(connection)];
  }
  async getMcpConnection(id: string): Promise<McpConnectionRecord | null> {
    const connection = this.db.mcpConnections.find((c) => c.id === id);
    return connection ? structuredClone(connection) : null;
  }
  async listMcpConnections(): Promise<McpConnectionRecord[]> {
    return structuredClone(this.db.mcpConnections);
  }
  async saveMcpToolPermission(permission: McpToolPermissionRecord): Promise<void> {
    this.db.mcpToolPermissions = [
      ...this.db.mcpToolPermissions.filter((p) => !(p.connectionId === permission.connectionId && p.serverName === permission.serverName && p.toolName === permission.toolName)),
      structuredClone(permission),
    ];
  }
  async listMcpToolPermissions(connectionId?: string): Promise<McpToolPermissionRecord[]> {
    return structuredClone(this.db.mcpToolPermissions.filter((p) => !connectionId || p.connectionId === connectionId));
  }
  async saveMcpServerPermission(permission: McpServerPermissionRecord): Promise<void> {
    this.db.mcpServerPermissions = [
      ...this.db.mcpServerPermissions.filter((p) => !(p.connectionId === permission.connectionId && p.serverName === permission.serverName)),
      structuredClone(permission),
    ];
  }
  async listMcpServerPermissions(connectionId?: string): Promise<McpServerPermissionRecord[]> {
    return structuredClone(this.db.mcpServerPermissions.filter((p) => !connectionId || p.connectionId === connectionId));
  }
  async saveMcpRunGrant(grant: McpRunGrantRecord): Promise<void> {
    this.db.mcpRunGrants = [...this.db.mcpRunGrants.filter((g) => g.id !== grant.id), structuredClone(grant)];
  }
  async listMcpRunGrants(runId?: string): Promise<McpRunGrantRecord[]> {
    return structuredClone(this.db.mcpRunGrants.filter((g) => !runId || g.runId === runId));
  }
  async saveMcpApproval(approval: McpApprovalRecord): Promise<void> {
    this.db.mcpApprovals = [...this.db.mcpApprovals.filter((a) => a.id !== approval.id), structuredClone(approval)];
  }
  async getMcpApproval(id: string): Promise<McpApprovalRecord | null> {
    const approval = this.db.mcpApprovals.find((a) => a.id === id);
    return approval ? structuredClone(approval) : null;
  }
  async listMcpApprovals(filter: { runId?: string; status?: McpApprovalRecord["status"] } = {}): Promise<McpApprovalRecord[]> {
    return structuredClone(
      this.db.mcpApprovals.filter((a) => (!filter.runId || a.runId === filter.runId) && (!filter.status || a.status === filter.status)),
    );
  }
  async saveMcpInvocation(invocation: McpInvocationRecord): Promise<void> {
    this.db.mcpInvocations = [...this.db.mcpInvocations.filter((i) => i.id !== invocation.id), structuredClone(invocation)];
  }
  async listMcpInvocations(filter: { runId?: string; limit?: number } = {}): Promise<McpInvocationRecord[]> {
    const items = this.db.mcpInvocations
      .filter((i) => !filter.runId || i.runId === filter.runId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return structuredClone(filter.limit ? items.slice(0, filter.limit) : items);
  }
}

/** JSON-file store for single-user local development. Atomic replace on every write. Postgres schema lives in ./drizzle-schema.ts + migrations/. */
export class FileStore implements Store {
  private db: DbShape | null = null;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  private async load(): Promise<DbShape> {
    if (this.db) return this.db;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<DbShape>;
      this.db = {
        repositories: parsed.repositories ?? [],
        runs: parsed.runs ?? [],
        audit: parsed.audit ?? [],
        githubConnections: parsed.githubConnections ?? [],
        mcpConnections: parsed.mcpConnections ?? [],
        mcpToolPermissions: parsed.mcpToolPermissions ?? [],
        mcpServerPermissions: parsed.mcpServerPermissions ?? [],
        mcpRunGrants: parsed.mcpRunGrants ?? [],
        mcpApprovals: parsed.mcpApprovals ?? [],
        mcpInvocations: parsed.mcpInvocations ?? [],
      };
    } catch {
      this.db = emptyDb();
    }
    return this.db;
  }

  private async persist(): Promise<void> {
    const db = await this.load();
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  private mutate<T>(fn: (db: DbShape) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const db = await this.load();
      const result = fn(db);
      await this.persist();
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async saveRepository(repo: RepositoryRecord): Promise<void> {
    await this.mutate((db) => {
      db.repositories = [...db.repositories.filter((r) => r.id !== repo.id), repo];
    });
  }
  async getRepository(id: string): Promise<RepositoryRecord | null> {
    return (await this.load()).repositories.find((r) => r.id === id) ?? null;
  }
  async listRepositories(): Promise<RepositoryRecord[]> {
    return [...(await this.load()).repositories];
  }
  async saveRun(run: RunRecord): Promise<void> {
    await this.mutate((db) => {
      db.runs = [...db.runs.filter((r) => r.id !== run.id), structuredClone(run)];
    });
  }
  async getRun(id: string): Promise<RunRecord | null> {
    const run = (await this.load()).runs.find((r) => r.id === id);
    return run ? structuredClone(run) : null;
  }
  async listRuns(): Promise<RunRecord[]> {
    return [...(await this.load()).runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    await this.mutate((db) => {
      db.audit.push(event);
    });
  }
  async listAudit(runId?: string): Promise<AuditEvent[]> {
    return (await this.load()).audit.filter((e) => !runId || e.runId === runId);
  }
  async saveGitHubConnection(connection: GitHubConnectionRecord): Promise<void> {
    await this.mutate((db) => {
      db.githubConnections = [...db.githubConnections.filter((c) => c.sessionId !== connection.sessionId), structuredClone(connection)];
    });
  }
  async getGitHubConnection(sessionId: string): Promise<GitHubConnectionRecord | null> {
    const connection = (await this.load()).githubConnections.find((c) => c.sessionId === sessionId);
    return connection ? structuredClone(connection) : null;
  }
  async deleteGitHubConnection(sessionId: string): Promise<void> {
    await this.mutate((db) => {
      db.githubConnections = db.githubConnections.filter((c) => c.sessionId !== sessionId);
    });
  }
  async saveMcpConnection(connection: McpConnectionRecord): Promise<void> {
    await this.mutate((db) => {
      db.mcpConnections = [...db.mcpConnections.filter((c) => c.id !== connection.id), structuredClone(connection)];
    });
  }
  async getMcpConnection(id: string): Promise<McpConnectionRecord | null> {
    const connection = (await this.load()).mcpConnections.find((c) => c.id === id);
    return connection ? structuredClone(connection) : null;
  }
  async listMcpConnections(): Promise<McpConnectionRecord[]> {
    return structuredClone((await this.load()).mcpConnections);
  }
  async saveMcpToolPermission(permission: McpToolPermissionRecord): Promise<void> {
    await this.mutate((db) => {
      db.mcpToolPermissions = [
        ...db.mcpToolPermissions.filter((p) => !(p.connectionId === permission.connectionId && p.serverName === permission.serverName && p.toolName === permission.toolName)),
        structuredClone(permission),
      ];
    });
  }
  async listMcpToolPermissions(connectionId?: string): Promise<McpToolPermissionRecord[]> {
    return structuredClone((await this.load()).mcpToolPermissions.filter((p) => !connectionId || p.connectionId === connectionId));
  }
  async saveMcpServerPermission(permission: McpServerPermissionRecord): Promise<void> {
    await this.mutate((db) => {
      db.mcpServerPermissions = [
        ...db.mcpServerPermissions.filter((p) => !(p.connectionId === permission.connectionId && p.serverName === permission.serverName)),
        structuredClone(permission),
      ];
    });
  }
  async listMcpServerPermissions(connectionId?: string): Promise<McpServerPermissionRecord[]> {
    return structuredClone((await this.load()).mcpServerPermissions.filter((p) => !connectionId || p.connectionId === connectionId));
  }
  async saveMcpRunGrant(grant: McpRunGrantRecord): Promise<void> {
    await this.mutate((db) => {
      db.mcpRunGrants = [...db.mcpRunGrants.filter((g) => g.id !== grant.id), structuredClone(grant)];
    });
  }
  async listMcpRunGrants(runId?: string): Promise<McpRunGrantRecord[]> {
    return structuredClone((await this.load()).mcpRunGrants.filter((g) => !runId || g.runId === runId));
  }
  async saveMcpApproval(approval: McpApprovalRecord): Promise<void> {
    await this.mutate((db) => {
      db.mcpApprovals = [...db.mcpApprovals.filter((a) => a.id !== approval.id), structuredClone(approval)];
    });
  }
  async getMcpApproval(id: string): Promise<McpApprovalRecord | null> {
    const approval = (await this.load()).mcpApprovals.find((a) => a.id === id);
    return approval ? structuredClone(approval) : null;
  }
  async listMcpApprovals(filter: { runId?: string; status?: McpApprovalRecord["status"] } = {}): Promise<McpApprovalRecord[]> {
    return structuredClone(
      (await this.load()).mcpApprovals.filter((a) => (!filter.runId || a.runId === filter.runId) && (!filter.status || a.status === filter.status)),
    );
  }
  async saveMcpInvocation(invocation: McpInvocationRecord): Promise<void> {
    await this.mutate((db) => {
      db.mcpInvocations = [...db.mcpInvocations.filter((i) => i.id !== invocation.id), structuredClone(invocation)];
    });
  }
  async listMcpInvocations(filter: { runId?: string; limit?: number } = {}): Promise<McpInvocationRecord[]> {
    const items = (await this.load()).mcpInvocations
      .filter((i) => !filter.runId || i.runId === filter.runId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return structuredClone(filter.limit ? items.slice(0, filter.limit) : items);
  }
}
