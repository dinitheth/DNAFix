import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FileStore, MemoryStore, SqliteStore, SqliteStoreError, isTerminalRunWrite, type Store } from "./index.js";
import { approval, auditEvent, ghConnection, invocation, mcpConnection, mcpRunGrant, mcpServerPermission, mcpToolPermission, repository, runFixture } from "./test-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dirs: string[] = [];
const teardown: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(teardown.splice(0).map((fn) => fn()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "dnafix-sqlite-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Windows refuses to delete an open database file, so every store gets closed. */
function closable<T extends Store>(store: T): T {
  teardown.push(() => {
    if ("close" in store && typeof (store as unknown as { close?: () => void }).close === "function") {
      (store as unknown as { close: () => void }).close();
    }
  });
  return store;
}

function closableRaw(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath, {});
  teardown.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

/** The whole Store surface, run against every implementation so they cannot drift. */
async function contractSuite(label: string, make: () => Promise<Store>) {
  describe(`${label}: Store contract`, () => {
    it("round-trips every aggregate it stores", async () => {
      const store = await make();
      await store.saveRepository(repository);
      expect(await store.getRepository("repo_1")).toEqual(repository);
      expect(await store.listRepositories()).toEqual([repository]);

      const run = runFixture();
      await store.saveRun(run);
      const loaded = await store.getRun("run_1");
      expect(loaded?.tasks).toEqual(run.tasks);
      expect(loaded?.idempotency).toEqual(run.idempotency);
      expect(loaded?.verificationWaivers).toEqual(run.verificationWaivers);
      expect(loaded?.state).toBe("QUEUED");

      await store.saveRun({ ...(await store.getRun("run_1"))!, state: "AGENT_EXECUTION" });
      expect((await store.getRun("run_1"))?.state).toBe("AGENT_EXECUTION");
      expect((await store.listRuns())[0]?.state).toBe("AGENT_EXECUTION");

      await store.appendAudit(auditEvent("aud_1"));
      await store.appendAudit(auditEvent("aud_2", { runId: null, action: "run.created" }));
      expect((await store.listAudit("run_1")).map((e) => e.id)).toEqual(["aud_1"]);
      expect((await store.listAudit()).map((e) => e.id)).toEqual(["aud_1", "aud_2"]);

      await store.saveMcpConnection(mcpConnection);
      expect((await store.getMcpConnection("docker-desktop-mcp"))?.state).toBe("connected");
      expect(await store.listMcpConnections()).toHaveLength(1);

      await store.saveMcpToolPermission(mcpToolPermission);
      expect((await store.listMcpToolPermissions("docker-desktop-mcp"))[0]?.reviewedLevel).toBe(3);

      await store.saveMcpServerPermission(mcpServerPermission);
      expect((await store.listMcpServerPermissions("docker-desktop-mcp"))[0]?.enabled).toBe(true);

      await store.saveMcpRunGrant(mcpRunGrant);
      expect(await store.listMcpRunGrants("run_1")).toHaveLength(1);

      await store.saveMcpApproval(approval("apv_1"));
      expect(await store.getMcpApproval("apv_1")).toEqual(approval("apv_1"));
      await store.saveMcpApproval(approval("apv_1", { status: "approved", decidedBy: "user", decidedAt: "2026-11-04T10:10:00.000Z" }));
      expect((await store.getMcpApproval("apv_1"))?.status).toBe("approved");
      expect((await store.listMcpApprovals({ runId: "run_1", status: "pending" })).length).toBe(0);
      expect((await store.listMcpApprovals({ status: "approved" })).map((a) => a.id)).toEqual(["apv_1"]);

      await store.saveMcpInvocation(invocation("inv_old", "2026-11-04T10:00:00.000Z"));
      await store.saveMcpInvocation(invocation("inv_new", "2026-11-04T10:20:00.000Z"));
      expect((await store.listMcpInvocations({ runId: "run_1" })).map((i) => i.id)).toEqual(["inv_new", "inv_old"]);
      expect((await store.listMcpInvocations({ runId: "run_1", limit: 1 })).map((i) => i.id)).toEqual(["inv_new"]);

      await store.saveGitHubConnection(ghConnection);
      expect(await store.getGitHubConnection(ghConnection.sessionId)).toEqual(ghConnection);
      await store.deleteGitHubConnection(ghConnection.sessionId);
      expect(await store.getGitHubConnection(ghConnection.sessionId)).toBeNull();

      expect(await store.getRun("missing")).toBeNull();
      expect(await store.getRepository("missing")).toBeNull();
    });

    it("keeps runs ordered newest first across a day boundary", async () => {
      const store = await make();
      await store.saveRepository(repository);
      await store.saveRun(runFixture({ id: "run_old", createdAt: "2025-01-01T00:00:00.000Z" }));
      await store.saveRun(runFixture({ id: "run_new", createdAt: "2026-11-04T00:00:00.000Z" }));
      expect((await store.listRuns()).map((r) => r.id)).toEqual(["run_new", "run_old"]);
    });
  });
}

contractSuite("MemoryStore", async () => new MemoryStore());
contractSuite("FileStore", async () => {
  const dir = await tempDir("dnafix-file-");
  return new FileStore(path.join(dir, "db.json"));
});
contractSuite("SqliteStore", async () => {
  const dir = await tempDir();
  return closable(new SqliteStore(path.join(dir, "dnafix.sqlite")));
});

describe("SqliteStore: migrations", () => {
  it("creates the schema once and reports the applied version", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "dnafix.sqlite");
    const store = closable(new SqliteStore(file));
    expect(store.appliedMigrations).toEqual(["0001_initial_schema.sql"]);
    expect(store.schemaVersion).toBe("0001_initial_schema.sql");
    store.close();

    const reopened = closable(new SqliteStore(file));
    expect(reopened.appliedMigrations).toEqual(["0001_initial_schema.sql"]);
  });

  it("refuses to start when an applied migration's bytes changed", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "dnafix.sqlite");
    const store = new SqliteStore(file);
    store.close();
    const raw = closableRaw(file);
    raw.prepare("UPDATE schema_migrations SET checksum_sha256 = ? WHERE version = ?").run("0".repeat(64), "0001_initial_schema.sql");
    raw.close();
    try {
      new SqliteStore(file);
      expect.unreachable("the checksum guard should have stopped the store");
    } catch (err) {
      expect(err).toBeInstanceOf(SqliteStoreError);
      expect((err as SqliteStoreError).code).toBe("migration");
      expect((err as Error).message).toMatch(/changed after it was applied/);
    }
  });

  it("lifts queryable run fields into columns and projects checks and executions", async () => {
    const dir = await tempDir();
    const store = closable(new SqliteStore(path.join(dir, "dnafix.sqlite")));
    await store.saveRepository(repository);
    await store.saveRun(
      runFixture({
        remoteExecutions: [
          {
            phase: "final",
            provider: "codebuild",
            buildId: "build-1",
            status: "SUCCEEDED",
            sourceKey: null,
            sourceSha256: "aa".repeat(32),
            artifactsLocation: null,
            logsReference: null,
            summary: "ok",
            createdAt: "2026-11-04T10:00:00.000Z",
          },
        ],
      }),
    );

    const db = closableRaw(store.location);
    const runRow = db.prepare("SELECT state, repository_id, issue_number, repair_attempts, revision FROM runs WHERE id = ?").get("run_1") as Record<string, unknown>;
    expect(runRow).toMatchObject({ state: "QUEUED", repository_id: "repo_1", issue_number: 12, repair_attempts: 1, revision: 1 });

    const checks = db.prepare("SELECT phase, status, exit_code, waived FROM verification_checks WHERE run_id = ? ORDER BY phase, check_id").all("run_1") as Array<Record<string, unknown>>;
    expect(checks).toEqual([
      { phase: "baseline", status: "passed", exit_code: 0, waived: 0 },
      { phase: "final", status: "pre-existing-failure", exit_code: 1, waived: 1 },
    ]);

    const executions = db.prepare("SELECT provider, build_id, status FROM executions WHERE run_id = ?").all("run_1") as Array<Record<string, unknown>>;
    expect(executions).toEqual([{ provider: "codebuild", build_id: "build-1", status: "SUCCEEDED" }]);

    // The run is rewritten wholesale, so projections must not accumulate rows.
    await store.saveRun((await store.getRun("run_1"))!);
    const projected = db.prepare("SELECT COUNT(*) AS n FROM verification_checks WHERE run_id = ?").get("run_1") as { n: number };
    expect(projected.n).toBe(2);
    const execRows = db.prepare("SELECT COUNT(*) AS n FROM executions WHERE run_id = ?").get("run_1") as { n: number };
    expect(execRows.n).toBe(1);
  });

  it("rejects a run row whose repository does not exist", async () => {
    const dir = await tempDir();
    const store = closable(new SqliteStore(path.join(dir, "dnafix.sqlite")));
    await expect(store.saveRun(runFixture({ repositoryId: "repo_ghost" }))).rejects.toThrowError(/FOREIGN KEY constraint failed|constraint/i);
  });
});

