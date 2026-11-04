import { Pipeline, createDefaultDeps, migrateLegacyStore } from "@dnafix/application";

const deps = createDefaultDeps();
await migrateLegacyStore(deps);
const pipeline = new Pipeline(deps);

/** Activity boundary: all external effects (git, DNA, model, Docker, GitHub, DB) happen here, never in workflow code. */
export async function processRunActivity(runId: string): Promise<string> {
  await pipeline.process(runId);
  const run = await deps.store.getRun(runId);
  return run?.state ?? "FAILED";
}
