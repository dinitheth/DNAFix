/**
 * Blind independent review of evaluation patches (replication-v1.3).
 * Reads ONLY review-packet-A.json / review-packet-B.json produced by the
 * evaluation harness: anonymized diff, changed files, base repository context,
 * executed check results and per-criterion acceptance results.
 * The reviewer (Muse Spark — a different model from the arms' executor) never
 * sees condition names, run IDs, Project DNA labels, or review-mapping.json.
 * Incomplete packets are refused: review must not proceed on missing evidence.
 * Usage: tsx scripts/blind-review.mts docs/evaluation/runs/<experiment-id>
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPacketAnonymized, assertPacketComplete, ReviewPacketError, type ReviewPacket } from "@dnafix/domain";
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

const ACCEPTANCE_IDS = ["A1", "A2", "A3", "A4", "A5"] as const;

async function loadPacket(label: "A" | "B"): Promise<ReviewPacket> {
  let raw: string;
  try {
    raw = await readFile(path.join(runsDir, `review-packet-${label}.json`), "utf8");
  } catch {
    throw new ReviewPacketError(`review-packet-${label}.json not found in ${runsDir}. Blind review requires evidence packets (replication-v1.3); refusing to review a bare diff.`);
  }
  const packet = JSON.parse(raw) as ReviewPacket;
  if (packet.label !== label) throw new ReviewPacketError(`packet label mismatch: expected ${label}, got ${packet.label}`);
  assertPacketAnonymized(packet);
  assertPacketComplete(packet, ACCEPTANCE_IDS);
  return packet;
}

const packets = { A: await loadPacket("A"), B: await loadPacket("B") };
console.log("Anonymization + completeness checks passed for review packets A and B (repo context, executed checks, A1-A5 results present; no arm identifiers).");

const reviewer = new MetaModelProvider({ model: process.env.MUSE_SPARK_MODEL ?? "muse-spark-1.3" });
const reviews: Record<string, unknown> = {};
for (const label of ["A", "B"] as const) {
  const packet = packets[label];
  const review = await reviewer.reviewVerification({
    issueTitle: "Promo codes are accepted but silently ignored (benchmark issue, frozen criteria)",
    acceptanceCriteria: packet.acceptance.map((a) => a.id),
    predictedPaths: [],
    changedPaths: packet.changedFiles,
    diff: [
      packet.diff,
      "",
      "--- Base repository context (files at the base commit) ---",
      ...packet.repositoryContext.map((f) => `### ${f.path}\n${f.content}`),
      "",
      "--- Executed check results (deterministic; authoritative) ---",
      ...packet.executedChecks.map((c) => `${c.kind}: ${c.status} (exit ${c.exitCode})`),
      "",
      "--- Acceptance results (deterministic; authoritative) ---",
      ...packet.acceptance.map((a) => `${a.id}: ${a.passed ? "passed" : "failed"} — ${a.evidence}`),
    ].join("\n"),
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
      evidenceMode: "review-packets (repository context + executed checks + A1-A5 results)",
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