describe("SqliteStore: concurrency", () => {
  it("refuses the second writer instead of letting it overwrite the run", async () => {
    const dir = await tempDir();
    const store = closable(new SqliteStore(path.join(dir, "dnafix.sqlite")));
    await store.saveRepository(repository);
    await store.saveRun(runFixture());

    const apiCopy = (await store.getRun("run_1"))!;
    const workerCopy = (await store.getRun("run_1"))!;
    await store.saveRun({ ...apiCopy, state: "AWAITING_PR_APPROVAL" });

    const err = await store.saveRun({ ...workerCopy, state: "FAILED" }).catch((e) => e);
    expect(err).toBeInstanceOf(SqliteStoreError);
    expect((err as SqliteStoreError).code).toBe("stale");
    expect((await store.getRun("run_1"))?.state).toBe("AWAITING_PR_APPROVAL");
    expect((await store.getRun("run_1"))?.revision).toBe(2);
  });

  it("keeps a terminal run terminal even when the writer holds the current revision", async () => {
    const dir = await tempDir();
    const store = closable(new SqliteStore(path.join(dir, "dnafix.sqlite")));
    await store.saveRepository(repository);
    await store.saveRun(runFixture({ state: "CANCELLED" }));

    const current = (await store.getRun("run_1"))!;
    const err = await store.saveRun({ ...current, state: "QUEUED" }).catch((e) => e);
    expect(err).toBeInstanceOf(SqliteStoreError);
    expect(isTerminalRunWrite(err)).toBe(true);
    expect((err as Error).message).toMatch(/a terminal run stays CANCELLED/);
    expect((await store.getRun("run_1"))?.state).toBe("CANCELLED");

    // Same state is still an ordinary update: a terminal run keeps recording.
    await expect(store.saveRun({ ...current, error: "cancelled by user" })).resolves.toBeUndefined();
    expect((await store.getRun("run_1"))?.error).toBe("cancelled by user");
  });

  it("survives concurrent writers from separate processes without losing a write", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "dnafix.sqlite");
    const bootstrap = new SqliteStore(file);
    await bootstrap.saveRepository(repository);
    await bootstrap.saveRun(runFixture({ id: "run_seed" }));
    bootstrap.close();

    const child = path.join(dir, "writer.mts");
    await writeFile(
      child,
      `import { SqliteStore, SqliteStoreError } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages", "persistence", "src", "sqlite-store.ts")).href)};
const dbPath = process.env.DNAFIX_TEST_DB!;
const label = process.env.DNAFIX_TEST_WRITER!;
const count = Number(process.env.DNAFIX_TEST_COUNT ?? "40");
const store = new SqliteStore(dbPath, { skipIntegrityCheck: true });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let retries = 0;
for (let i = 0; i < count; i += 1) {
  // A stale write means another process got the row first: re-read and re-apply,
  // never force the old copy through.
  for (let attempt = 0; ; attempt += 1) {
    const run = await store.getRun("run_seed");
    try {
      await store.saveRun({ ...run!, state: "AGENT_EXECUTION", updatedAt: new Date(Date.now() + i).toISOString() });
      break;
    } catch (err) {
      if (!(err instanceof SqliteStoreError) || err.code !== "stale" || attempt >= 60) throw err;
      retries += 1;
      await sleep(1 + Math.random() * 8);
    }
  }
  await store.appendAudit({
    id: \`aud_\${label}_\${i}\`,
    runId: "run_seed",
    repositoryId: "repo_1",
    actor: "coding-agent",
    action: "task.progress",
    result: "ok",
    evidence: label + ":" + i,
    createdAt: new Date(1762250000000 + i).toISOString(),
  });
  await store.saveMcpInvocation({
    id: \`inv_\${label}_\${i}\`,
    correlationId: \`cor_\${label}_\${i}\`,
    runId: "run_seed",
    connectionId: "docker-desktop-mcp",
    serverName: "docker",
    toolName: "list_containers",
    agent: "coding-agent",
    modelId: "muse",
    permissionLevel: 1,
    approvalId: null,
    approvalStatus: "not-required",
    executed: true,
    startedAt: new Date(1762260000000 + i).toISOString(),
    completedAt: new Date(1762260000000 + i).toISOString(),
    durationMs: 1,
    success: true,
    argumentsRedacted: {},
    resultSummary: "",
    error: null,
  });
}
console.log(JSON.stringify({ label, retries }));
store.close();
`,
      "utf8",
    );

    const spawnWriter = (label: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const proc = spawn(process.execPath, ["--import", "tsx", child], {
          cwd: repoRoot,
          env: { ...process.env, DNAFIX_TEST_DB: file, DNAFIX_TEST_WRITER: label, DNAFIX_TEST_COUNT: "40" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
        proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    const results = await Promise.all([spawnWriter("a"), spawnWriter("b"), spawnWriter("c")]);
    for (const result of results) {
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/SQLITE_BUSY|database is locked/);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/stale/);
      expect(result.code).toBe(0);
    }
    // Contention really happened, and every writer resolved it by re-reading.
    const retries = results.reduce((total, result) => total + (JSON.parse(result.stdout.trim()).retries as number), 0);
    expect(retries).toBeGreaterThan(0);

    const store = closable(new SqliteStore(file, { skipIntegrityCheck: true }));
    expect(await store.listAudit("run_seed")).toHaveLength(120);
    expect((await store.getRun("run_seed"))?.revision).toBe(121);
    // Append-only ordering is insertion order, and every writer's rows survive.
    const evidence = (await store.listAudit("run_seed")).map((event) => event.evidence);
    for (const label of ["a", "b", "c"]) {
      expect(evidence.filter((value) => value?.startsWith(`${label}:`))).toHaveLength(40);
    }
    expect((await store.listMcpInvocations({ runId: "run_seed" })).length).toBe(120);
  }, 240_000);
});

