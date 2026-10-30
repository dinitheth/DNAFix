/**
 * Deterministic Temporal workflow (no I/O, no randomness, no Date.now).
 * All side effects live in activities (see temporal.ts). Human decisions arrive
 * as signals and are awaited with condition(), mirroring the domain state machine.
 */
import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./temporal-activities.js";

const { processRunActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5s", backoffCoefficient: 2 },
});

export const planApprovedSignal = defineSignal("planApproved");
export const prApprovedSignal = defineSignal("prApproved");
export const clarificationSignal = defineSignal<[string]>("clarification");
export const cancelSignal = defineSignal("cancel");

export async function dnafixWorkflow(runId: string): Promise<string> {
  let planApproved = false;
  let prApproved = false;
  let cancelled = false;
  setHandler(planApprovedSignal, () => {
    planApproved = true;
  });
  setHandler(prApprovedSignal, () => {
    prApproved = true;
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  setHandler(clarificationSignal, () => undefined);

  // Drives the run to AWAITING_PLAN_APPROVAL / NEEDS_CLARIFICATION / BLOCKED / FAILED.
  let state = await processRunActivity(runId);
  if (state === "NEEDS_CLARIFICATION") {
    await condition(() => cancelled || planApproved);
    if (cancelled) return "CANCELLED";
    state = await processRunActivity(runId);
  }
  if (state !== "AWAITING_PLAN_APPROVAL") return state;
  await condition(() => planApproved || cancelled);
  if (cancelled) return "CANCELLED";
  state = await processRunActivity(runId); // AGENT_EXECUTION .. AWAITING_PR_APPROVAL
  if (state !== "AWAITING_PR_APPROVAL") return state;
  await condition(() => prApproved || cancelled);
  if (cancelled) return "CANCELLED";
  return processRunActivity(runId); // PULL_REQUEST_CREATION .. COMPLETED
}
