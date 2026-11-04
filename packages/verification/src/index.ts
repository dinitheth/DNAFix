import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationCheck, VerificationWaiver } from "@dnafix/contracts";
import type { CommandRunner } from "@dnafix/execution";

export type CheckKind = VerificationCheck["kind"];

const SCRIPT_BY_KIND: Record<CheckKind, string[]> = {
  test: ["test"],
  typecheck: ["typecheck", "type-check", "check-types"],
  lint: ["lint"],
  format: ["format:check", "format-check"],
};

export interface DiscoveredCheck {
  kind: CheckKind;
  argv: string[];
  scriptName: string;
}

function packageManager(files: Set<string>): string {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  return "npm";
}

export async function discoverChecks(repoPath: string, kinds: CheckKind[] = ["test", "typecheck", "lint"]): Promise<DiscoveredCheck[]> {
  let pkg: { scripts?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await readFile(path.join(repoPath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return [];
  }
  const { readdir } = await import("node:fs/promises");
  const files = new Set(await readdir(repoPath).catch(() => [] as string[]));
  const pm = packageManager(files);
  const out: DiscoveredCheck[] = [];
  for (const kind of kinds) {
    const scriptName = SCRIPT_BY_KIND[kind].find((name) => pkg.scripts?.[name]);
    if (scriptName) out.push({ kind, argv: [pm, "run", scriptName], scriptName });
  }
  return out;
}

export async function runChecks(
  runner: CommandRunner,
  repoPath: string,
  opts: { kinds?: CheckKind[]; baselineFailingIds?: Set<string>; timeoutMs?: number } = {},
): Promise<VerificationCheck[]> {
  const discovered = await discoverChecks(repoPath, opts.kinds);
  const checks: VerificationCheck[] = [];
  for (const check of discovered) {
    const result = await runner.run(check.argv, { cwd: repoPath, timeoutMs: opts.timeoutMs ?? 300_000 });
    const passed = result.exitCode === 0 && !result.timedOut;
    checks.push({
      id: check.kind,
      kind: check.kind,
      status: passed ? "passed" : opts.baselineFailingIds?.has(check.kind) ? "pre-existing-failure" : "failed",
      result,
      notes: result.timedOut ? "Timed out" : `script: ${check.scriptName}`,
    });
  }
  for (const kind of opts.kinds ?? ["test", "typecheck", "lint"]) {
    if (!checks.some((c) => c.kind === kind)) {
      checks.push({ id: kind, kind, status: "not-executed", result: null, notes: "No matching package.json script discovered" });
    }
  }
  return checks;
}

export interface ImpactComparison {
  matched: string[];
  unexpected: string[];
  predictedButUnchanged: string[];
}

export function compareImpact(predicted: readonly string[], actualChanged: readonly string[]): ImpactComparison {
  const predictedSet = new Set(predicted);
  const actualSet = new Set(actualChanged);
  return {
    matched: actualChanged.filter((p) => predictedSet.has(p)),
    unexpected: actualChanged.filter((p) => !predictedSet.has(p)),
    predictedButUnchanged: predicted.filter((p) => !actualSet.has(p)),
  };
}

/**
 * Decide whether the executed evidence genuinely supports declaring a run
 * verified.
 *
 * Only a check that actually ran and passed counts. A check that never
 * executed, never produced an exit code, or was already failing at baseline
 * is never silently treated as a pass — a coding agent must not be able to
 * manufacture verification success by producing no evidence.
 */
export interface VerificationEvaluation {
  ok: boolean;
  /** Executed checks that failed. The agent may be able to repair these. */
  repairable: string[];
  /** Evidence gaps only a human can resolve. */
  needsHuman: string[];
  /** Recorded for the review packet; does not influence the decision. */
  notes: string[];
  /** True when a check that failed at baseline now passes. */
  regressionEvidence: boolean;
}

export function evaluateVerification(
  checks: readonly VerificationCheck[],
  opts: { baselineFailingIds?: ReadonlySet<string>; waivers?: readonly VerificationWaiver[] } = {},
): VerificationEvaluation {
  const repairable: string[] = [];
  const needsHuman: string[] = [];
  const notes: string[] = [];
  const waived = new Set((opts.waivers ?? []).map((w) => w.checkId));
  const executed = checks.filter((c) => c.result !== null && (c.status === "passed" || c.status === "failed" || c.status === "pre-existing-failure"));

  for (const check of checks) {
    if (check.status === "failed") repairable.push(`${check.id} failed (exit ${check.result?.exitCode ?? "unknown"}).`);
    else if (check.status === "blocked") needsHuman.push(`${check.id} produced no exit code, so it is not evidence either way.`);
    else if (check.status === "pre-existing-failure") {
      if (waived.has(check.id)) notes.push(`${check.id} was already failing at baseline and is covered by a human waiver.`);
      else needsHuman.push(`${check.id} was already failing at baseline and still fails. Exclude it with an evidence-backed waiver or fix it.`);
    } else if (check.status === "not-executed") notes.push(`${check.id} has no runnable script, so it contributes no evidence.`);
    else if (check.status === "skipped") notes.push(`${check.id} was skipped, so it contributes no evidence.`);
  }

  if (executed.length === 0) needsHuman.push("No verification check executed, so there is no evidence that the change works.");

  const regressionEvidence = executed.some((c) => c.status === "passed" && (opts.baselineFailingIds?.has(c.id) ?? false));
  if (opts.baselineFailingIds && opts.baselineFailingIds.size > 0 && !regressionEvidence) {
    notes.push("No check that failed at baseline now passes, so the reported defect is not demonstrated as fixed.");
  }

  return { ok: repairable.length === 0 && needsHuman.length === 0, repairable, needsHuman, notes, regressionEvidence };
}
