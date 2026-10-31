import { BatchGetBuildsCommand, CodeBuildClient, ListBuildsForProjectCommand } from "@aws-sdk/client-codebuild";
import { IAMClient, ListRolesCommand, ListRoleTagsCommand } from "@aws-sdk/client-iam";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { RunRoleManager, emptyCleanupRecord, type RoleCleanupRecord } from "./run-role.js";

/**
 * Reconciliation for abandoned per-run roles (e.g. after an application crash).
 * Conservative: a role is acted on only when its name matches the DNAFix
 * temporary pattern, tags prove DNAFix ownership, no associated build is
 * active, and — for deletion — its quarantine deadline has passed.
 */
export interface TemporaryRoleInfo {
  roleName: string;
  arn: string;
  createdAt: string;
  tags: Record<string, string>;
}

export interface CleanupStateStore {
  load(): Promise<RoleCleanupRecord[]>;
  save(records: RoleCleanupRecord[]): Promise<void>;
}

export class MemoryCleanupStore implements CleanupStateStore {
  private records: RoleCleanupRecord[] = [];
  async load(): Promise<RoleCleanupRecord[]> {
    return structuredClone(this.records);
  }
  async save(records: RoleCleanupRecord[]): Promise<void> {
    this.records = structuredClone(records);
  }
}

