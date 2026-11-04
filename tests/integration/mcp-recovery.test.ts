import { describe, expect, it } from "vitest";
import { Pipeline } from "@dnafix/application";
import type { McpConnectorService } from "@dnafix/mcp";
import { pullRequestStageRun, startProcess, startedEffect, workspace } from "./harness.js";

/** Records what the pipeline asks of the MCP layer, in order, alongside the outward effect. */
function recordingMcp(events: string[]) {
  return {
    reconcileInterruptedRun: async (runId: string) => {
      events.push(`reconcile:${runId}`);
      return { approvalsCancelled: 0, invocationsUnresolved: 0 };
    },
    releaseRun: () => {},
  } as unknown as McpConnectorService;
}

describe("MCP recovery on takeover", () => {
  it("reconciles what the previous driver left before this one repeats it", async () => {
    const ws = await workspace();
    const events: string[] = [];
    const proc = await startProcess(ws, { prs: [] });
    proc.deps.mcp = recordingMcp(events);
    const run = pullRequestStageRun("run_takeover", ws.repo, ws.baseCommitSha, { effects: [startedEffect()] });
    await proc.store.saveRun(run);

    const drove = await new Pipeline(proc.deps).process(run.id);

    expect(drove).toBe(true);
    expect(events).toEqual([`reconcile:${run.id}`]);
    // Reconciliation is not an extra pass afterwards: it happens before the effect.
    expect(proc.created).toEqual([1]);
    expect((await proc.store.getRun(run.id))?.state).toBe("COMPLETED");
  });

  it("does not reconcile a run it does not own", async () => {
    const ws = await workspace();
    const events: string[] = [];
    const proc = await startProcess(ws);
    proc.deps.mcp = recordingMcp(events);
    const held = pullRequestStageRun("run_held_mcp", ws.repo, ws.baseCommitSha, {
      effects: [startedEffect()],
      lease: { owner: "pid-someone-else", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    await proc.store.saveRun(held);

    expect(await new Pipeline(proc.deps).process(held.id)).toBe(false);
    expect(events).toEqual([]);
    expect(proc.created).toEqual([]);
  });
});
