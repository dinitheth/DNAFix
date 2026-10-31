import { CreateRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, IAMClient, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";

/**
 * Per-run scoped execution roles — hardened lifecycle (Phase 2).
 *
 * Threat model: CodeBuild runs untrusted repository scripts, which can extract
 * the build environment's role credentials. Mitigations:
 *  - Permissions scoped to exactly one run's S3 prefixes (this file).
 *  - Trust restricted to the CodeBuild service for one account + one project.
 *  - Explicit session revocation (aws:TokenIssueTime deny) BEFORE role deletion.
 *
 * AWS semantics (documented, not assumed): deleting a role prevents new
 * assumptions but is NOT, by itself, a verified revocation of sessions already
 * issued. The supported revocation mechanism is a deny conditioned on
 * aws:TokenIssueTime ("revoke old sessions"). DNAFix therefore applies that
 * deny, waits for IAM propagation, and only then deletes the role — and it
 * records revocation as "applied, not independently confirmed", never as a
 * mathematically instant guarantee. If revocation cannot be applied, the role
 * is preserved for retry and the run is left in an unresolved containment
 * state instead of being silently deleted and reported as revoked.
 */

export const TRUST_POLICY_VERSION = "v2-source-restricted";
export const RUN_POLICY_NAME = "dnafix-run-scoped";
export const REVOCATION_POLICY_NAME = "dnafix-revoke-sessions";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,127}$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/;
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,254}$/;

export function assertValidRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid runId for IAM generation: ${JSON.stringify(runId)}`);
  return runId;
}

export function runRoleName(runId: string): string {
  assertValidRunId(runId);
  const sanitized = runId.replaceAll(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);
  return `dnafix-run-${sanitized}`.slice(0, 64);
}

export function codeBuildProjectArn(input: { region: string; accountId: string; projectName: string }): string {
  if (!ACCOUNT_ID_PATTERN.test(input.accountId)) throw new Error(`Invalid AWS account ID: ${JSON.stringify(input.accountId)}`);
  if (!REGION_PATTERN.test(input.region)) throw new Error(`Invalid AWS region: ${JSON.stringify(input.region)}`);
  if (!PROJECT_NAME_PATTERN.test(input.projectName)) throw new Error(`Invalid CodeBuild project name: ${JSON.stringify(input.projectName)}`);
  return `arn:aws:codebuild:${input.region}:${input.accountId}:project/${input.projectName}`;
}

/** Restricted trust: only CodeBuild, only this account, only this project. Values come from trusted config, never repository input. */
export function buildTrustPolicy(input: { region: string; accountId: string; projectName: string }): Record<string, unknown> {
  const projectArn = codeBuildProjectArn(input);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CodeBuildProjectOnly",
        Effect: "Allow",
        Principal: { Service: "codebuild.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: {
            "aws:SourceAccount": input.accountId,
            "aws:SourceArn": projectArn,
          },
        },
      },
    ],
  };
}

export function buildRunRolePolicy(input: { bucket: string; region: string; accountId: string; logGroupName: string; runId: string }): Record<string, unknown> {
  assertValidRunId(input.runId);
  const prefix = `runs/${input.runId}`;
  const logGroupArn = `arn:aws:logs:${input.region}:${input.accountId}:log-group:${input.logGroupName}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RunSourceReadOnly",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: [`arn:aws:s3:::${input.bucket}/${prefix}/source.zip`, `arn:aws:s3:::${input.bucket}/${prefix}/manifest.json`],
      },
      {
        Sid: "RunArtifactsWrite",
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject"],
        Resource: `arn:aws:s3:::${input.bucket}/${prefix}/artifacts/*`,
      },
      {
        Sid: "RunListBucketScoped",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:GetBucketLocation"],
        Resource: `arn:aws:s3:::${input.bucket}`,
        Condition: { StringLike: { "s3:prefix": ["", "runs/", `${prefix}/`, `${prefix}/*`] } },
      },
      {
        Sid: "RunLogs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: [logGroupArn, `${logGroupArn}:*`],
      },
    ],
  };
}