/** JSON-file cleanup store (atomic replace). Survives process restarts. */
export class FileCleanupStore implements CleanupStateStore {
  constructor(private readonly filePath: string) {}
  async load(): Promise<RoleCleanupRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { records?: RoleCleanupRecord[] };
      return parsed.records ?? [];
    } catch {
      return [];
    }
  }
  async save(records: RoleCleanupRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify({ records }, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

/**
 * Single-host file lock. Prevents overlapping reaper executions on one host.
 * This does NOT provide distributed locking across hosts: deploy exactly one
 * reaper worker per environment (documented constraint, docs/AWS_EXECUTION.md).
 */
export class FileLock {
  constructor(
    private readonly lockPath: string,
    private readonly staleMs = 30 * 60 * 1000,
  ) {}
  async acquire(): Promise<boolean> {
    try {
      const handle = await open(this.lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch {
      try {
        const content = JSON.parse(await readFile(this.lockPath, "utf8")) as { at: string };
        if (Date.now() - Date.parse(content.at) > this.staleMs) {
          await unlink(this.lockPath).catch(() => undefined);
          return this.acquire();
        }
      } catch {
        /* unreadable lock: treat as held */
      }
      return false;
    }
  }
  async release(): Promise<void> {
    await unlink(this.lockPath).catch(() => undefined);
  }
}

export interface RoleReaperPorts {
  listTemporaryRoles(): Promise<TemporaryRoleInfo[]>;
  /** Role ARNs/names with a currently active (non-terminal) build. */
  activeRoleNames(): Promise<Set<string>>;
  manager: RunRoleManager;
  store: CleanupStateStore;
}

const TEMP_ROLE_PATTERN = /^dnafix-run-[a-zA-Z0-9][a-zA-Z0-9-_]*$/;

export function isReapableRole(role: TemporaryRoleInfo, nowMs: number, maxAgeMs: number, activeRoleNames: ReadonlySet<string>): { reapable: boolean; reason: string } {
  if (!TEMP_ROLE_PATTERN.test(role.roleName)) return { reapable: false, reason: "name does not match the DNAFix temporary role pattern" };
  if (role.tags.Project !== "DNAFix" || role.tags.Ephemeral !== "true") return { reapable: false, reason: "ownership tags missing or incorrect" };
  const age = nowMs - Date.parse(role.createdAt);
  if (Number.isNaN(age) || age < maxAgeMs) return { reapable: false, reason: `younger than the conservative age threshold (${maxAgeMs}ms)` };
  if (activeRoleNames.has(role.roleName)) return { reapable: false, reason: "an associated build is still active" };
  return { reapable: true, reason: "abandoned DNAFix temporary role" };
}

export interface ReconcileOutcome {
  roleName: string;
  action: "quarantined" | "deleted" | "skipped" | "failed";
  reason: string;
  record?: RoleCleanupRecord;
}

export class RoleReaper {
  constructor(
    private readonly ports: RoleReaperPorts,
    private readonly maxAgeMs = 24 * 60 * 60 * 1000,
    private readonly lock?: FileLock,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {}

  async reconcile(nowMs = Date.now()): Promise<ReconcileOutcome[]> {
    if (this.lock && !(await this.lock.acquire())) {
      this.log("[dnafix-reaper] skipped: another reaper execution holds the lock");
      return [];
    }
    try {
      return await this.reconcileLocked(nowMs);
    } finally {
      await this.lock?.release();
    }
  }

  private async reconcileLocked(nowMs: number): Promise<ReconcileOutcome[]> {
    const [roles, active, stored] = await Promise.all([this.ports.listTemporaryRoles(), this.ports.activeRoleNames(), this.ports.store.load()]);
    const byName = new Map(stored.map((r) => [r.roleName, r]));
    const outcomes: ReconcileOutcome[] = [];

    // Resume persisted records: delete only past deleteNotBefore; retry unresolved quarantines.
    for (const record of byName.values()) {
      if (record.lifecycleState === "DELETED") continue;
      if (active.has(record.roleName)) {
        outcomes.push({ roleName: record.roleName, action: "skipped", reason: "associated build still active", record });
        continue;
      }
      if (record.lifecycleState === "UNRESOLVED") {
        const retried = await this.ports.manager.retryCleanup(record, nowMs);
        outcomes.push({ roleName: record.roleName, action: retried.lifecycleState === "DELETED" ? "deleted" : "failed", reason: retried.lastError ?? "unresolved cleanup retried", record: retried });
      } else {
        const advanced = await this.ports.manager.deleteWhenSafe(record, nowMs);
        if (advanced.lifecycleState === "DELETED") outcomes.push({ roleName: record.roleName, action: "deleted", reason: "quarantine deadline passed", record: advanced });
      }
    }

    // Discover abandoned roles with no persisted record: quarantine them now (deletion happens in a later pass).
    for (const role of roles) {
      if (byName.has(role.roleName)) continue;
      const check = isReapableRole(role, nowMs, this.maxAgeMs, active);
      if (!check.reapable) {
        outcomes.push({ roleName: role.roleName, action: "skipped", reason: check.reason });
        continue;
      }
      const record = emptyCleanupRecord(role.roleName, role.roleName.replace(/^dnafix-run-/, ""));
      record.roleArn = role.arn;
      record.createdAt = role.createdAt;
      const quarantined = await this.ports.manager.quarantine(record);
      byName.set(role.roleName, quarantined);
      outcomes.push({
        roleName: role.roleName,
        action: quarantined.lifecycleState === "UNRESOLVED" ? "failed" : "quarantined",
        reason: quarantined.lastError ?? `quarantined; delete not before ${quarantined.deleteNotBefore}`,
        record: quarantined,
      });
    }

    await this.ports.store.save([...byName.values()]);
    for (const outcome of outcomes) {
      this.log(`[dnafix-reaper] ${outcome.roleName}: ${outcome.action} (${outcome.reason})`);
    }
    return outcomes;
  }
}

/** Real discovery: IAM roles by prefix + tags; active builds via CodeBuild project build list. */
export function createAwsReaperPorts(input: { region: string; projectName: string; manager: RunRoleManager; store: CleanupStateStore }): RoleReaperPorts {
  const iam = new IAMClient({ region: input.region });
  const codebuild = new CodeBuildClient({ region: input.region });
  return {
    manager: input.manager,
    store: input.store,
    listTemporaryRoles: async () => {
      const roles: TemporaryRoleInfo[] = [];
      let marker: string | undefined;
      do {
        const out = await iam.send(new ListRolesCommand({ Marker: marker, MaxItems: 100 }));
        for (const role of out.Roles ?? []) {
          if (!role.RoleName?.startsWith("dnafix-run-")) continue;
          const tags = await iam.send(new ListRoleTagsCommand({ RoleName: role.RoleName })).catch(() => ({ Tags: [] }));
          roles.push({
            roleName: role.RoleName,
            arn: role.Arn ?? "",
            createdAt: (role.CreateDate ?? new Date()).toISOString(),
            tags: Object.fromEntries((tags.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])),
          });
        }
        marker = out.IsTruncated ? out.Marker : undefined;
      } while (marker);
      return roles;
    },
    activeRoleNames: async () => {
      const active = new Set<string>();
      const list = await codebuild.send(new ListBuildsForProjectCommand({ projectName: input.projectName, sortOrder: "DESCENDING" }));
      const ids = (list.ids ?? []).slice(0, 50);
      if (ids.length === 0) return active;
      const builds = await codebuild.send(new BatchGetBuildsCommand({ ids }));
      for (const build of builds.builds ?? []) {
        const status: string = build.buildStatus ?? "";
        if (status === "IN_PROGRESS" || status === "QUEUED" || status === "SUBMITTED") {
          const roleName = (build.serviceRole ?? "").split("/").pop();
          if (roleName) active.add(roleName);
        }
      }
      return active;
    },
  };
}
