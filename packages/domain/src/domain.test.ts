import { describe, expect, it } from "vitest";
import type { ImplementationPlan, ImplementationTask } from "@dnafix/contracts";
import { assertTransition, canTransition, InvalidTransitionError } from "./workflow.js";
import { assertOperationsInScope, isPathInScope, ScopeViolationError } from "./scope.js";
import { canRunInParallel, findOverlappingChanges, integrationOrder, PlanValidationError, validatePlanSemantics } from "./plan.js";

const task = (id: string, fileScope: string[], dependsOn: string[] = []): ImplementationTask => ({
  id,
  title: id,
  description: id,
  expectedOutcome: id,
  fileScope,
  dependsOn,
  acceptanceCriteria: ["works"],
  testExpectations: [],
  retryLimit: 1,
});

const plan = (tasks: ImplementationTask[]): ImplementationPlan => ({
  baseCommitSha: "abc1234",
  repositorySnapshotId: "snap",
  steps: [{ id: "s1", description: "do" }],
  tasks,
  validationPlan: [],
  predictedAffectedPaths: [],
  unresolvedQuestions: [],
  requiresHumanClarification: false,
});

describe("workflow state machine", () => {
  it("allows the happy-path transitions", () => {
    expect(canTransition("QUEUED", "REPOSITORY_PREPARATION")).toBe(true);
    expect(canTransition("AWAITING_PLAN_APPROVAL", "AGENT_EXECUTION")).toBe(true);
    expect(canTransition("PULL_REQUEST_CREATION", "COMPLETED")).toBe(true);
  });
  it("rejects skipping states and leaving terminal states", () => {
    expect(canTransition("QUEUED", "COMPLETED")).toBe(false);
    expect(() => assertTransition("COMPLETED", "QUEUED")).toThrow(InvalidTransitionError);
  });
});

describe("plan validation", () => {
  it("accepts a valid plan", () => {
    expect(() => validatePlanSemantics(plan([task("a", ["src/a.ts"]), task("b", ["src/b.ts"], ["a"])]))).not.toThrow();
  });
  it("rejects cycles, unknown deps, duplicate ids", () => {
    expect(() => validatePlanSemantics(plan([task("a", ["src/a.ts"], ["b"]), task("b", ["src/b.ts"], ["a"])]))).toThrow(PlanValidationError);
    expect(() => validatePlanSemantics(plan([task("a", ["src/a.ts"], ["nope"])]))).toThrow(PlanValidationError);
    expect(() => validatePlanSemantics(plan([task("a", ["src/a.ts"]), task("a", ["src/b.ts"])]))).toThrow(PlanValidationError);
  });
  it("orders tasks by dependency", () => {
    const ordered = integrationOrder([task("b", ["src/b.ts"], ["a"]), task("a", ["src/a.ts"])]);
    expect(ordered.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("file scope enforcement", () => {
  it("allows in-scope paths and subpaths", () => {
    expect(isPathInScope("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(isPathInScope("src/sub/b.ts", ["src"])).toBe(true);
  });
  it("rejects traversal, absolute paths and out-of-scope patches", () => {
    expect(() => isPathInScope("../secrets.txt", ["src"])).toThrow(ScopeViolationError);
    expect(() => isPathInScope("/etc/passwd", ["src"])).toThrow(ScopeViolationError);
    expect(() => assertOperationsInScope([{ type: "delete", path: "src/evil.ts" }], ["docs"])).toThrow(ScopeViolationError);
  });
});

describe("parallelism and overlap", () => {
  it("parallelizes only disjoint, independent tasks", () => {
    expect(canRunInParallel(task("a", ["src/a.ts"]), task("b", ["src/b.ts"]))).toBe(true);
    expect(canRunInParallel(task("a", ["src"]), task("b", ["src/b.ts"]))).toBe(false);
    expect(canRunInParallel(task("a", ["src/a.ts"]), task("b", ["src/b.ts"], ["a"]))).toBe(false);
  });
  it("detects overlapping changed paths", () => {
    const overlaps = findOverlappingChanges(new Map([["a", ["src/x.ts"]], ["b", ["src/x.ts", "src/y.ts"]]]));
    expect(overlaps).toEqual([{ path: "src/x.ts", taskIds: ["a", "b"] }]);
  });
});
