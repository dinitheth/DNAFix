import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./temporal-activities.js";

export async function startTemporalWorker(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS;
  if (!address) {
    throw new Error("WORKFLOW_ENGINE=temporal requires TEMPORAL_ADDRESS (e.g. localhost:7233). Start infrastructure with docker compose up.");
  }
  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    workflowsPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "temporal-workflows.ts"),
    activities,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "dnafix",
    connection,
  });
  console.log(`[dnafix-worker] Temporal worker connected to ${address}, task queue dnafix`);
  await worker.run();
}
