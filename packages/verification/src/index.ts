import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationCheck } from "@dnafix/contracts";
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

export function checksPassed(checks: readonly VerificationCheck[]): boolean {
  return checks.every((c) => c.status === "passed" || c.status === "skipped" || c.status === "not-executed" || c.status === "pre-existing-failure");
}