/**
 * Session-revocation deny: sessions issued before `revokedBefore` are denied.
 * Applied as a separate inline policy so it can be put in place (and left in
 * place on retry) independently of the permissions policy.
 */
export function buildRevocationPolicy(revokedBeforeIso: string): Record<string, unknown> {
  if (Number.isNaN(Date.parse(revokedBeforeIso))) throw new Error(`Invalid revocation timestamp: ${revokedBeforeIso}`);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenySessionsIssuedBeforeRevocation",
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: { DateLessThan: { "aws:TokenIssueTime": revokedBeforeIso } },
      },
    ],
  };
}

export type ContainmentStatus = "contained" | "revocation-applied-deletion-pending" | "unresolved";

/**
 * Persistent quarantine lifecycle for temporary roles.
 * ACTIVE → QUARANTINING → QUARANTINED → WAITING_FOR_SESSION_EXPIRY →
 * SAFE_TO_DELETE → DELETED, with UNRESOLVED for any failed containment step.
 * A role is never deleted before deleteNotBefore (= quarantinedAt +
 * MaxSessionDuration + propagation grace). Deny policies stay active for the
 * whole quarantine. This distinguishes permission denial (immediate once
 * propagated) from temporary-credential expiration (only at session expiry).
 */
export type RoleLifecycleState = "ACTIVE" | "QUARANTINING" | "QUARANTINED" | "WAITING_FOR_SESSION_EXPIRY" | "SAFE_TO_DELETE" | "DELETED" | "UNRESOLVED";

export interface LifecycleOperation {
  op: string;
  at: string;
  result: "ok" | "error" | "skipped";
  error: string | null;
}

export interface RoleCleanupRecord {
  roleName: string;
  roleArn: string | null;
  runId: string;
  trustPolicyVersion: string;
  createdAt: string | null;
  lifecycleState: RoleLifecycleState;
  quarantinedAt: string | null;
  maxSessionDurationSeconds: number;
  deleteNotBefore: string | null;
  denyAllApplied: boolean;
  operations: LifecycleOperation[];
  revocation: {
    requestedAt: string | null;
    policyApplied: boolean;
    /** Revocation is recorded as applied-not-independently-confirmed; AWS provides no synchronous confirmation API. */
    confirmationStatus: "not-requested" | "applied-unconfirmed" | "failed";
    error: string | null;
  };
  deletion: { attempted: boolean; deleted: boolean; error: string | null };
  cleanupAttempts: number;
  lastError: string | null;
  containmentStatus: ContainmentStatus;
}

export const DEFAULT_MAX_SESSION_DURATION_SECONDS = 3600;
export const DEFAULT_PROPAGATION_GRACE_MS = 15 * 60 * 1000;

export function computeDeleteNotBefore(quarantinedAtIso: string, maxSessionDurationSeconds: number, graceMs: number): string {
  return new Date(Date.parse(quarantinedAtIso) + maxSessionDurationSeconds * 1000 + graceMs).toISOString();
}

/** Deny-all permissions policy: while applied, every API call with the role's credentials is denied. */
export function buildDenyAllPolicy(): Record<string, unknown> {
  return { Version: "2012-10-17", Statement: [{ Sid: "QuarantineDenyAll", Effect: "Deny", Action: "*", Resource: "*" }] };
}

/** Deny-assume trust policy: prevents any new assumption of the role. */
export function buildDenyAssumeTrustPolicy(): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [{ Sid: "QuarantineDenyAssume", Effect: "Deny", Principal: "*", Action: "sts:AssumeRole" }],
  };
}

export const QUARANTINE_POLICY_NAME = "dnafix-quarantine-deny-all";

