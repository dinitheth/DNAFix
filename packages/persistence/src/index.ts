import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AuditEvent,
  ImplementationPlan,
  IssueAnalysis,
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
}

interface DbShape {
  repositories: RepositoryRecord[];
  runs: RunRecord[];
  audit: AuditEvent[];
}

const emptyDb = (): DbShape => ({ repositories: [], runs: [], audit: [] });

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
}

/** JSON-file store for single-user local development. Atomic replace on every write. Postgres schema lives in ./drizzle-schema.ts + migrations/. */
export class FileStore implements Store {
  private db: DbShape | null = null;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  private async load(): Promise<DbShape> {
    if (this.db) return this.db;
    try {
      this.db = JSON.parse(await readFile(this.filePath, "utf8")) as DbShape;
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
}
