import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileStore, SqliteStore, type Store } from "@dnafix/persistence";
import { createStore, describeStore, migrateLegacyStore, repoRoot, resolveDataRoot, type PipelineDeps } from "./index.js";

const dirs: string[] = [];
const openStores: Store[] = [];
const originalEnv = { ...process.env };
const managedKeys = ["DNAFIX_STORE", "DNAFIX_DATABASE_PATH", "DNAFIX_SQLITE_BUSY_TIMEOUT_MS", "DNAFIX_DATA_DIR"] as const;

afterEach(async () => {
  for (const key of managedKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const store of openStores.splice(0)) (store as SqliteStore).close?.();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dnafix-store-"));
  dirs.push(dir);
  return dir;
}

function track(store: Store): Store {
  openStores.push(store);
  return store;
}

describe("store selection", () => {
  it("defaults to a SQLite database inside the data root", async () => {
    delete process.env.DNAFIX_STORE;
    delete process.env.DNAFIX_DATABASE_PATH;
    const dir = await tempDir();
    const store = track(createStore(dir));
    expect(store).toBeInstanceOf(SqliteStore);
    expect(describeStore(store)).toEqual({ kind: "sqlite", location: path.join(dir, "dnafix.sqlite") });
  });

  it("uses an explicit database path and warns for the single-process file store", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "custom", "dnafix.sqlite");
    process.env.DNAFIX_DATABASE_PATH = file;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = track(createStore(dir));
    expect((store as SqliteStore).location).toBe(file);
    expect(warn).not.toHaveBeenCalled();

    process.env.DNAFIX_STORE = "file";
    const fallback = track(createStore(dir));
    expect(fallback).toBeInstanceOf(FileStore);
    expect(describeStore(fallback).kind).toBe("file");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot be shared safely"));
    warn.mockRestore();
  });

  it("refuses a store it does not implement instead of silently picking one", async () => {
    const dir = await tempDir();
    process.env.DNAFIX_STORE = "postgres";
    expect(() => createStore(dir)).toThrowError(/Unknown DNAFIX_STORE 'postgres'/);
    process.env.DNAFIX_SQLITE_BUSY_TIMEOUT_MS = "-1";
    delete process.env.DNAFIX_STORE;
    expect(() => createStore(dir)).toThrowError(/DNAFIX_SQLITE_BUSY_TIMEOUT_MS/);
  });

  it("anchors a relative data directory at the repository root, not the process cwd", () => {
    delete process.env.DNAFIX_DATA_DIR;
    expect(resolveDataRoot(".data")).toBe(path.join(repoRoot, ".data"));
    expect(resolveDataRoot("apps/api/.data")).toBe(path.join(repoRoot, "apps", "api", ".data"));
    expect(resolveDataRoot("")).toBe(path.join(repoRoot, ".data"));
    expect(resolveDataRoot(undefined)).toBe(path.join(repoRoot, ".data"));
    const absolute = path.join(repoRoot, "elsewhere", "data");
    expect(resolveDataRoot(absolute)).toBe(absolute);
  });

  it("resolves a relative database path inside the data root", async () => {
    const dir = await tempDir();
    process.env.DNAFIX_DATABASE_PATH = path.join("nested", "dnafix.sqlite");
    const store = track(createStore(dir));
    expect((store as SqliteStore).location).toBe(path.join(dir, "nested", "dnafix.sqlite"));
  });

  it("imports a legacy JSON database once and reports nothing for a file store", async () => {
    const dir = await tempDir();
    delete process.env.DNAFIX_STORE;
    delete process.env.DNAFIX_DATABASE_PATH;
    await writeFile(path.join(dir, "dnafix.json"), JSON.stringify({ repositories: [], runs: [], audit: [] }), "utf8");
    const sqliteDeps = { store: track(createStore(dir)), dataRoot: dir } as unknown as PipelineDeps;
    const report = await migrateLegacyStore(sqliteDeps);
    expect(report?.total).toMatchObject({ repositories: 0, runs: 0, audit: 0 });

    const fileDeps = { store: track(new FileStore(path.join(dir, "dnafix.json"))), dataRoot: dir } as unknown as PipelineDeps;
    expect(await migrateLegacyStore(fileDeps)).toBeNull();
  });
});