export function emptyCleanupRecord(roleName: string, runId: string): RoleCleanupRecord {
  return {
    roleName,
    roleArn: null,
    runId,
    trustPolicyVersion: TRUST_POLICY_VERSION,
    createdAt: null,
    lifecycleState: "ACTIVE",
    quarantinedAt: null,
    maxSessionDurationSeconds: DEFAULT_MAX_SESSION_DURATION_SECONDS,
    deleteNotBefore: null,
    denyAllApplied: false,
    operations: [],
    revocation: { requestedAt: null, policyApplied: false, confirmationStatus: "not-requested", error: null },
    deletion: { attempted: false, deleted: false, error: null },
    cleanupAttempts: 0,
    lastError: null,
    containmentStatus: "unresolved",
  };
}

export interface IamOperations {
  createRole(input: { roleName: string; trustPolicy: Record<string, unknown>; policyName: string; policy: Record<string, unknown>; maxSessionDurationSeconds?: number }): Promise<{ arn: string }>;
  putPolicy(input: { roleName: string; policyName: string; policy: Record<string, unknown> }): Promise<void>;
  updateTrustPolicy(input: { roleName: string; trustPolicy: Record<string, unknown> }): Promise<void>;
  deleteRole(roleName: string, policyNames: string[]): Promise<void>;
}

