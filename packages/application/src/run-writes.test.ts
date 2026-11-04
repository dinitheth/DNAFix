import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreeManager } from "@dnafix/git-engine";
import { SqliteStore, type RunRecord } from "@dnafix/persistence";
import type { VerificationWaiver } from "@dnafix/contracts";
import { RunConflictError, RunService, type PipelineDeps } from "./index.js";

/**
 * Two RunService instances over two connections to the same database file, which
 * is what the API process and the worker process actually are.
 */
const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function pair(): Promise<{ db: string; api: RunService; worker: RunService }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dnafix-run-writes-"));
  dirs.push(dir);
  const db = path.join(dir, "dnafix.sqlite");
  const make = () => {
    const store = new SqliteStore(db, { skipIntegrityCheck: true });
    stores.push(store);
    const deps = {
      store,
      dataRoot: dir,
      model: { name: "test", modelId: "test-model" },
      // Cancellation now reclaims the run's worktrees, so the double needs the real
      // manager over a directory that simply never gets anything written to it.
      worktrees: new GitWorktreeManager(path.join(dir, "worktrees")),
    } as unknown as PipelineDeps;
    return new RunService(deps);
  };
  return { db, api: make(), worker: make() };
}

async function newRun(worker: RunService, db: string): Promise<RunRecord> {
  return worker.createRun({ issueTitle: "Fix the flaky checkout test", issueBody: "Sometimes it times out.", repositoryPath: path.join(path.dirname(db), "repo") });
}

const waiver: VerificationWaiver = { checkId: "test", reason: "Fails on main before this change", evidence: "CI run 4412 on the base commit", waivedBy: "dinith", waivedAt: "2026-11-04T11:00:00.000Z" };

describe("run writes across processes", () => {
  it("re-applies a worker write onto a row the API changed in between", async () => {
    const { db, api, worker } = await pair();
    const run = await newRun(worker, db);

    const heldByWorker = await worker.load(run.id);
    const copy = await api.load(run.id);
    copy!.verificationWaivers = [waiver];
    await api.save(copy!);

    heldByWorker!.diff = "+ changed line";
    await worker.save(heldByWorker!);

    const stored = await api.load(run.id);
    expect(stored?.verificationWaivers).toEqual([waiver]);
    expect(stored?.diff).toBe("+ changed line");
  });

  it("drops a worker write instead of overwriting a state the API moved on from", async () => {
    const { db, api, worker } = await pair();
    const run = await newRun(worker, db);

    const heldByWorker = await worker.load(run.id);
    const copy = await api.load(run.id);
    await api.transition(copy!, "REPOSITORY_PREPARATION");

    heldByWorker!.state = "REPOSITORY_PREPARATION";
    heldByWorker!.error = "worker thought it was still queued";
    const err = await worker.save(heldByWorker!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunConflictError);
    expect((err as Error).message).toMatch(/moved to REPOSITORY_PREPARATION under this writer/);

    const stored = await api.load(run.id);
    expect(stored?.state).toBe("REPOSITORY_PREPARATION");
    expect(stored?.error).toBeNull();
  });

  it("reports a conflict instead of guessing when both writers changed the same field", async () => {
    const { db, api, worker } = await pair();
    const run = await newRun(worker, db);
    const byApi = await api.load(run.id);
    const byWorker = await worker.load(run.id);

    byApi!.error = "api wrote first";
    await api.save(byApi!);
    byWorker!.error = "worker wrote too";
    const err = await worker.save(byWorker!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunConflictError);
    expect((err as Error).message).toMatch(/changed by another writer at the same time/);

    // Retrying with the same stale copy stays rejected; the writer must re-read.
    await expect(worker.save(byWorker!)).rejects.toBeInstanceOf(RunConflictError);
    expect((await api.load(run.id))?.error).toBe("api wrote first");
  });

  it("cancels on top of a change made while the cancellation was in flight", async () => {
    const { db, api, worker } = await pair();
    const run = await newRun(worker, db);
    const midPhase = await worker.load(run.id);
    midPhase!.diff = "mid-phase";
    await worker.save(midPhase!);

    const cancelled = await api.cancel(run.id);
    expect(cancelled?.state).toBe("CANCELLED");
    const stored = await api.load(run.id);
    expect(stored?.diff).toBe("mid-phase");
    expect(stored?.state).toBe("CANCELLED");
  });

  it("keeps a terminal run terminal when a stale copy tries to reopen it", async () => {
    const { db, api, worker } = await pair();
    const run = await newRun(worker, db);
    await api.cancel(run.id);

    const reopened = await api.load(run.id);
    reopened!.state = "QUEUED";
    const err = await worker.save(reopened!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunConflictError);
    expect((err as Error).message).toMatch(/a terminal run stays CANCELLED/);
    expect((await worker.load(run.id))?.state).toBe("CANCELLED");

    // Cancelling a run that already finished reports the outcome it reached.
    expect((await api.cancel(run.id))?.state).toBe("CANCELLED");
  });

  it("moves the state on from a row the other writer only annotated", async () => {
    const { db, api, worker } = await pair();
    const run = await newRun(worker, db);
    const heldByApi = await api.load(run.id);
    const heldByWorker = await worker.load(run.id);

    heldByWorker!.clarificationAnswer = "Reproduce on Node 22 only.";
    await worker.save(heldByWorker!);
    await api.transition(heldByApi!, "REPOSITORY_PREPARATION");

    const stored = await worker.load(run.id);
    expect(stored?.state).toBe("REPOSITORY_PREPARATION");
    expect(stored?.clarificationAnswer).toBe("Reproduce on Node 22 only.");
  });
});
