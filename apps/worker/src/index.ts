import { Pipeline, createDefaultDeps } from "@dnafix/application";

/**
 * Worker entrypoint.
 * Default: in-process durable engine (ADR-0004) — polls the store for QUEUED runs
 * and drives them to their next pause/terminal state. Approvals submitted through
 * the API re-invoke the pipeline directly, so this poller is a recovery path.
 * With WORKFLOW_ENGINE=temporal, starts a Temporal worker instead (see ./temporal.ts).
 */
if (process.env.WORKFLOW_ENGINE === "temporal") {
  const { startTemporalWorker } = await import("./temporal.js");
  await startTemporalWorker();
} else {
  const deps = createDefaultDeps();
  const pipeline = new Pipeline(deps);
  console.log("[dnafix-worker] in-process durable engine polling for QUEUED runs (WORKFLOW_ENGINE != temporal)");
  const tick = async () => {
    const runs = await deps.store.listRuns();
    for (const run of runs) {
      if (run.state === "QUEUED") {
        console.log(`[dnafix-worker] processing ${run.id}`);
        await pipeline.process(run.id).catch((err: Error) => console.error(`[dnafix-worker] ${run.id}: ${err.message}`));
      }
    }
  };
  await tick();
  setInterval(() => void tick(), 3_000);
}