export class SdkIamOperations implements IamOperations {
  constructor(private readonly client: IAMClient) {}
  async createRole(input: { roleName: string; trustPolicy: Record<string, unknown>; policyName: string; policy: Record<string, unknown>; maxSessionDurationSeconds?: number }): Promise<{ arn: string }> {
    const out = await this.client.send(
      new CreateRoleCommand({
        RoleName: input.roleName,
        AssumeRolePolicyDocument: JSON.stringify(input.trustPolicy),
        Description: "DNAFix per-run CodeBuild execution role (short-lived, run-scoped)",
        MaxSessionDuration: input.maxSessionDurationSeconds ?? DEFAULT_MAX_SESSION_DURATION_SECONDS,
        Tags: [
          { Key: "Project", Value: "DNAFix" },
          { Key: "Ephemeral", Value: "true" },
        ],
      }),
    );
    if (!out.Role?.Arn) {
      // Compensating cleanup for a partially-created role.
      await this.deleteRole(input.roleName, [input.policyName]).catch(() => undefined);
      throw new Error(`CreateRole for ${input.roleName} returned no ARN (compensating delete attempted)`);
    }
    try {
      await this.putPolicy({ roleName: input.roleName, policyName: input.policyName, policy: input.policy });
    } catch (err) {
      // CreateRole succeeded but policy attachment failed: delete the bare role
      // so a policy-less (or partially provisioned) role never lingers.
      await this.deleteRole(input.roleName, [input.policyName]).catch(() => undefined);
      throw new Error(`PutRolePolicy for ${input.roleName} failed; compensating role deletion attempted: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { arn: out.Role.Arn };
  }
  async putPolicy(input: { roleName: string; policyName: string; policy: Record<string, unknown> }): Promise<void> {
    await this.client.send(new PutRolePolicyCommand({ RoleName: input.roleName, PolicyName: input.policyName, PolicyDocument: JSON.stringify(input.policy) }));
  }
  async updateTrustPolicy(input: { roleName: string; trustPolicy: Record<string, unknown> }): Promise<void> {
    await this.client.send(new UpdateAssumeRolePolicyCommand({ RoleName: input.roleName, PolicyDocument: JSON.stringify(input.trustPolicy) }));
  }
  async deleteRole(roleName: string, policyNames: string[]): Promise<void> {
    for (const policyName of policyNames) {
      await this.client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName })).catch(() => undefined);
    }
    await this.client.send(new DeleteRoleCommand({ RoleName: roleName }));
  }
}

const sleepDefault = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RunRoleManagerOptions {
  maxSessionDurationSeconds?: number;
  propagationGraceMs?: number;
}

export class RunRoleManager {
  private readonly maxSessionDurationSeconds: number;
  private readonly propagationGraceMs: number;
  constructor(
    private readonly iam: IamOperations,
    private readonly scope: { bucket: string; region: string; accountId: string; logGroupName: string; projectName: string },
    private readonly propagationDelayMs = 8_000,
    private readonly sleepFn: (ms: number) => Promise<void> = sleepDefault,
    options: RunRoleManagerOptions = {},
  ) {
    this.maxSessionDurationSeconds = options.maxSessionDurationSeconds ?? DEFAULT_MAX_SESSION_DURATION_SECONDS;
    this.propagationGraceMs = options.propagationGraceMs ?? DEFAULT_PROPAGATION_GRACE_MS;
  }

  /** Roles whose cleanup/revocation is incomplete in this process; reuse is refused until resolved. */
  private readonly unresolved = new Map<string, RoleCleanupRecord>();

  unresolvedCleanups(): RoleCleanupRecord[] {
    return [...this.unresolved.values()];
  }

  private op(record: RoleCleanupRecord, op: string, result: "ok" | "error" | "skipped", error: string | null = null): void {
    record.operations.push({ op, at: new Date().toISOString(), result, error });
  }

  async createRunRole(runId: string): Promise<{ roleName: string; arn: string; record: RoleCleanupRecord }> {
    assertValidRunId(runId);
    const roleName = runRoleName(runId);
    if (this.unresolved.has(roleName)) {
      throw new Error(`Refusing to reuse role ${roleName}: a previous cleanup/revocation for this role is unresolved. Resolve containment before re-execution.`);
    }
    const record = emptyCleanupRecord(roleName, runId);
    record.maxSessionDurationSeconds = this.maxSessionDurationSeconds;
    const { arn } = await this.iam.createRole({
      roleName,
      trustPolicy: buildTrustPolicy({ region: this.scope.region, accountId: this.scope.accountId, projectName: this.scope.projectName }),
      policyName: RUN_POLICY_NAME,
      policy: buildRunRolePolicy({ ...this.scope, runId }),
      maxSessionDurationSeconds: this.maxSessionDurationSeconds,
    });
    record.roleArn = arn;
    record.createdAt = new Date().toISOString();
    record.lifecycleState = "ACTIVE";
    this.op(record, "create-role", "ok");
    if (this.propagationDelayMs > 0) await this.sleepFn(this.propagationDelayMs);
    return { roleName, arn, record };
  }

  /**
   * Quarantine (idempotent). Order:
   * 1. Replace trust with deny-assume (no new sessions can start).
   * 2. Apply deny-all permissions policy (existing sessions lose all access once propagated).
   * 3. Apply TokenIssueTime revocation deny (sessions issued before now are denied).
   * Any failure → UNRESOLVED, role preserved for reaper retry. On success the
   * role is QUARANTINED and deleteNotBefore = quarantinedAt + MaxSessionDuration
   * + propagation grace. The role is RETAINED until that deadline.
   */
  async quarantine(record: RoleCleanupRecord): Promise<RoleCleanupRecord> {
    if (record.lifecycleState === "DELETED") return record;
    if (record.lifecycleState === "QUARANTINED" || record.lifecycleState === "WAITING_FOR_SESSION_EXPIRY" || record.lifecycleState === "SAFE_TO_DELETE") {
      this.advanceState(record, Date.now());
      return record;
    }
    record.cleanupAttempts += 1;
    record.lifecycleState = "QUARANTINING";
    const steps: Array<{ op: string; run: () => Promise<void>; apply: () => void }> = [
      {
        op: "deny-new-assumptions",
        run: () => this.iam.updateTrustPolicy({ roleName: record.roleName, trustPolicy: buildDenyAssumeTrustPolicy() }),
        apply: () => undefined,
      },
      {
        op: "apply-deny-all",
        run: () => this.iam.putPolicy({ roleName: record.roleName, policyName: QUARANTINE_POLICY_NAME, policy: buildDenyAllPolicy() }),
        apply: () => {
          record.denyAllApplied = true;
        },
      },
      {
        op: "apply-session-revocation",
        run: () => this.iam.putPolicy({ roleName: record.roleName, policyName: REVOCATION_POLICY_NAME, policy: buildRevocationPolicy(record.revocation.requestedAt!) }),
        apply: () => {
          record.revocation.policyApplied = true;
          record.revocation.confirmationStatus = "applied-unconfirmed";
          record.revocation.error = null;
        },
      },
    ];
    record.revocation.requestedAt = new Date().toISOString();
    for (const step of steps) {
      try {
        await step.run();
        step.apply();
        this.op(record, step.op, "ok");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.op(record, step.op, "error", message);
        if (step.op === "apply-session-revocation") {
          record.revocation.policyApplied = false;
          record.revocation.confirmationStatus = "failed";
          record.revocation.error = message;
        }
        record.lastError = message;
        record.lifecycleState = "UNRESOLVED";
        record.containmentStatus = "unresolved";
        this.unresolved.set(record.roleName, record);
        return record;
      }
    }
    if (this.propagationDelayMs > 0) await this.sleepFn(this.propagationDelayMs);
    record.quarantinedAt = new Date().toISOString();
    record.deleteNotBefore = computeDeleteNotBefore(record.quarantinedAt, record.maxSessionDurationSeconds, this.propagationGraceMs);
    record.lifecycleState = "WAITING_FOR_SESSION_EXPIRY";
    record.containmentStatus = "revocation-applied-deletion-pending";
    this.op(record, "quarantined", "ok");
    this.unresolved.set(record.roleName, record);
    return record;
  }

  advanceState(record: RoleCleanupRecord, nowMs: number): RoleCleanupRecord {
    if ((record.lifecycleState === "QUARANTINED" || record.lifecycleState === "WAITING_FOR_SESSION_EXPIRY") && record.deleteNotBefore && nowMs >= Date.parse(record.deleteNotBefore)) {
      record.lifecycleState = "SAFE_TO_DELETE";
    }
    return record;
  }

  /** Delete only at/after deleteNotBefore. Early calls are recorded and refused. */
  async deleteWhenSafe(record: RoleCleanupRecord, nowMs = Date.now()): Promise<RoleCleanupRecord> {
    if (record.lifecycleState === "DELETED") return record;
    this.advanceState(record, nowMs);
    if (record.lifecycleState !== "SAFE_TO_DELETE") {
      this.op(record, "delete-role", "skipped", `not safe to delete before ${record.deleteNotBefore ?? "quarantine"}`);
      return record;
    }
    record.deletion.attempted = true;
    try {
      await this.iam.deleteRole(record.roleName, [RUN_POLICY_NAME, REVOCATION_POLICY_NAME, QUARANTINE_POLICY_NAME]);
      record.deletion.deleted = true;
      record.deletion.error = null;
      record.lifecycleState = "DELETED";
      record.containmentStatus = "contained";
      this.op(record, "delete-role", "ok");
      this.unresolved.delete(record.roleName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.deletion.deleted = false;
      record.deletion.error = message;
      record.lastError = message;
      record.lifecycleState = "UNRESOLVED";
      record.containmentStatus = "unresolved";
      this.op(record, "delete-role", "error", message);
      this.unresolved.set(record.roleName, record);
    }
    return record;
  }

  /** Full containment: quarantine now; delete only when the session-expiry deadline has passed. */
  async revokeAndDelete(record: RoleCleanupRecord, nowMs = Date.now()): Promise<RoleCleanupRecord> {
    await this.quarantine(record);
    if (record.lifecycleState === "UNRESOLVED") return record;
    // Evaluate the deadline with a fresh timestamp taken after quarantine
    // (quarantinedAt is set during quarantine; a stale nowMs would race it).
    return this.deleteWhenSafe(record, Math.max(nowMs, Date.now()));
  }

  /** Retry a previously unresolved cleanup (idempotent: safe to call repeatedly). */
  async retryCleanup(record: RoleCleanupRecord, nowMs = Date.now()): Promise<RoleCleanupRecord> {
    if (record.lifecycleState === "UNRESOLVED") record.lifecycleState = "ACTIVE";
    return this.revokeAndDelete(record, nowMs);
  }
}
