import { describe, expect, it } from "vitest";
import { Pipeline } from "@dnafix/application";
import { countingPlanner, pullRequestStageRun, stableIntelligence, startProcess, workspace } from "./harness.js";

/**
 * IMPACT_ANALYSIS is the phase that buys a plan. A resume that re-asks the model for
 * the same question spends money and can return a different answer, so the journal
 * keys the call by what was asked and the plan is checkpointed in the same write.
 */
/** Start where the analysis phase does, so the intelligence report is real pipeline output. */
function analysisStageRun(runId: string, repo: string, baseCommitSha: string) {
  return {
    ...pullRequestStageRun(runId, repo, baseCommitSha, { state: "PROJECT_DNA_ANALYSIS" }),
    tasks: [],
    effects: [],
  };
}

describe("planner checkpoint", () => {
  it("pays for the plan once and reuses it when the phase is re-driven", async () => {
    const ws = await workspace();
    const planner = countingPlanner();
    const proc = await startProcess(ws, { model: planner.model, intelligence: stableIntelligence() });
    const run = analysisStageRun("run_plan_first", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);
    const afterFirst = await proc.store.getRun(run.id);
    expect(afterFirst?.state).toBe("AWAITING_PLAN_APPROVAL");
    expect(planner.calls).toHaveLength(1);

    // The crash this stands in for: the process died after the checkpoint write and
    // the poller re-enters the same phase.
    await proc.store.saveRun({ ...(await proc.store.getRun(run.id))!, state: "IMPACT_ANALYSIS" });
    await new Pipeline(proc.deps).process(run.id);

    const afterResume = await proc.store.getRun(run.id);
    expect(planner.calls, "the same question must not be asked twice").toHaveLength(1);
    expect(afterResume?.state).toBe("AWAITING_PLAN_APPROVAL");
    expect(afterResume?.plan).toEqual(afterFirst?.plan);
    expect(afterResume?.effects?.filter((e) => e.kind === "model.analyze-and-plan")).toHaveLength(1);
    const actions = (await proc.store.listAudit(run.id)).map((event) => event.action);
    expect(actions).toContain("model.plan.reused");
  });

  it("asks again when the question itself changed", async () => {
    const ws = await workspace();
    const planner = countingPlanner();
    const proc = await startProcess(ws, { model: planner.model, intelligence: stableIntelligence() });
    const run = analysisStageRun("run_plan_changed", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);

    await new Pipeline(proc.deps).process(run.id);
    expect(planner.calls).toHaveLength(1);

    const stored = (await proc.store.getRun(run.id))!;
    await proc.store.saveRun({ ...stored, state: "IMPACT_ANALYSIS", clarificationAnswer: "Only for cart totals above 100." });
    await new Pipeline(proc.deps).process(run.id);

    expect(planner.calls).toHaveLength(2);
    expect(planner.calls[0]?.hash).not.toBe(planner.calls[1]?.hash);
    const current = await proc.store.getRun(run.id);
    expect(current?.effects?.filter((e) => e.kind === "model.analyze-and-plan")).toHaveLength(2);
  });

  it("keeps finished task work when the phase is re-driven", async () => {
    const ws = await workspace();
    const proc = await startProcess(ws, { model: countingPlanner(["fix-discount", "add-regression-test"]).model, intelligence: stableIntelligence() });
    const run = analysisStageRun("run_plan_tasks", ws.repo, ws.baseCommitSha);
    await proc.store.saveRun(run);
    await new Pipeline(proc.deps).process(run.id);

    const stored = (await proc.store.getRun(run.id))!;
    expect(stored.tasks.map((t) => t.taskId)).toEqual(["fix-discount", "add-regression-test"]);
    const done = { ...stored.tasks[0]!, status: "completed" as const, commitSha: "deadbeef", changedPaths: ["src/discount.ts"] };
    await proc.store.saveRun({ ...stored, state: "IMPACT_ANALYSIS", tasks: [done, stored.tasks[1]!] });
    await new Pipeline(proc.deps).process(run.id);

    const after = (await proc.store.getRun(run.id))!;
    expect(after.tasks.find((t) => t.taskId === "fix-discount")).toMatchObject({ status: "completed", commitSha: "deadbeef" });
    expect(after.tasks.find((t) => t.taskId === "add-regression-test")?.status).toBe("pending");
  });
});
