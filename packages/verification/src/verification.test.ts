import type { CommandResult, VerificationCheck } from "@dnafix/contracts";
import { describe, expect, it } from "vitest";
import { evaluateVerification } from "./index.js";

function result(exitCode: number | null): CommandResult {
  return { argv: ["pnpm", "run", "test"], cwd: "/repo", exitCode, timedOut: false, durationMs: 12, stdoutSummary: "", stderrSummary: "", sandboxMode: "host" };
}

function check(kind: VerificationCheck["kind"], status: VerificationCheck["status"], res: CommandResult | null = result(status === "passed" ? 0 : 1)): VerificationCheck {
  return { id: kind, kind, status, result: res, notes: "" };
}

describe("verification evidence rules", () => {
  it("passes when a required check executed and passed", () => {
    const e = evaluateVerification([check("test", "passed")]);
    expect(e.ok).toBe(true);
    expect(e.repairable).toEqual([]);
    expect(e.needsHuman).toEqual([]);
  });

  it("blocks when nothing executed, even though no check failed", () => {
    const e = evaluateVerification([check("test", "not-executed", null), check("lint", "not-executed", null)]);
    expect(e.ok).toBe(false);
    expect(e.needsHuman.join(" ")).toMatch(/No verification check executed/);
  });

  it("treats an executed failure as repairable by the agent", () => {
    const e = evaluateVerification([check("test", "failed")]);
    expect(e.ok).toBe(false);
    expect(e.repairable.join(" ")).toMatch(/test failed/);
    expect(e.needsHuman).toEqual([]);
  });

  it("blocks a pre-existing failure unless a human waives it", () => {
    const checks = [check("test", "passed"), check("lint", "pre-existing-failure")];
    expect(evaluateVerification(checks).ok).toBe(false);
    expect(evaluateVerification(checks).needsHuman.join(" ")).toMatch(/waiver/);

    const waived = evaluateVerification(checks, { waivers: [{ checkId: "lint", reason: "lint was already red on main", evidence: "CI run 4471 on the base commit", waivedBy: "maintainer", waivedAt: "2026-11-04T00:00:00Z" }] });
    expect(waived.ok).toBe(true);
    expect(waived.notes.join(" ")).toMatch(/waiver/);
  });

  it("recognises a baseline failure that the change fixed", () => {
    const e = evaluateVerification([check("test", "passed")], { baselineFailingIds: new Set(["test"]) });
    expect(e.ok).toBe(true);
    expect(e.regressionEvidence).toBe(true);
  });

  it("notes when no baseline failure was repaired", () => {
    const e = evaluateVerification([check("test", "passed")], { baselineFailingIds: new Set(["typecheck"]) });
    expect(e.ok).toBe(true);
    expect(e.regressionEvidence).toBe(false);
    expect(e.notes.join(" ")).toMatch(/not demonstrated as fixed/);
  });

  it("blocks a check that produced no exit code", () => {
    const e = evaluateVerification([check("test", "blocked", result(null))]);
    expect(e.ok).toBe(false);
    expect(e.needsHuman.join(" ")).toMatch(/no exit code/);
  });

  it("does not let a skipped check stand in for evidence", () => {
    const e = evaluateVerification([check("test", "skipped", null), check("typecheck", "not-executed", null)]);
    expect(e.ok).toBe(false);
    expect(e.needsHuman.join(" ")).toMatch(/No verification check executed/);
  });

  it("passes when only some kinds have scripts, as long as one executed and passed", () => {
    const e = evaluateVerification([check("test", "passed"), check("lint", "not-executed", null)]);
    expect(e.ok).toBe(true);
    expect(e.notes.join(" ")).toMatch(/lint has no runnable script/);
  });
});
