/**
 * Offline demonstration. Uses ScriptedModelProvider — a scripted TEST DOUBLE.
 * It does NOT call Muse Wonder and must never be presented as doing so.
 * It proves the pipeline mechanics: baseline failure → plan gate → scoped patch
 * in a worktree → real test execution → verification → local patch delivery.
 * Project DNA is used for real when PROJECT_DNA_PATH is set; otherwise the run
 * will BLOCK at the analysis stage with an explicit error (by design).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pipeline, RunService, createDefaultDeps } from "@dnafix/application";
import { ScriptedModelProvider, type PatchInput, type PlanInput } from "@dnafix/model-provider";

console.log("=== DNAFix OFFLINE DEMO (scripted test double — NOT Muse Wonder) ===");
const issue = JSON.parse(readFileSync(path.resolve(process.cwd(), "tests", "fixtures", "issue.json"), "utf8")) as { title: string; body: string };

const scripted = new ScriptedModelProvider({
  plan: (input: PlanInput) => ({
    analysis: {
      summary: "Percentage discount is subtracted as a flat amount.",
      problemDescription: "applyDiscount subtracts percentOff as currency.",
      expectedBehavior: "applyDiscount(200, 10) === 180.",
      requirements: ["Fix percentage calculation in src/discount.ts"],
      acceptanceCriteria: ["applyDiscount(200, 10) === 180", "Existing test suite passes"],
      ambiguities: [],
      assumptions: [],
      riskLevel: "low",
    },
    plan: {
      baseCommitSha: input.baseCommitSha,
      repositorySnapshotId: input.repositorySnapshotId,
      steps: [{ id: "s1", description: "Fix applyDiscount" }],
      tasks: [
        {
          id: "fix-discount",
          title: "Fix percentage discount calculation",
          description: "Correct applyDiscount in src/discount.ts",
          expectedOutcome: "Percentage discounts are proportional.",
          fileScope: ["src/discount.ts"],
          dependsOn: [],
          acceptanceCriteria: ["applyDiscount(200, 10) === 180"],
          testExpectations: ["test suite passes"],
          retryLimit: 1,
        },
      ],
      validationPlan: [{ id: "v1", kind: "test", description: "Run test suite" }],
      predictedAffectedPaths: [{ path: "src/discount.ts", source: "model-hypothesis", reason: "Scripted demo plan", evidence: null }],
      unresolvedQuestions: [],
      requiresHumanClarification: false,
    },
    nominatedTargets: ["src/discount.ts"],
  }),
  patch: (_input: PatchInput) => ({
    summary: "Compute percentage discount proportionally.",
    operations: [
      {
        type: "replace" as const,
        path: "src/discount.ts",
        search: "  // BUG: subtracts the percentage number as a flat currency amount.\n  return price - percentOff;",
        replace: "  return price - (price * percentOff) / 100;",
      },
    ],
  }),
});

process.env.SANDBOX_MODE = process.env.SANDBOX_MODE ?? "host";
const deps = createDefaultDeps({ model: scripted });
const runs = new RunService(deps);
const pipeline = new Pipeline(deps);
const run = await runs.createRun({
  repositoryPath: path.resolve(process.cwd(), ".data", "fixture-repo"),
  issueTitle: issue.title,
  issueBody: issue.body,
});
console.log(`Run ${run.id} created (modelProvider=${run.modelProvider})`);
await pipeline.process(run.id);
let current = await deps.store.getRun(run.id);
console.log(`State after planning: ${current?.state}${current?.error ? ` — ${current.error}` : ""}`);
if (current?.state === "AWAITING_PLAN_APPROVAL") {
  console.log("Approving plan (demo)…");
  await runs.transition(current, "AGENT_EXECUTION");
  await pipeline.process(run.id);
  current = await deps.store.getRun(run.id);
  console.log(`State after execution+verification: ${current?.state}`);
  console.log(`Verification: ${JSON.stringify(current?.verificationChecks?.map((c) => `${c.kind}:${c.status}`))}`);
  if (current?.state === "AWAITING_PR_APPROVAL") {
    await runs.transition(current, "PULL_REQUEST_CREATION");
    await pipeline.process(run.id);
    current = await deps.store.getRun(run.id);
  }
}
console.log(`Final state: ${current?.state}`);
console.log(`Changed paths: ${(current?.changedPaths ?? []).join(", ") || "none"}`);
console.log("--- diff ---");
console.log(current?.diff ?? "(none)");
