import path from "node:path";
import { describe, expect, it } from "vitest";
import { Pipeline } from "@dnafix/application";
import { SqliteStore } from "@dnafix/persistence";
import { pullRequestStageRun, startProcess, startedEffect, workspace, type FakePr } from "./harness.js";

describe("external-effect journal around draft PR creation", () => {
  it("records the intent before the pull request exists and its result after", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const run = pullRequestStageRun("run_journal_fresh", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);

    const current = await proc.store.getRun(run.id);
    expect(current?.state).toBe("COMPLETED");
    expect(proc.created).toEqual([1]);
    expect(current?.pullRequestUrl).toBe("https://github.com/acme/sample/pull/1");
    expect(current?.effects).toHaveLength(1);
    expect(current?.effects?.[0]).toMatchObject({
      key: "github.draft-pr",
      kind: "github.pull-request",
      status: "completed",
      detail: "https://github.com/acme/sample/pull/1",
    });
    expect(proc.worktrees.pushed).toEqual([`dnafix/${run.id}/integration -> https://github.com/acme/sample.git`]);
    const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
    expect(actions).toContain("pull-request.created");
  });

  it("adopts the pull request a crashed process already created instead of opening a second one", async () => {
    const ws = await workspace();
    const branch = "dnafix/run_journal_crashed/integration";
    const prs: FakePr[] = [{ number: 41, head: branch, base: "main" }];
    const proc = await startProcess(ws, { prs });
    // Exactly what a crash leaves behind: the intent on disk, the pull request on
    // GitHub, and nothing recorded about the result.
    const run = pullRequestStageRun("run_journal_crashed", ws.repo, ws.baseCommitSha, { effects: [startedEffect()] });
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);

    const current = await proc.store.getRun(run.id);
    expect(proc.created).toEqual([]); // no create request was made at all
    expect(prs).toHaveLength(1);
    expect(current?.pullRequestUrl).toBe("https://github.com/acme/sample/pull/41");
    expect(current?.pullRequestNumber).toBe(41);
    expect(current?.effects?.[0]).toMatchObject({ status: "completed", detail: "https://github.com/acme/sample/pull/41" });
    const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
    expect(actions).toContain("pull-request.adopted");
    expect(actions).not.toContain("pull-request.created");
  });

  it("creates the pull request when the crashed process never reached GitHub", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const run = pullRequestStageRun("run_journal_no_effect", ws.repo, ws.baseCommitSha, { effects: [startedEffect()] });
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);

    const current = await proc.store.getRun(run.id);
    expect(proc.created).toEqual([1]);
    expect(current?.state).toBe("COMPLETED");
    expect(current?.effects?.[0]).toMatchObject({ status: "completed", detail: "https://github.com/acme/sample/pull/1" });
  });

  it("re-driving a completed run changes nothing outward", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const run = pullRequestStageRun("run_journal_twice", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);
    const pipeline = new Pipeline(proc.deps);

    await pipeline.process(run.id);
    await pipeline.process(run.id);

    expect(proc.created).toEqual([1]);
    const current = await proc.store.getRun(run.id);
    expect(current?.state).toBe("COMPLETED");
    expect(current?.effects).toHaveLength(1);
  });

  it("resumes from the journal written by a previous process, through the shared database", async () => {
    const ws = await workspace();
    const file = path.join(ws.root, "dnafix.sqlite");
    const crashed = await startProcess(ws, { sqlite: file });
    const run = pullRequestStageRun("run_journal_sqlite", ws.repo, ws.baseCommitSha, { effects: [startedEffect()] });
    await crashed.store.saveRun(run);
    // The process that recorded the intent is gone; the pull request it created is not.
    const reopened = await startProcess(ws, {
      sqlite: file,
      seedRepository: false,
      prs: [{ number: 77, head: `dnafix/${run.id}/integration`, base: "main" }],
    });

    await new Pipeline(reopened.deps).process(run.id);

    const current = await reopened.store.getRun(run.id);
    expect(reopened.created).toEqual([]);
    expect(current?.state).toBe("COMPLETED");
    expect(current?.pullRequestNumber).toBe(77);
    expect(current?.effects?.[0]).toMatchObject({ status: "completed", detail: "https://github.com/acme/sample/pull/77" });
    (crashed.store as SqliteStore).close();
    (reopened.store as SqliteStore).close();
  });

  it("leaves the journal untouched when a resumed run is refused by a live lease", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws);
    const held = pullRequestStageRun("run_journal_held", ws.repo, ws.baseCommitSha, {
      effects: [startedEffect()],
      lease: { owner: "pid-someone-else", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    await proc.store.saveRun(held);

    const drove = await new Pipeline(proc.deps).process(held.id);

    expect(drove).toBe(false);
    expect(proc.created).toEqual([]);
    const current = await proc.store.getRun(held.id);
    expect(current?.state).toBe("PULL_REQUEST_CREATION");
    expect(current?.effects?.[0]?.status).toBe("started");
  });
});