describe("SqliteStore: corruption", () => {
  it("preserves a file that is not a database and refuses to start on an empty one", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "dnafix.sqlite");
    await writeFile(file, "this is a JSON backup someone renamed\n", "utf8");

    let thrown: unknown;
    try {
      new SqliteStore(file);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SqliteStoreError);
    expect((thrown as SqliteStoreError).code).toBe("corrupt");

    const survivors = (await readdir(dir)).filter((entry) => entry.includes("corrupt"));
    expect(survivors).toHaveLength(1);
    expect(await readFile(path.join(dir, survivors[0]!), "utf8")).toContain("this is a JSON backup");
    expect(await readFile(file, "utf8").catch(() => null)).toBeNull();
  });

  it("keeps the FileStore's bytes too, instead of starting an empty database", async () => {
    const dir = await tempDir("dnafix-file-");
    const file = path.join(dir, "db.json");
    await writeFile(file, "{ half-written by a crash", "utf8");
    const store = new FileStore(file);
    await expect(store.listRuns()).rejects.toThrowError(/not readable DNAFix data/);
    const survivors = (await readdir(dir)).filter((entry) => entry.includes("corrupt"));
    expect(survivors).toHaveLength(1);
    expect(await readFile(path.join(dir, survivors[0]!), "utf8")).toContain("half-written");
  });
});
