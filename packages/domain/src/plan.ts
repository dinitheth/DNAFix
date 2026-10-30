import type { ImplementationPlan, ImplementationTask } from "@dnafix/contracts";
import { normalizeRepoPath } from "./scope.js";

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export function validatePlanSemantics(plan: ImplementationPlan): void {
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) throw new PlanValidationError(`Duplicate task id '${task.id}'`);
    ids.add(task.id);
    for (const p of task.fileScope) normalizeRepoPath(p);
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new PlanValidationError(`Task '${task.id}' depends on unknown task '${dep}'`);
      if (dep === task.id) throw new PlanValidationError(`Task '${task.id}' depends on itself`);
    }
  }
  // Cycle detection (DFS).
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new PlanValidationError(`Task dependency cycle involving '${id}'`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of plan.tasks) visit(task.id);
}

/** Tasks are parallelizable only when dependency-free relative to each other and file scopes are disjoint. */
export function canRunInParallel(a: ImplementationTask, b: ImplementationTask): boolean {
  if (a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id)) return false;
  const scopeA = new Set(a.fileScope.map(normalizeRepoPath));
  for (const p of b.fileScope) {
    const n = normalizeRepoPath(p);
    for (const s of scopeA) {
      if (n === s || n.startsWith(`${s}/`) || s.startsWith(`${n}/`)) return false;
    }
  }
  return true;
}

export function findOverlappingChanges(changedByTask: ReadonlyMap<string, readonly string[]>): Array<{ path: string; taskIds: string[] }> {
  const owners = new Map<string, string[]>();
  for (const [taskId, paths] of changedByTask) {
    for (const raw of paths) {
      const p = normalizeRepoPath(raw);
      owners.set(p, [...(owners.get(p) ?? []), taskId]);
    }
  }
  return [...owners.entries()]
    .filter(([, taskIds]) => taskIds.length > 1)
    .map(([path, taskIds]) => ({ path, taskIds }));
}

/** Topological order respecting dependsOn; input order breaks ties. */
export function integrationOrder(tasks: readonly ImplementationTask[]): ImplementationTask[] {
  validatePlanSemantics({ tasks } as ImplementationPlan);
  const done = new Set<string>();
  const out: ImplementationTask[] = [];
  let remaining = [...tasks];
  while (remaining.length > 0) {
    const next = remaining.filter((t) => t.dependsOn.every((d) => done.has(d)));
    if (next.length === 0) throw new PlanValidationError("Cannot order tasks: dependency cycle");
    for (const t of next) {
      out.push(t);
      done.add(t.id);
    }
    remaining = remaining.filter((t) => !done.has(t.id));
  }
  return out;
}
