import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore, SqliteStore, importLegacyJson } from "./index.js";
import { seedEveryCollection } from "./test-fixtures.js";

const dirs: string[] = [];
const open: SqliteStore[] = [];
afterEach(async () => {
  for (const store of open.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function legacyFile(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dnafix-legacy-"));
  dirs.push(dir);
  const file = path.join(dir, "dnafix.json");
  const source = new FileStore(file);
  await seedEveryCollection(source);
  return { dir, file };
}

function sqlite(dir: string): SqliteStore {
  const store = new SqliteStore(path.join(dir, "dnafix.sqlite"));
  open.push(store);
  return store;
}

describe("legacy JSON import", () => {
  it("copies every collection into SQLite", async () => {
    const { dir, file } = await legacyFile();
    const report = await importLegacyJson(file, sqlite(dir), "sqlite");
    expect(report?.imported).toMatchObject({
      repositories: 1,
      runs: 1,
      audit: 2,
      githubConnections: 1,
      mcpConnections: 1,
      mcpToolPermissions: 1,
      mcpServerPermissions: 1,
      mcpApprovals: 1,
      mcpRunGrants: 1,
      mcpInvocations: 2,
    });
    expect(report?.skipped.repositories).toBe(0);

    const target = sqlite(dir);
    expect((await target.getRun("run_1"))?.verificationWaivers).toHaveLength(1);
    expect((await target.listAudit("run_1")).map((e) => e.id)).toEqual(["aud_1"]);
    expect((await target.getGitHubConnection("b".repeat(64)))?.login).toBe("octocat");
    expect((await target.listMcpInvocations({ runId: "run_1" })).map((i) => i.id)).toEqual(["inv_new", "inv_old"]);
    // An imported row is writable through the normal optimistic-concurrency path.
    await target.saveRun({ ...(await target.getRun("run_1"))!, state: "AGENT_EXECUTION" });
    expect((await target.getRun("run_1"))?.state).toBe("AGENT_EXECUTION");
  });

  it("is idempotent: a second pass skips everything and duplicates nothing", async () => {
    const { dir, file } = await legacyFile();
    const store = sqlite(dir);
    const first = await importLegacyJson(file, store, "sqlite");
    const originalBytes = await readFile(file, "utf8");
    const second = await importLegacyJson(file, store, "sqlite");
    if (!first || !second) throw new Error("expected a report from a legacy database that exists");

    expect(Object.values(second.imported)).toEqual(Object.values(second.imported).map(() => 0));
    expect(second.skipped).toEqual(first.imported);
    expect(second.total).toEqual(first.total);
    expect(await store.listRuns()).toHaveLength(1);
    expect(await store.listAudit()).toHaveLength(2);
    expect(await store.listMcpInvocations()).toHaveLength(2);
    expect(await store.listMcpRunGrants()).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe(originalBytes);
  });

  it("leaves the source file byte-identical and never deletes it", async () => {
    const { dir, file } = await legacyFile();
    const original = await readFile(file, "utf8");
    await importLegacyJson(file, sqlite(dir), "sqlite");
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("reports nothing to import when there is no legacy database", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-legacy-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "unrelated.txt"), "x", "utf8");
    expect(await importLegacyJson(path.join(dir, "dnafix.json"), sqlite(dir), "sqlite")).toBeNull();
  });
});
