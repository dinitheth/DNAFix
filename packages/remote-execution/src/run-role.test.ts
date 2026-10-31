import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateControlPlanePolicy } from "./iam-validation.js";
import { MemoryCleanupStore, RoleReaper, isReapableRole } from "./role-reaper.js";
import { RunRoleManager, buildRevocationPolicy, buildTrustPolicy, codeBuildProjectArn, type IamOperations } from "./run-role.js";
import type { TemporaryRoleInfo } from "./role-reaper.js";

const SCOPE = { bucket: "bucket", region: "ap-southeast-2", accountId: "121728644078", logGroupName: "/aws/codebuild/dnafix-build", projectName: "dnafix-build" };

function fakeIam(failures: { putPolicyNames?: Set<string>; deleteFails?: boolean } = {}) {
  const calls: string[] = [];
  const iam: IamOperations = {
    createRole: async (input) => {
      calls.push(`createRole:${input.roleName}`);
      if (failures.putPolicyNames?.has(input.policyName)) {
        // Simulate SDK createRole with failing initial PutRolePolicy via manager below; here succeed.
      }
      return { arn: `arn:aws:iam::121728644078:role/${input.roleName}` };
    },
    putPolicy: async (input) => {
      calls.push(`putPolicy:${input.policyName}`);
      if (failures.putPolicyNames?.has(input.policyName)) throw new Error(`PutRolePolicy failed: ${input.policyName}`);
    },
    updateTrustPolicy: async (input) => {
      calls.push(`updateTrust:${input.roleName}`);
    },
    deleteRole: async (roleName, policyNames) => {
      calls.push(`deleteRole:${roleName}:${policyNames.join("+")}`);
      if (failures.deleteFails) throw new Error("DeleteRole failed");
    },
  };
  return { iam, calls };
}

const noSleep = async () => undefined;

describe("trust policy (P0)", () => {
  it("1. restricts assumption to CodeBuild for the exact account and project ARN", () => {
    const trust = buildTrustPolicy({ region: "ap-southeast-2", accountId: "121728644078", projectName: "dnafix-build" }) as {
      Statement: Array<{ Principal: { Service: string }; Condition: { StringEquals: Record<string, string> } }>;
    };
    const stmt = trust.Statement[0]!;
    expect(stmt.Principal.Service).toBe("codebuild.amazonaws.com");
    expect(stmt.Condition.StringEquals["aws:SourceAccount"]).toBe("121728644078");
    expect(stmt.Condition.StringEquals["aws:SourceArn"]).toBe("arn:aws:codebuild:ap-southeast-2:121728644078:project/dnafix-build");
    expect(codeBuildProjectArn({ region: "ap-southeast-2", accountId: "121728644078", projectName: "dnafix-build" })).toBe(
      "arn:aws:codebuild:ap-southeast-2:121728644078:project/dnafix-build",
    );
  });

  it("2. rejects invalid account, region, or project values instead of generating a weak trust", () => {
    expect(() => buildTrustPolicy({ region: "ap-southeast-2", accountId: "abc", projectName: "dnafix-build" })).toThrow(/account ID/);
    expect(() => buildTrustPolicy({ region: "nowhere", accountId: "121728644078", projectName: "dnafix-build" })).toThrow(/region/);
    expect(() => buildTrustPolicy({ region: "ap-southeast-2", accountId: "121728644078", projectName: "bad/name" })).toThrow(/project name/);
    expect(() => buildTrustPolicy({ region: "ap-southeast-2", accountId: "*", projectName: "dnafix-build" })).toThrow(/account ID/);
  });

  it("15. policy generation validates runId directly (no injection into IAM JSON)", async () => {
    const { buildRunRolePolicy } = await import("./run-role.js");
    expect(() => buildRunRolePolicy({ ...SCOPE, runId: "../evil" })).toThrow(/Invalid runId/);
    expect(() => buildRunRolePolicy({ ...SCOPE, runId: "a/b" })).toThrow(/Invalid runId/);
    expect(() => buildRunRolePolicy({ ...SCOPE, runId: "run_*\"; DROP" })).toThrow(/Invalid runId/);
  });
});

