import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEvent,
  McpApprovalRecord,
  McpConnectionRecord,
  McpInvocationRecord,
  McpRunGrantRecord,
  McpServerPermissionRecord,
  McpToolPermissionRecord,
} from "@dnafix/contracts";
import type { GitHubConnectionRecord, RepositoryRecord, RunRecord, Store } from "./index.js";

/**
 * SQLite store: the single source of truth shared by the API and the worker.
 *
 * Queryable fields live in real columns; the aggregate itself lives in
 * `payload_json`, so a run's nested values (tasks, waivers, idempotency keys)
 * are read and written as one unit. `verification_checks` and `executions` are
 * projections of that aggregate written in the same transaction, so they can be
 * queried per row without ever diverging from it.
 *
 * Single-host by design: WAL does not work on network-mounted storage, and this
 * is not a distributed store.
 */
export interface SqliteStoreOptions {
  /** Milliseconds SQLite waits for a lock another process holds. */
  busyTimeoutMs?: number;
  /** Skip the startup PRAGMA integrity_check. Meant for very large databases. */
  skipIntegrityCheck?: boolean;
}

export class SqliteStoreError extends Error {
  constructor(
    message: string,
    readonly code: "corrupt" | "migration" | "unavailable" | "stale" | "state_conflict",
  ) {
    super(message);
    this.name = "SqliteStoreError";
  }
}

/** True when a store rejected a write because another writer changed the row first. */
export function isStaleWrite(err: unknown): boolean {
  return (err as { code?: unknown } | null) !== null && (err as { code?: unknown }).code === "stale";
}

/** True when a write was rejected because it tried to reopen a terminal run. */
export function isTerminalRunWrite(err: unknown): boolean {
  return (err as { code?: unknown } | null) !== null && (err as { code?: unknown }).code === "state_conflict";
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "sqlite");

/** Mirrors the domain state machine: these states have no outgoing transitions. */
const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/** Blocking backoff — the store opens synchronously, so startup waits in place. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switching the journal mode is the one statement SQLite will not sit out
 * through busy_timeout: a connection that arrives while another is still
 * creating the file gets "database is locked" immediately. Reading the mode
 * lets every later connection see WAL without touching the lock, so only the
 * process that actually has to set it retries.
 */
function ensureWalMode(db: DatabaseSync): void {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode;
    if (typeof current === "string" && current.toLowerCase() === "wal") return;
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/database is locked|SQLITE_BUSY/i.test(message)) throw err;
      sleepSync(5 + Math.floor(Math.random() * 25));
    }
  }
  throw new SqliteStoreError("Could not put the store in WAL mode: another process held the database locked through startup.", "unavailable");
}

/**
 * Filename-ordered .sql files, each applied exactly once inside its own
 * transaction and recorded in schema_migrations. An applied file whose bytes
 * later change is a hard error: editing history silently diverges the schema
 * from what the running processes were built against. The ledger is read inside
 * the write lock, so two processes starting against the same fresh file cannot
 * both decide a migration is unapplied and replay its DDL.
 */
function applyMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  if (!existsSync(MIGRATIONS_DIR)) {
    throw new SqliteStoreError(`Migration directory ${MIGRATIONS_DIR} is missing; the store cannot be initialised.`, "migration");
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const checksum = checksumOf(sql);
    db.exec("BEGIN IMMEDIATE");
    let recorded: string | null | undefined;
    try {
      recorded = (db.prepare("SELECT checksum_sha256 FROM schema_migrations WHERE version = ?").get(file) as { checksum_sha256: string } | undefined)?.checksum_sha256;
      if (recorded === undefined) {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (version, filename, checksum_sha256, applied_at) VALUES (?, ?, ?, ?)").run(file, file, checksum, new Date().toISOString());
      }
      db.exec("COMMIT");
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new SqliteStoreError(`Migration '${file}' failed: ${err instanceof Error ? err.message : String(err)}`, "migration");
    }
    if (recorded !== undefined && recorded !== checksum) {
      throw new SqliteStoreError(
        `Migration '${file}' changed after it was applied (recorded ${recorded.slice(0, 12)}, found ${checksum.slice(0, 12)}). Add a new migration instead of editing history.`,
        "migration",
      );
    }
  }
}

/**
 * Move an unusable database aside with everything that belongs to it so it can
 * still be inspected or repaired. Nothing is deleted and the process never
 * continues on an empty database.
 */
