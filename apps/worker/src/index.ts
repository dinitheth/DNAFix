import { Pipeline, createDefaultDeps, describeStore, isDrivable, migrateLegacyStore } from "@dnafix/application";

/**
 * Worker entrypoint.
 * Default: in-process durable engine (ADR-0004) — polls the store for runs a driver
 * may own and drives them to their next pause/terminal state. QUEUED is the normal
 * hand-off; an intermediate state means the previous driver stopped mid-phase, so
 * picking it up is the crash-recovery path. Approvals submitted through the API
 * re-invoke the pipeline directly, and the stored lease keeps the two apart.
 * With WORKFLOW_ENGINE=temporal, starts a Temporal worker instead (see ./temporal.ts).
 */
if (process.env.REAPER_ENABLED === "true") {
  const { startRoleReaperWorker } = await import("./reaper.js");
  startRoleReaperWorker();
}

if (process.env.WORKFLOW_ENGINE === "temporal") {
  const { startTemporalWorker } = await import("./temporal.js");
  await startTemporalWorker();
} else {
  const deps = createDefaultDeps();
  await migrateLegacyStore(deps);
  const pipeline = new Pipeline(deps);
  console.log(`[dnafix-worker] in-process durable engine polling for drivable runs (data root: ${deps.dataRoot}, store: ${describeStore(deps.store).location})`);
  const tick = async () => {
    const runs = await deps.store.listRuns();
    for (const run of runs) {
      if (!isDrivable(run.state)) continue;
      // Resolves false when another process holds the lease: the run is being worked,
      // not waiting.
      const driven = await pipeline.process(run.id).catch((err: Error) => {
        console.error(`[dnafix-worker] ${run.id}: ${err.message}`);
        return false;
      });
      if (driven) console.log(`[dnafix-worker] drove ${run.id} from ${run.state}`);
    }
  };
  await tick();
  setInterval(() => void tick(), 3_000);
}