describe("revocation lifecycle (P0)", () => {
  it("3. generates a TokenIssueTime deny revocation policy", () => {
    const policy = buildRevocationPolicy("2026-10-31T00:00:00.000Z") as { Statement: Array<{ Effect: string; Condition: unknown }> };
    expect(policy.Statement[0]?.Effect).toBe("Deny");
    expect(JSON.stringify(policy)).toContain("aws:TokenIssueTime");
    expect(() => buildRevocationPolicy("not-a-date")).toThrow(/timestamp/);
  });

  it("5. deletes the role only after revocation is applied (order recorded)", async () => {
    const { iam, calls } = fakeIam();
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep, { maxSessionDurationSeconds: 0, propagationGraceMs: 0 });
    const { record } = await manager.createRunRole("run_1");
    const outcome = await manager.revokeAndDelete(record);
    expect(calls.indexOf("updateTrust:dnafix-run-run_1")).toBeGreaterThanOrEqual(0); // deny new assumptions first
    expect(calls.indexOf("putPolicy:dnafix-quarantine-deny-all")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("putPolicy:dnafix-quarantine-deny-all")).toBeLessThan(calls.indexOf("putPolicy:dnafix-revoke-sessions"));
    expect(calls.indexOf("putPolicy:dnafix-revoke-sessions")).toBeLessThan(calls.findIndex((c) => c.startsWith("deleteRole:")));
    expect(outcome.containmentStatus).toBe("contained");
    expect(outcome.lifecycleState).toBe("DELETED");
    expect(outcome.revocation.policyApplied).toBe(true);
    expect(outcome.revocation.confirmationStatus).toBe("applied-unconfirmed"); // never claimed as instant/confirmed
    expect(outcome.deletion.deleted).toBe(true);
  });

  it("4. revocation failure: role is NOT deleted, state is unresolved and retryable", async () => {
    const { iam, calls } = fakeIam({ putPolicyNames: new Set(["dnafix-revoke-sessions"]) });
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep);
    const { record } = await manager.createRunRole("run_1");
    const outcome = await manager.revokeAndDelete(record);
    expect(outcome.containmentStatus).toBe("unresolved");
    expect(outcome.revocation.confirmationStatus).toBe("failed");
    expect(calls.some((c) => c.startsWith("deleteRole:"))).toBe(false);
    expect(manager.unresolvedCleanups()).toHaveLength(1);
    // Reuse of a role with unresolved cleanup is refused.
    await expect(manager.createRunRole("run_1")).rejects.toThrow(/unresolved/);
  });

  it("deletion failure after revocation: revocation-applied-deletion-pending", async () => {
    const { iam } = fakeIam({ deleteFails: true });
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep, { maxSessionDurationSeconds: 0, propagationGraceMs: 0 });
    const { record } = await manager.createRunRole("run_1");
    const outcome = await manager.revokeAndDelete(record);
    expect(outcome.containmentStatus).toBe("unresolved");
    expect(outcome.lifecycleState).toBe("UNRESOLVED");
    expect(outcome.revocation.policyApplied).toBe(true);
    expect(outcome.deletion.deleted).toBe(false);
  });
});

describe("partial creation + reaper (P0)", () => {
  it("6. PutRolePolicy failure during creation triggers compensating deletion", async () => {
    const calls: string[] = [];
    const { SdkIamOperations } = await import("./run-role.js");
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        calls.push(command.constructor.name);
        if (command.constructor.name === "PutRolePolicyCommand") throw new Error("policy rejected");
        if (command.constructor.name === "CreateRoleCommand") return { Role: { Arn: "arn:aws:iam::121728644078:role/dnafix-run-x" } };
        return {};
      },
    };
    const ops = new SdkIamOperations(client as never);
    await expect(ops.createRole({ roleName: "dnafix-run-x", trustPolicy: {}, policyName: "p", policy: {} })).rejects.toThrow(/compensating role deletion attempted/);
    expect(calls).toContain("DeleteRoleCommand");
  });

  it("7+8. reaper only touches validated, old, inactive DNAFix temporary roles", async () => {
    const { iam, calls } = fakeIam();
    const manager = new RunRoleManager(iam, SCOPE, 0, noSleep);
    const now = Date.parse("2026-10-31T00:00:00Z");
    const old = new Date(now - 48 * 3600_000).toISOString();
    const young = new Date(now - 3600_000).toISOString();
    const reaper = new RoleReaper(
      {
        listTemporaryRoles: async (): Promise<TemporaryRoleInfo[]> => [
          { roleName: "dnafix-run-old", arn: "arn:aws:iam::121728644078:role/dnafix-run-old", createdAt: old, tags: { Project: "DNAFix", Ephemeral: "true" } },
          { roleName: "dnafix-run-young", arn: "arn:x", createdAt: young, tags: { Project: "DNAFix", Ephemeral: "true" } },
          { roleName: "dnafix-run-active", arn: "arn:x", createdAt: old, tags: { Project: "DNAFix", Ephemeral: "true" } },
          { roleName: "production-admin", arn: "arn:x", createdAt: old, tags: {} },
          { roleName: "dnafix-run-untagged", arn: "arn:x", createdAt: old, tags: {} },
        ],
        activeRoleNames: async () => new Set(["dnafix-run-active"]),
        manager,
        store: new MemoryCleanupStore(),
      },
      24 * 3600_000,
    );
    const results = await reaper.reconcile(now);
    const byName = new Map(results.map((r) => [r.roleName, r.action]));
    // New lifecycle: abandoned roles are quarantined first; deletion happens only in a later pass after deleteNotBefore.
    expect(byName.get("dnafix-run-old")).toBe("quarantined");
    expect(byName.get("dnafix-run-young")).toBe("skipped");
    expect(byName.get("dnafix-run-active")).toBe("skipped");
    expect(byName.get("production-admin")).toBe("skipped");
    expect(byName.get("dnafix-run-untagged")).toBe("skipped");
    expect(calls.filter((c) => c.startsWith("deleteRole:"))).toEqual([]);
    expect(isReapableRole({ roleName: "other", arn: "a", createdAt: old, tags: { Project: "DNAFix", Ephemeral: "true" } }, now, 1000, new Set()).reapable).toBe(false);
  });
});

describe("control-plane policy proposal (P1)", () => {
  it("16. the shipped proposal validates as least-privilege; wildcards fail", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const proposal = JSON.parse(readFileSync(path.join(here, "../../../docs/security/control-plane-policy.json"), "utf8")) as never;
    const result = validateControlPlanePolicy(proposal, { bucket: "dnafix-artifacts-121728644078", region: "ap-southeast-2", accountId: "121728644078", logGroupName: "/aws/codebuild/dnafix-build", projectName: "dnafix-build" });
    expect(result).toEqual({ valid: true, findings: [] });
    const bad = { Statement: [{ Effect: "Allow", Action: "iam:PassRole", Resource: "*" }] };
    expect(validateControlPlanePolicy(bad, { bucket: "b", region: "ap-southeast-2", accountId: "121728644078", logGroupName: "/aws/codebuild/dnafix-build", projectName: "dnafix-build" }).valid).toBe(false);
  });
});
