import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileCleanupStore, FileLock, MemoryCleanupStore, RoleReaper } from "./role-reaper.js";
import { RunRoleManager, buildDenyAllPolicy, buildDenyAssumeTrustPolicy, computeDeleteNotBefore, emptyCleanupRecord, type IamOperations } from "./run-role.js";

const SCOPE = { bucket: "bucket", region: "ap-southeast-2", accountId: "121728644078", logGroupName: "/aws/codebuild/dnafix-build", projectName: "dnafix-build" };
const noSleep = async () => undefined;

function fakeIam(fail: { trust?: boolean; denyAll?: boolean } = {}) {
  const calls: string[] = [];
  const iam: IamOperations = {
    createRole: async (input) => {
      calls.push(`create:${input.roleName}`);
      return { arn: `arn:aws:iam::121728644078:role/${input.roleName}` };
    },
    putPolicy: async (input) => {
      calls.push(`put:${input.policyName}`);
      if (fail.denyAll && input.policyName === "dnafix-quarantine-deny-all") throw new Error("deny-all rejected");
    },
    updateTrustPolicy: async () => {
      calls.push("trust");
      if (fail.trust) throw new Error("trust update rejected");
    },
    deleteRole: async (roleName) => {
      calls.push(`delete:${roleName}`);
    },
  };
  return { iam, calls };
}

describe("quarantine lifecycle (Phase 3)", () => {
  it("1+2+3. transition order: deny-assume -> deny-all -> TokenIssueTime revocation; policies are deny-shaped", async () => {
    expect(buildDenyAllPolicy()).toMatchObject({ Statement: [{ Effect: "Deny", Action: "*", Resource: "*" }] });
    expect(buildDenyAssumeTrustPolicy()).toMatchObject({ Statement: [{ Effect: "Deny", Action: "sts:AssumeRole" }] });
    const { iam, calls } = fakeIam();
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep);
    const { record } = await manager.createRunRole("run_1");
    await manager.quarantine(record);
    expect(calls.indexOf("trust")).toBeLessThan(calls.indexOf("put:dnafix-quarantine-deny-all"));
    expect(calls.indexOf("put:dnafix-quarantine-deny-all")).toBeLessThan(calls.indexOf("put:dnafix-revoke-sessions"));
    expect(record.lifecycleState).toBe("WAITING_FOR_SESSION_EXPIRY");
    expect(record.denyAllApplied).toBe(true);
  });

  it("5. role is retained throughout quarantine (no DeleteRole call)", async () => {
    const { iam, calls } = fakeIam();
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep);
    const { record } = await manager.createRunRole("run_1");
    await manager.quarantine(record);
    expect(calls.some((c) => c.startsWith("delete:"))).toBe(false);
    const early = await manager.deleteWhenSafe(record, Date.now());
    expect(early.lifecycleState).toBe("WAITING_FOR_SESSION_EXPIRY");
    expect(calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  it("6. deleteNotBefore = quarantinedAt + MaxSessionDuration + grace", () => {
    expect(computeDeleteNotBefore("2026-01-01T00:00:00.000Z", 3600, 900_000)).toBe("2026-01-01T01:15:00.000Z");
  });

  it("12. partial IAM failure during quarantine: UNRESOLVED, role preserved, no deletion", async () => {
    const { iam, calls } = fakeIam({ denyAll: true });
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep);
    const { record } = await manager.createRunRole("run_1");
    const outcome = await manager.quarantine(record);
    expect(outcome.lifecycleState).toBe("UNRESOLVED");
    expect(outcome.containmentStatus).toBe("unresolved");
    expect(calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(manager.unresolvedCleanups()).toHaveLength(1);
  });

  it("15. quarantine is idempotent: second call applies nothing twice", async () => {
    const { iam, calls } = fakeIam();
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep);
    const { record } = await manager.createRunRole("run_1");
    await manager.quarantine(record);
    const opsAfterFirst = record.operations.length;
    await manager.quarantine(record);
    expect(record.operations.length).toBe(opsAfterFirst);
    expect(calls.filter((c) => c === "put:dnafix-quarantine-deny-all")).toHaveLength(1);
  });
});

describe("reaper operations", () => {
  const manager = () => new RunRoleManager(fakeIam().iam, SCOPE, 0, noSleep, { maxSessionDurationSeconds: 0, propagationGraceMs: 0 });

  it("7+9. refuses early deletion and never touches active-build roles; deletes eligible after deadline", async () => {
    const store = new MemoryCleanupStore();
    const waiting = emptyCleanupRecord("dnafix-run-a", "a");
    waiting.lifecycleState = "WAITING_FOR_SESSION_EXPIRY";
    waiting.quarantinedAt = new Date(Date.now() - 7_200_000).toISOString();
    waiting.deleteNotBefore = new Date(Date.now() - 3_600_000).toISOString();
    const activeRec = emptyCleanupRecord("dnafix-run-b", "b");
    activeRec.lifecycleState = "WAITING_FOR_SESSION_EXPIRY";
    activeRec.deleteNotBefore = new Date(Date.now() - 3_600_000).toISOString();
    await store.save([waiting, activeRec]);
    const reaper = new RoleReaper({
      listTemporaryRoles: async () => [],
      activeRoleNames: async () => new Set(["dnafix-run-b"]),
      manager: manager(),
      store,
    });
    const outcomes = await reaper.reconcile();
    expect(outcomes.find((o) => o.roleName === "dnafix-run-a")?.action).toBe("deleted");
    expect(outcomes.find((o) => o.roleName === "dnafix-run-b")?.action).toBe("skipped");
  });

  it("10. recovery after restart: a new reaper instance resumes persisted quarantine state", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-reaper-"));
    const storePath = path.join(dir, "role-cleanups.json");
    const rec = emptyCleanupRecord("dnafix-run-c", "c");
    rec.lifecycleState = "WAITING_FOR_SESSION_EXPIRY";
    rec.deleteNotBefore = new Date(Date.now() - 1000).toISOString();
    await new FileCleanupStore(storePath).save([rec]);
    // Simulated restart: brand-new store + reaper instances over the same file.
    const reaper = new RoleReaper({
      listTemporaryRoles: async () => [],
      activeRoleNames: async () => new Set<string>(),
      manager: manager(),
      store: new FileCleanupStore(storePath),
    });
    const outcomes = await reaper.reconcile();
    expect(outcomes[0]?.action).toBe("deleted");
    const persisted = await new FileCleanupStore(storePath).load();
    expect(persisted[0]?.lifecycleState).toBe("DELETED");
  });

  it("11. file lock prevents overlapping executions (second worker skips)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-lock-"));
    const lockPath = path.join(dir, "reaper.lock");
    const first = new FileLock(lockPath);
    const second = new FileLock(lockPath);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    await first.release();
    expect(await second.acquire()).toBe(true);
    await second.release();
  });

  it("14. persistence failure surfaces instead of being silently swallowed", async () => {
    const failingStore = {
      load: async () => [],
      save: async () => {
        throw new Error("disk full");
      },
    };
    const reaper = new RoleReaper({
      listTemporaryRoles: async () => [],
      activeRoleNames: async () => new Set<string>(),
      manager: manager(),
      store: failingStore,
    });
    await expect(reaper.reconcile()).rejects.toThrow(/disk full/);
  });
});
