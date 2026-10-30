import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvaluationRunRecordSchema } from "@dnafix/contracts";
import { classifyArmFailure } from "./failure-classification.js";
import { assertPacketAnonymized, assertPacketComplete, executionOrderFromSeed, patchAssignmentFromSeed, type ReviewPacket } from "./review-packet.js";

const baseInput = {
  finalState: "COMPLETED",
  error: null,
  repairAttempts: 0,
  budgetExceeded: false,
  tasks: [{ taskId: "t1", status: "completed", error: null }],
  verificationChecks: [{ kind: "test", status: "passed" }],
  acceptanceAllPassed: true,
  diff: "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;",
};

describe("failure classification (offline scenarios)", () => {
  it("1. no failure: successful completion", () => {
    const r = classifyArmFailure(baseInput);
    expect(r.failureClass).toBeNull();
    expect(r.recoveryStatus).toBe("not-needed");
    expect(r.failureEvents).toEqual([]);
  });

  it("2. failure followed by successful repair: original class retained, recovered", () => {
    const r = classifyArmFailure({ ...baseInput, repairAttempts: 1, verificationChecks: [{ kind: "test", status: "failed" }] });
    expect(r.failureClass).toBe("test-failure");
    expect(r.recoveryStatus).toBe("recovered");
    expect(r.repairAttempts).toBe(1);
  });

  it("3. failure followed by exhausted repairs", () => {
    const r = classifyArmFailure({ ...baseInput, finalState: "BLOCKED", repairAttempts: 2, verificationChecks: [{ kind: "test", status: "failed" }] });
    expect(r.failureClass).toBe("test-failure");
    expect(r.recoveryStatus).toBe("exhausted");
  });

  it("4. multiple different failures during repair are all preserved in order", () => {
    const r = classifyArmFailure({
      ...baseInput,
      finalState: "BLOCKED",
      repairAttempts: 2,
      tasks: [{ taskId: "t2", status: "failed", error: "Muse Wonder response status=incomplete (max_output_tokens)" }],
      verificationChecks: [{ kind: "test", status: "failed" }],
    });
    expect(r.failureEvents.map((e) => e.failureClass)).toEqual(["model-empty-response", "test-failure"]);
    expect(r.failureClass).toBe("model-empty-response"); // first failure that triggered recovery
    expect(r.recoveryStatus).toBe("exhausted");
  });

  it("5. budget exhaustion", () => {
    const r = classifyArmFailure({ ...baseInput, finalState: "FAILED", budgetExceeded: true, error: "Budget refused generatePatch before request" });
    expect(r.failureClass).toBe("budget-exceeded");
  });

  it("6. incomplete model response", () => {
    const r = classifyArmFailure({
      ...baseInput,
      finalState: "BLOCKED",
      error: "Muse Wonder returned no text output for dnafix_patch",
      tasks: [{ taskId: "t1", status: "failed", error: "Muse Wonder response status=incomplete; no usable structured output" }],
    });
    expect(r.failureClass).toBe("model-empty-response");
  });

  it("7. infrastructure failure (Project DNA bridge), no repair triggered", () => {
    const r = classifyArmFailure({ ...baseInput, finalState: "BLOCKED", error: "Project DNA bridge exited 1: Cannot find module 'graphology'", tasks: [] });
    expect(r.failureClass).toBe("infrastructure-blocked");
    expect(r.recoveryStatus).toBe("not-needed");
  });

  it("canonical invalid-patch-generation (v1.2 baseline 'replace' import)", () => {
    const diff = [
      "diff --git a/src/services/order-service.ts b/src/services/order-service.ts",
      "-import { validateCreateOrderInput } from \"../validation/order-validator.ts\";",
      "+replace",
    ].join("\n");
    const r = classifyArmFailure({ ...baseInput, finalState: "BLOCKED", repairAttempts: 2, diff, verificationChecks: [{ kind: "test", status: "failed" }] });
    expect(r.failureClass).toBe("invalid-patch-generation");
    expect(r.recoveryStatus).toBe("exhausted");
    expect(r.repairAttempts).toBe(2);
  });

  it("8. historical (pre-v1.3) run records still parse: new fields default safely", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const old = JSON.parse(readFileSync(path.join(here, "../../../docs/evaluation/runs/pilot-2026-10-30T22-17-51-113Z/baseline.json"), "utf8")) as Record<string, unknown>;
    const parsed = EvaluationRunRecordSchema.parse(old);
    expect(parsed.outcome.failureClass).toBeNull();
    expect(parsed.outcome.recoveryStatus).toBe("not-needed");
    expect(parsed.outcome.failureEvents).toEqual([]);
    expect(parsed.provenance.dnafixGitSha).toBeNull();
    expect(parsed.repository.treeHash).toBe("");
  });
});

describe("reviewer packets", () => {
  const packet = (over: Partial<ReviewPacket> = {}): ReviewPacket => ({
    label: "A",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;",
    changedFiles: ["src/a.ts"],
    repositoryContext: [{ path: "src/a.ts", content: "export const x = 0;" }],
    executedChecks: [{ kind: "test", status: "passed", exitCode: 0 }],
    acceptance: ["A1", "A2", "A3", "A4", "A5"].map((id) => ({ id, passed: true, evidence: `${id} ok` })),
    ...over,
  });

  it("9a. complete anonymized packet passes validation", () => {
    expect(() => assertPacketComplete(packet(), ["A1", "A2", "A3", "A4", "A5"])).not.toThrow();
    expect(() => assertPacketAnonymized(packet())).not.toThrow();
  });

  it("9b. packet with missing acceptance results is refused", () => {
    expect(() => assertPacketComplete(packet({ acceptance: [{ id: "A1", passed: true, evidence: "ok" }] }), ["A1", "A2", "A3", "A4", "A5"])).toThrow(/incomplete/);
    expect(() => assertPacketComplete(packet({ executedChecks: [] }), ["A1", "A2", "A3", "A4", "A5"])).toThrow(/no executed check results/);
  });

  it("9c. reviewer cannot see condition mapping, DNA labels, or arm identifiers", () => {
    expect(() => assertPacketAnonymized(packet({ diff: "diff\ndna-aware was here" }))).toThrow(/identifying metadata/);
    expect(() => assertPacketAnonymized(packet({ diff: "see run_abc12345-678" }))).toThrow(/identifying metadata/);
    expect(() => assertPacketAnonymized(packet({ repositoryContext: [{ path: "x", content: "Project DNA impact says" }] }))).toThrow(/identifying metadata/);
  });

  it("10. randomized execution order is reproducible from its recorded seed", () => {
    for (const seed of [0, 1, 2, 3, 42, 123456]) {
      expect(executionOrderFromSeed(seed)).toEqual(executionOrderFromSeed(seed));
      expect(patchAssignmentFromSeed(seed)).toEqual(patchAssignmentFromSeed(seed));
    }
    expect(executionOrderFromSeed(0)).toEqual(["dna-aware", "baseline"]);
    expect(executionOrderFromSeed(1)).toEqual(["baseline", "dna-aware"]);
    const orders = new Set([0, 1, 2, 3].map((s) => executionOrderFromSeed(s).join(",")));
    expect(orders.size).toBe(2); // both orders reachable
  });
});