function quarantine(filePath: string, reason: string): never {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const moved: string[] = [];
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = `${filePath}${suffix}`;
    if (!existsSync(candidate)) continue;
    const target = `${candidate}.corrupt-${stamp}`;
    renameSync(candidate, target);
    moved.push(path.basename(target));
  }
  throw new SqliteStoreError(
    `${filePath} is not usable (${reason}). Preserved as ${moved.join(", ") || "nothing — the rename itself failed"}. ` +
      "DNAFix refuses to start on an empty database: repair the copy, or delete it deliberately to begin clean.",
    "corrupt",
  );
}

function looksCorrupt(message: string): boolean {
  return /not a database|database disk image is malformed|disk I\/O error|file is not a database/i.test(message);
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

type PayloadRow = { payload_json: string };

function toRecord<T>(row: PayloadRow | undefined): T | null {
  return row ? (JSON.parse(row.payload_json) as T) : null;
}

function toRecords<T>(rows: PayloadRow[]): T[] {
  return rows.map((row) => JSON.parse(row.payload_json) as T);
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly filePath: string;
  /** Serialises in-process writes so BEGIN IMMEDIATE is never re-entered. */
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: SqliteStoreOptions = {}) {
    this.filePath = filePath;
    this.db = SqliteStore.openChecked(filePath, options);
  }

  /**
   * Opens, applies the pragmas and the migration ledger, and refuses to continue
   * on an unusable file. A file that is not a readable database is preserved,
   * never replaced.
   */
  private static openChecked(filePath: string, options: SqliteStoreOptions): DatabaseSync {
    mkdirSync(path.dirname(filePath), { recursive: true });
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(filePath, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (looksCorrupt(message)) quarantine(filePath, message);
      throw err;
    }
    try {
      // busy_timeout first: every statement after it can wait for a lock
      // instead of failing the startup of whichever process lost the race.
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000))}`);
      ensureWalMode(db);
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA foreign_keys = ON");
      if (!options.skipIntegrityCheck) {
        const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        if (check?.integrity_check !== "ok") {
          throw new Error(`PRAGMA integrity_check returned '${check?.integrity_check ?? "no result"}'`);
        }
      }
      applyMigrations(db);
      return db;
    } catch (err) {
      db.close();
      if (err instanceof SqliteStoreError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (looksCorrupt(message)) quarantine(filePath, message);
      throw err;
    }
  }

  get location(): string {
    return this.filePath;
  }

  get appliedMigrations(): string[] {
    return (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((row) => row.version);
  }

  /** Highest applied migration — what the status surface reports as the schema version. */
  get schemaVersion(): string | null {
    const row = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version: string } | undefined;
    return row?.version ?? null;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Consistent snapshot taken by SQLite itself, safe while other processes write. */
  backup(destinationPath: string): void {
    this.db.prepare("VACUUM INTO ?").run(destinationPath);
  }

  private write<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async saveRepository(repo: RepositoryRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO repositories (id, created_at, local_path, github_owner, github_repo, default_branch, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, local_path = excluded.local_path, github_owner = excluded.github_owner,
             github_repo = excluded.github_repo, default_branch = excluded.default_branch, payload_json = excluded.payload_json`,
        )
        .run(repo.id, repo.createdAt, repo.localPath, repo.githubOwner, repo.githubRepo, repo.defaultBranch, JSON.stringify(repo));
    });
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    return toRecord<RepositoryRecord>(this.db.prepare("SELECT payload_json FROM repositories WHERE id = ?").get(id) as PayloadRow | undefined);
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    return toRecords<RepositoryRecord>(this.db.prepare("SELECT payload_json FROM repositories ORDER BY rowid").all() as PayloadRow[]);
  }

  /**
   * Reads the current revision inside the write transaction, so two processes
   * cannot both believe they hold it. A mismatch is reported instead of
   * overwriting: the last writer must not silently win a run transition.
   */
  async saveRun(run: RunRecord): Promise<void> {
    await this.write(() => {
      const current = this.db.prepare("SELECT revision, state FROM runs WHERE id = ?").get(run.id) as { revision: number; state: string } | undefined;
      if (!current) {
        if (run.revision !== undefined && run.revision !== 1) {
          throw new SqliteStoreError(`Run ${run.id} carries revision ${run.revision} but no row exists; re-read it before saving.`, "stale");
        }
      } else if (run.revision === undefined || run.revision !== current.revision) {
        throw new SqliteStoreError(
          `Run ${run.id} changed under this writer (row is at revision ${current.revision}, this copy read revision ${run.revision ?? "none"}). ` +
            "Re-read and re-apply instead of overwriting.",
          "stale",
        );
      } else if (TERMINAL_STATES.has(current.state) && run.state !== current.state) {
        // A terminal run never reopens: the domain state machine has no outgoing
        // transition from these states, so a writer asking for one is a stale or
        // fabricated copy rather than a real step.
        throw new SqliteStoreError(`Run ${run.id} is ${current.state}; a terminal run stays ${current.state}, so the request to move it to ${run.state} was rejected.`, "state_conflict");
      }
      const next = (current?.revision ?? 0) + 1;
      const stored: RunRecord = { ...run, revision: next };
      this.db
        .prepare(
          `INSERT INTO runs (id, repository_id, state, repository_path, issue_number, issue_title, base_ref, model_provider, created_at, updated_at, revision, error, pull_request_url, repair_attempts, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             repository_id = excluded.repository_id, state = excluded.state, repository_path = excluded.repository_path,
             issue_number = excluded.issue_number, issue_title = excluded.issue_title, base_ref = excluded.base_ref,
             model_provider = excluded.model_provider, created_at = excluded.created_at, updated_at = excluded.updated_at,
             revision = excluded.revision, error = excluded.error, pull_request_url = excluded.pull_request_url,
             repair_attempts = excluded.repair_attempts, payload_json = excluded.payload_json`,
        )
        .run(
          stored.id,
          stored.repositoryId,
          stored.state,
          stored.repositoryPath,
          stored.issueNumber,
          stored.issueTitle,
          stored.baseRef,
          stored.modelProvider,
          stored.createdAt,
          stored.updatedAt,
          next,
          stored.error,
          stored.pullRequestUrl,
          stored.repairAttempts,
          JSON.stringify(stored),
        );
      this.projectChecks(run);
      this.projectExecutions(run);
      run.revision = next;
    });
  }

  private projectChecks(run: RunRecord): void {
    // Waivers name a check in the final verification set, so only those rows
    // carry the flag: a baseline check with the same id is not being waived.
    const waived = new Set((run.verificationWaivers ?? []).map((w) => w.checkId));
    this.db.prepare("DELETE FROM verification_checks WHERE run_id = ?").run(run.id);
    const insert = this.db.prepare(
      `INSERT INTO verification_checks (run_id, phase, check_id, kind, status, exit_code, duration_ms, waived, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const phase of ["baseline", "final"] as const) {
      const checks = phase === "baseline" ? run.baselineChecks : (run.verificationChecks ?? []);
      for (const check of checks) {
        insert.run(
          run.id,
          phase,
          check.id,
          check.kind,
          check.status,
          check.result?.exitCode ?? null,
          check.result?.durationMs ?? null,
          boolInt(phase === "final" && waived.has(check.id)),
          JSON.stringify(check),
        );
      }
    }
  }

  private projectExecutions(run: RunRecord): void {
    this.db.prepare("DELETE FROM executions WHERE run_id = ?").run(run.id);
    const insert = this.db.prepare(
      `INSERT INTO executions (run_id, index_number, phase, provider, build_id, status, source_sha256, containment_status, quarantined_at, created_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (run.remoteExecutions ?? []).forEach((execution, index) => {
      insert.run(
        run.id,
        index,
        execution.phase,
        execution.provider,
        execution.buildId,
        execution.status,
        execution.sourceSha256,
        execution.containmentStatus ?? null,
        execution.quarantinedAt ?? null,
        execution.createdAt,
        JSON.stringify(execution),
      );
    });
  }

  async getRun(id: string): Promise<RunRecord | null> {
    return toRecord<RunRecord>(this.db.prepare("SELECT payload_json FROM runs WHERE id = ?").get(id) as PayloadRow | undefined);
  }

  async listRuns(): Promise<RunRecord[]> {
    return toRecords<RunRecord>(this.db.prepare("SELECT payload_json FROM runs ORDER BY created_at DESC, id DESC").all() as PayloadRow[]);
  }

  /** Runs in one state — the query the Approvals Inbox and dashboards need. */
  async listRunsByState(state: string): Promise<RunRecord[]> {
    return toRecords<RunRecord>(this.db.prepare("SELECT payload_json FROM runs WHERE state = ? ORDER BY updated_at DESC, id DESC").all(state) as PayloadRow[]);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO audit_events (id, run_id, repository_id, actor, action, result, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(event.id, event.runId, event.repositoryId, event.actor, event.action, event.result, event.createdAt, JSON.stringify(event));
    });
  }

  async listAudit(runId?: string): Promise<AuditEvent[]> {
    // Append-only and replayed in insertion order: rowid, because two events in
    // the same millisecond must not reorder between the API and the SSE stream.
    const rows = runId
      ? (this.db.prepare("SELECT payload_json FROM audit_events WHERE run_id = ? ORDER BY rowid").all(runId) as PayloadRow[])
      : (this.db.prepare("SELECT payload_json FROM audit_events ORDER BY rowid").all() as PayloadRow[]);
    return toRecords<AuditEvent>(rows);
  }

  async saveGitHubConnection(connection: GitHubConnectionRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO github_connections (id, session_id, login, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, login = excluded.login, updated_at = excluded.updated_at, payload_json = excluded.payload_json`,
        )
        .run(connection.id, connection.sessionId, connection.login, connection.updatedAt, JSON.stringify(connection));
    });
  }

  async getGitHubConnection(sessionId: string): Promise<GitHubConnectionRecord | null> {
    return toRecord<GitHubConnectionRecord>(
      this.db.prepare("SELECT payload_json FROM github_connections WHERE session_id = ?").get(sessionId) as PayloadRow | undefined,
    );
  }

  async deleteGitHubConnection(sessionId: string): Promise<void> {
    await this.write(() => {
      this.db.prepare("DELETE FROM github_connections WHERE session_id = ?").run(sessionId);
    });
  }

  async saveMcpConnection(connection: McpConnectionRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO mcp_connections (id, provider, state, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, state = excluded.state, updated_at = excluded.updated_at, payload_json = excluded.payload_json`,
        )
        .run(connection.id, connection.provider, connection.state, connection.updatedAt, JSON.stringify(connection));
    });
  }

  async getMcpConnection(id: string): Promise<McpConnectionRecord | null> {
    return toRecord<McpConnectionRecord>(this.db.prepare("SELECT payload_json FROM mcp_connections WHERE id = ?").get(id) as PayloadRow | undefined);
  }

  async listMcpConnections(): Promise<McpConnectionRecord[]> {
    return toRecords<McpConnectionRecord>(this.db.prepare("SELECT payload_json FROM mcp_connections ORDER BY rowid").all() as PayloadRow[]);
  }

  async saveMcpToolPermission(permission: McpToolPermissionRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO mcp_tool_permissions (connection_id, server_name, tool_name, enabled, reviewed_level, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(connection_id, server_name, tool_name) DO UPDATE SET enabled = excluded.enabled, reviewed_level = excluded.reviewed_level,
             updated_at = excluded.updated_at, payload_json = excluded.payload_json`,
        )
        .run(permission.connectionId, permission.serverName, permission.toolName, boolInt(permission.enabled), permission.reviewedLevel, permission.updatedAt, JSON.stringify(permission));
    });
  }

  async listMcpToolPermissions(connectionId?: string): Promise<McpToolPermissionRecord[]> {
    const rows = connectionId
      ? (this.db.prepare("SELECT payload_json FROM mcp_tool_permissions WHERE connection_id = ? ORDER BY rowid").all(connectionId) as PayloadRow[])
      : (this.db.prepare("SELECT payload_json FROM mcp_tool_permissions ORDER BY rowid").all() as PayloadRow[]);
    return toRecords<McpToolPermissionRecord>(rows);
  }

  async saveMcpServerPermission(permission: McpServerPermissionRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO mcp_server_permissions (connection_id, server_name, enabled, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(connection_id, server_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, payload_json = excluded.payload_json`,
        )
        .run(permission.connectionId, permission.serverName, boolInt(permission.enabled), permission.updatedAt, JSON.stringify(permission));
    });
  }

  async listMcpServerPermissions(connectionId?: string): Promise<McpServerPermissionRecord[]> {
    const rows = connectionId
      ? (this.db.prepare("SELECT payload_json FROM mcp_server_permissions WHERE connection_id = ? ORDER BY rowid").all(connectionId) as PayloadRow[])
      : (this.db.prepare("SELECT payload_json FROM mcp_server_permissions ORDER BY rowid").all() as PayloadRow[]);
    return toRecords<McpServerPermissionRecord>(rows);
  }

  async saveMcpRunGrant(grant: McpRunGrantRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO mcp_run_grants (id, run_id, connection_id, server_name, tool_name, permission_level, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, connection_id = excluded.connection_id, server_name = excluded.server_name,
             tool_name = excluded.tool_name, permission_level = excluded.permission_level, created_at = excluded.created_at, payload_json = excluded.payload_json`,
        )
        .run(grant.id, grant.runId, grant.connectionId, grant.serverName, grant.toolName, grant.permissionLevel, grant.createdAt, JSON.stringify(grant));
    });
  }

  async listMcpRunGrants(runId?: string): Promise<McpRunGrantRecord[]> {
    const rows = runId
      ? (this.db.prepare("SELECT payload_json FROM mcp_run_grants WHERE run_id = ? ORDER BY rowid").all(runId) as PayloadRow[])
      : (this.db.prepare("SELECT payload_json FROM mcp_run_grants ORDER BY rowid").all() as PayloadRow[]);
    return toRecords<McpRunGrantRecord>(rows);
  }

  async saveMcpApproval(approval: McpApprovalRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO mcp_approvals (id, run_id, server_name, tool_name, kind, status, permission_level, correlation_id, requested_at, expires_at, decided_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, server_name = excluded.server_name, tool_name = excluded.tool_name, kind = excluded.kind,
             status = excluded.status, permission_level = excluded.permission_level, correlation_id = excluded.correlation_id,
             requested_at = excluded.requested_at, expires_at = excluded.expires_at, decided_at = excluded.decided_at, payload_json = excluded.payload_json`,
        )
        .run(
          approval.id,
          approval.runId,
          approval.serverName,
          approval.toolName,
          approval.kind,
          approval.status,
          approval.permissionLevel,
          approval.correlationId,
          approval.requestedAt,
          approval.expiresAt,
          approval.decidedAt,
          JSON.stringify(approval),
        );
    });
  }

  async getMcpApproval(id: string): Promise<McpApprovalRecord | null> {
    return toRecord<McpApprovalRecord>(this.db.prepare("SELECT payload_json FROM mcp_approvals WHERE id = ?").get(id) as PayloadRow | undefined);
  }

  async listMcpApprovals(filter: { runId?: string; status?: McpApprovalRecord["status"] } = {}): Promise<McpApprovalRecord[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.runId) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return toRecords<McpApprovalRecord>(this.db.prepare(`SELECT payload_json FROM mcp_approvals${where} ORDER BY rowid`).all(...params) as PayloadRow[]);
  }

  async saveMcpInvocation(invocation: McpInvocationRecord): Promise<void> {
    await this.write(() => {
      this.db
        .prepare(
          `INSERT INTO mcp_invocations (id, correlation_id, run_id, server_name, tool_name, agent, permission_level, approval_status, executed, success, started_at, duration_ms, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET correlation_id = excluded.correlation_id, run_id = excluded.run_id, server_name = excluded.server_name,
             tool_name = excluded.tool_name, agent = excluded.agent, permission_level = excluded.permission_level, approval_status = excluded.approval_status,
             executed = excluded.executed, success = excluded.success, started_at = excluded.started_at, duration_ms = excluded.duration_ms,
             payload_json = excluded.payload_json`,
        )
        .run(
          invocation.id,
          invocation.correlationId,
          invocation.runId,
          invocation.serverName,
          invocation.toolName,
          invocation.agent,
          invocation.permissionLevel,
          invocation.approvalStatus,
          boolInt(invocation.executed),
          boolInt(invocation.success),
          invocation.startedAt,
          invocation.durationMs,
          JSON.stringify(invocation),
        );
    });
  }

  async listMcpInvocations(filter: { runId?: string; limit?: number } = {}): Promise<McpInvocationRecord[]> {
    const where = filter.runId ? " WHERE run_id = ?" : "";
    // LIMIT is a computed integer, never caller text, so inlining it is safe.
    const limit = filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "";
    const params = filter.runId ? [filter.runId] : [];
    return toRecords<McpInvocationRecord>(
      this.db.prepare(`SELECT payload_json FROM mcp_invocations${where} ORDER BY started_at DESC, id DESC${limit}`).all(...params) as PayloadRow[],
    );
  }
}
