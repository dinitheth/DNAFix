import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore, type RunRecord } from "@dnafix/persistence";
import { RunService, type PipelineDeps } from "./index.js";

const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Two RunService instances over two connections to the same file, named as if they
 * were the two processes they stand for: that difference is the whole point of a lease.
 */
async function pair(ttlMs = 60_000): Promise<{ api: RunService; worker: RunService; store: SqliteStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dnafix-lease-"));
  dirs.push(dir);
  const make = (ownerId: string) => {
    const store = new SqliteStore(path.join(dir, "dnafix.sqlite"), { skipIntegrityCheck: true });
    stores.push(store);
    const deps = { store, dataRoot: dir, model: { name: "test", modelId: "test-model" } } as unknown as PipelineDeps;
    return { service: new RunService(deps, ownerId, ttlMs), store };
  };
  const api = make("pid-api");
  const worker = make("pid-worker");
  return { api: api.service, worker: worker.service, store: api.store };
}

async function queuedRun(api: RunService): Promise<RunRecord> {
  return api.createRun({ issueTitle: "Fix the flaky checkout test", issueBody: "Sometimes it times out.", repositoryPath: path.join(tmpdir(), "repo") });
}

describe("run leases across processes", () => {
  it("lets the first claimant hold the run and leaves it alone for the second", async () => {
    const { api, worker } = await pair();
    const run = await queuedRun(api);

    const claimed = await api.claim(run.id);
    expect(claimed?.lease).toMatchObject({ owner: "pid-api" });

    expect(await worker.claim(run.id)).toBeNull();
    expect((await worker.load(run.id))?.lease?.owner).toBe("pid-api");
  });

  it("takes over a lease whose holder stopped renewing it", async () => {
    const { api, worker, store } = await pair();
    const run = await queuedRun(api);
    await api.claim(run.id);
    // The API died mid-phase: the lease is on disk with an expiry already past.
    const dead = (await store.getRun(run.id))!;
    dead.lease = { owner: "pid-api", expiresAt: new Date(Date.now() - 1).toISOString() };
    await store.saveRun(dead);

    const taken = await worker.claim(run.id);
    expect(taken?.lease?.owner).toBe("pid-worker");
  });

  it("extends the lease on every write, so a long phase is not mistaken for a dead driver", async () => {
    const { api, store } = await pair(50);
    const run = await queuedRun(api);
    const claimed = (await api.claim(run.id))!;
    const firstExpiry = Date.parse(claimed.lease!.expiresAt);

    await new Promise((resolve) => setTimeout(resolve, 80));
    claimed.diff = "+ a line written after the ttl would have passed";
    await api.save(claimed);

    const stored = await store.getRun(run.id);
    expect(Date.parse(stored!.lease!.expiresAt)).toBeGreaterThan(firstExpiry);
    expect(stored?.diff).toBe(claimed.diff);
  });

  it("refuses to claim a run that is waiting on a human, blocked, or finished", async () => {
    const { api, store } = await pair();
    for (const state of ["AWAITING_PLAN_APPROVAL", "AWAITING_PR_APPROVAL", "NEEDS_CLARIFICATION", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"] as const) {
      // A run per state: a terminal row cannot be written again, so one row could
      // not carry all of these without lying about the guard.
      const run = await api.createRun({ issueTitle: "Fix the flaky checkout test", issueBody: "Sometimes it times out.", repositoryPath: path.join(tmpdir(), `repo-${state}`) });
      const parked = (await store.getRun(run.id))!;
      parked.state = state;
      await store.saveRun(parked);
      expect(await api.claim(run.id), state).toBeNull();
      expect((await store.getRun(run.id))?.lease, state).toBeUndefined();
    }
  });

  it("records the claim on the row so a third process sees the same owner", async () => {
    const { api, store } = await pair();
    const run = await queuedRun(api);
    await api.claim(run.id);

    const third = new RunService({ store, dataRoot: "unused", model: { name: "t", modelId: "t" } } as unknown as PipelineDeps, "pid-third", 60_000);
    expect(await third.claim(run.id)).toBeNull();
    expect((await store.getRun(run.id))?.lease).toMatchObject({ owner: "pid-api" });
  });
});
