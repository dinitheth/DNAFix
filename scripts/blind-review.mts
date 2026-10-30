/**
 * Blind independent review of evaluation patches.
 * Reads ONLY patch-A.diff / patch-B.diff + the frozen issue/criteria.
 * The reviewer (Muse Spark — a different model from the arms' executor) never
 * sees condition names, run IDs, or review-mapping.json.
 * Usage: tsx scripts/blind-review.mts docs/evaluation/runs/<experiment-id>
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MetaModelProvider } from "@dnafix/model-provider";

const runsDir = process.argv[2];
if (!runsDir) {
  console.error("usage: tsx scripts/blind-review.mts docs/evaluation/runs/<experiment-id>");
  process.exit(2);
}
if (!process.env.MODEL_API_KEY) {
  console.error("blind-review BLOCKED: MODEL_API_KEY not set. Deterministic scoring still stands; AI review skipped, not fabricated.");
  process.exit(2);
}

const CRITERIA = [
  "A valid promo code applies its percentage discount to the subtotal before tax (120 + WELCOME10 => discount 12, tax 10.8, shipping 0, total 118.8).",
  "The free-shipping threshold ($100) is evaluated on the discounted subtotal (105 + WELCOME10 => shipping 9.95 charged).",
  "Unknown promo codes are rejected as validation errors (API 400) and no order is stored.",
  "Promo codes are case-insensitive.",
  "Orders without a promo code behave exactly as before; no existing behavior regresses.",
];

// Identifyingscrub check: diffs must not contain run ids, branch names, or condition labels.
for (const name of ["patch-A.diff", "patch-B.diff"]) {
  const text = await readFile(path.join(runsDir, name), "utf8");
  const leaks = text.match(/run_[a-z0-9-]+|dnafix\/|baseline|dna-aware|scripted/i);
  if (leaks) {
    console.error(`blind-review ABORTED: ${name} contains identifying metadata: ${leaks[0]}`);
    process.exit(1);
  }
}
console.log("Anonymization scrub: patch-A.diff and patch-B.diff contain no run IDs, branch names, or condition labels.");

const reviewer = new MetaModelProvider({ model: process.env.MUSE_SPARK_MODEL ?? "muse-spark-1.3" });
const reviews: Record<string, unknown> = {};
for (const label of ["A", "B"] as const) {
  const diff = await readFile(path.join(runsDir, `patch-${label}.diff`), "utf8");
  const review = await reviewer.reviewVerification({
    issueTitle: "Promo codes are accepted but silently ignored (benchmark issue, frozen criteria)",
    acceptanceCriteria: CRITERIA,
    predictedPaths: [],
    changedPaths: [],
    diff: diff.trim() === "" ? "(empty patch — no changes were produced)" : diff,
    checks: [],
  });
  reviews[label] = { ...review, usageAfterCall: reviewer.lastUsage };
  console.log(`Patch ${label}: verdict=${review.verdict}`);
}
await writeFile(
  path.join(runsDir, "review.json"),
  JSON.stringify(
    {
      reviewer: { provider: "meta", modelId: reviewer.modelId, note: "AI review is supplementary; deterministic acceptance/regression results are authoritative." },
      rubric: CRITERIA,
      anonymizationScrubPassed: true,
      mappingSealedUntilReviewCompleted: true,
      reviews,
      reviewedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
  "utf8",
);
console.log(`review.json written to ${runsDir}`);
