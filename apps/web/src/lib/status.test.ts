import { describe, expect, it } from "vitest";
import type { AuditEvent, ConfigStatus } from "./api";
import { blockingReasons, briefMessage, configurationSummary, decisionsWaiting, formatAgo, formatClock, formatDuration, formatSpan, formatStarted, lastStartedStage, readinessHref, readinessItems, repositoryLabel, runAttempts, runStages, stageOfAction, stageTimings, verificationCandidates } from "./status";

const config = (over: Partial<ConfigStatus> = {}): ConfigStatus => ({
  model: { provider: "meta-muse-wonder", modelId: "muse-wonder-1.0", subAgentModelId: "muse-spark-1.3", configured: true, transport: "responses", baseUrl: "https://api.meta.ai/v1" },
  projectDna: { configured: true, path: "vendor/Project-DNA" },
  github: { configured: false },
  sandboxMode: "host",
  execution: { provider: "local", remoteConfigured: false, project: null, bucket: null, region: "ap-southeast-2" },
  workflowEngine: "in-process-durable",
  temporalAddress: null,
  security: { bind: "127.0.0.1:3001", remoteBind: false, lanBindAllowed: false, sessionTokenRequired: false, repositoryRoots: [], webhookSecretConfigured: false, tokenEncryptionKeyConfigured: true, corsOrigin: "http://localhost:5173" },
  ...over,
});

describe("readiness mapping", () => {
  it("reports ready planner/DNA, optional GitHub, attention for host execution", () => {
    const items = readinessItems(config());
    expect(items.find((i) => i.id === "planner")?.tone).toBe("ready");
    expect(items.find((i) => i.id === "dna")?.tone).toBe("ready");
    expect(items.find((i) => i.id === "github")?.tone).toBe("optional");
    expect(items.find((i) => i.id === "execution")?.tone).toBe("attention");
    expect(blockingReasons(config())).toEqual([]);
  });

  it("blocks submission when planner or Project DNA is missing, with recovery text", () => {
    const broken = config({
      model: { provider: "meta-muse-wonder", modelId: "muse-wonder-1.0", subAgentModelId: "muse-spark-1.3", configured: false, transport: "responses", baseUrl: "https://api.meta.ai/v1" },
      projectDna: { configured: false, path: null },
    });
    const reasons = blockingReasons(broken);
    expect(reasons).toHaveLength(2);
    expect(reasons.join(" ")).toMatch(/MODEL_API_KEY/);
    expect(reasons.join(" ")).toMatch(/PROJECT_DNA_PATH/);
  });

  it("never reports ready for a misconfigured cloud provider", () => {
    const items = readinessItems(config({ execution: { provider: "codebuild", remoteConfigured: false, project: null, bucket: null, region: "ap-southeast-2" } }));
    expect(items.find((i) => i.id === "execution")?.tone).toBe("blocked");
  });
});

describe("run stage timeline", () => {
  it("maps planning approval to requires-approval with earlier stages completed", () => {
    const stages = runStages({ state: "AWAITING_PLAN_APPROVAL" });
    expect(stages.map((s) => s.status)).toEqual(["completed", "completed", "requires-approval", "pending", "pending", "pending"]);
  });

  it("marks every stage completed for COMPLETED and the current stage blocked for BLOCKED", () => {
    expect(runStages({ state: "COMPLETED" }).every((s) => s.status === "completed")).toBe(true);
    const blocked = runStages({ state: "BLOCKED" });
    expect(blocked.some((s) => s.status === "blocked")).toBe(true);
    expect(blocked.filter((s) => s.status === "completed").length).toBeLessThan(6);
  });

  it("uses no percentages and covers exactly the six product stages", () => {
    expect(runStages({ state: "QUEUED" }).map((s) => s.id)).toEqual(["scanning", "dna", "planning", "coding", "verification", "review"]);
  });
});

const audit = (action: string, createdAt: string, result: AuditEvent["result"] = "ok", evidence: string | null = null): AuditEvent => ({
  id: `${action}-${createdAt}`,
  actor: "system",
  action,
  result,
  evidence,
  createdAt,
});

describe("stage timings from the audit log", () => {
  it("times each stage between its own events and the next stage's first later event", () => {
    const timings = stageTimings(
      [
        audit("repository.cloned", "2026-01-01T00:00:00Z"),
        audit("verification.baseline", "2026-01-01T00:00:10Z"),
        audit("project-dna.analysis", "2026-01-01T00:00:20Z"),
        audit("plan.created", "2026-01-01T00:01:00Z"),
        audit("task.t1.completed", "2026-01-01T00:05:00Z"),
      ],
      { state: "AGENT_EXECUTION", updatedAt: "2026-01-01T00:05:00Z" },
    );
    expect(timings.scanning).toMatchObject({ startedAt: "2026-01-01T00:00:00.000Z", durationMs: 20_000, events: 2 });
    expect(timings.dna.durationMs).toBe(40_000);
    expect(timings.planning.durationMs).toBe(240_000);
    expect(timings.coding.startedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(timings.coding.durationMs).toBeNull();
    expect(timings.review.startedAt).toBeNull();
    expect(timings.scanning.evidence).toMatchObject({ action: "verification.baseline" });
  });

  it("ends the stage that was in progress when the run stopped", () => {
    const timings = stageTimings([audit("verification.completed", "2026-01-01T00:02:00Z")], { state: "BLOCKED", updatedAt: "2026-01-01T00:03:00Z" });
    expect(timings.verification.durationMs).toBe(60_000);
    expect(timings.coding.startedAt).toBeNull();
  });

  it("keeps a stage open across a repair loop instead of ending at the first downstream event", () => {
    const timings = stageTimings(
      [
        audit("task.t1.completed", "2026-01-01T00:01:00Z"),
        audit("verification.completed", "2026-01-01T00:02:00Z"),
        audit("repair.attempt", "2026-01-01T00:03:00Z"),
        audit("task.t1.completed", "2026-01-01T00:04:00Z"),
        audit("verification.completed", "2026-01-01T00:06:00Z"),
      ],
      { state: "FINAL_VERIFICATION", updatedAt: "2026-01-01T00:06:00Z" },
    );
    expect(timings.coding.durationMs).toBe(300_000);
    expect(timings.verification.startedAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("invents nothing for actions outside the pipeline vocabulary", () => {
    expect(stageOfAction("mcp.docker.list_containers")).toBeNull();
    expect(stageOfAction("repository.cloned")).toBe("scanning");
    expect(stageOfAction("execution.codebuild.baseline")).toBe("scanning");
    expect(stageOfAction("execution.codebuild.final")).toBe("verification");
    expect(stageOfAction("pull-request.created")).toBe("review");
    const empty = stageTimings([], { state: "AGENT_EXECUTION", updatedAt: "2026-01-01T00:00:00Z" });
    expect(Object.values(empty).every((t) => t.startedAt === null && t.durationMs === null)).toBe(true);
    expect(formatClock(null)).toBe("—");
    expect(formatSpan(null)).toBe("");
    expect(formatSpan(65_000)).toBe("1m 5s");
    expect(formatSpan(925)).toBe("925ms");
  });

  it("anchors evidence on the failing audit record and keeps its detail", () => {
    const timings = stageTimings(
      [
        audit("workflow.project_dna_analysis", "2026-01-01T00:00:00Z"),
        audit("project-dna.analysis", "2026-01-01T00:00:09Z", "error", "snapshot=s1 complete=false"),
      ],
      { state: "IMPACT_ANALYSIS", updatedAt: "2026-01-01T00:00:09Z" },
    );
    expect(timings.dna.evidence).toMatchObject({ action: "project-dna.analysis", result: "error", detail: "snapshot=s1 complete=false" });
    expect(timings.dna.events).toBe(2);
  });

  it("reads stage starts from the recorded workflow transitions", () => {
    expect(stageOfAction("workflow.repository_preparation")).toBe("scanning");
    expect(stageOfAction("workflow.awaiting_plan_approval")).toBe("planning");
    expect(stageOfAction("workflow.agent_execution")).toBe("coding");
    expect(stageOfAction("workflow.completed")).toBe("review");
    expect(stageOfAction("workflow.blocked")).toBeNull();
  });

  it("places a stage-less blocked outcome on the stage the audit trail last recorded", () => {
    const events = [
      audit("workflow.repository_preparation", "2026-01-01T00:00:00Z"),
      audit("verification.baseline", "2026-01-01T00:00:02Z"),
      audit("workflow.project_dna_analysis", "2026-01-01T00:00:05Z"),
    ];
    const timings = stageTimings(events, { state: "BLOCKED", updatedAt: "2026-01-01T00:00:06Z" });
    expect(lastStartedStage(timings)).toBe("dna");
    expect(runStages({ state: "BLOCKED" }, lastStartedStage(timings)).map((s) => s.status)).toEqual([
      "completed",
      "blocked",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("times only the current attempt when a run was blocked and resumed", () => {
    const events = [
      audit("run.created", "2026-01-01T00:00:00Z"),
      audit("workflow.repository_preparation", "2026-01-01T00:00:01Z"),
      audit("workflow.project_dna_analysis", "2026-01-01T00:00:04Z"),
      audit("run.blocked", "2026-01-01T00:00:05Z"),
      audit("workflow.queued", "2026-01-01T02:00:00Z"),
      audit("run.resumed", "2026-01-01T02:00:01Z"),
      audit("workflow.repository_preparation", "2026-01-01T02:00:02Z"),
      audit("workflow.project_dna_analysis", "2026-01-01T02:00:03Z"),
    ];
    const timings = stageTimings(events, { state: "BLOCKED", updatedAt: "2026-01-01T02:00:04Z" });
    expect(runAttempts(events)).toBe(2);
    expect(timings.scanning.startedAt).toBe("2026-01-01T02:00:02.000Z");
    expect(timings.scanning.durationMs).toBe(1000);
    expect(timings.dna.durationMs).toBe(1000);
    expect(timings.coding.startedAt).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("formats durations compactly", () => {
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:45Z")).toBe("45s");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:11:05Z")).toBe("11m 5s");
  });

  it("renders a compact start stamp and a dash instead of Invalid Date", () => {
    expect(formatStarted("2026-01-01T00:00:45Z")).toMatch(/^Jan 1 \d{2}:\d{2}$/);
    expect(formatStarted("not a date")).toBe("—");
  });

  it("labels repositories by GitHub name or last two path segments", () => {
    expect(repositoryLabel({ repositoryPath: "x" }, [{ id: "gh", localPath: null, githubOwner: "acme", githubRepo: "api" }], "gh")).toBe("acme/api");
    expect(repositoryLabel({ repositoryPath: "G:\\work\\acme\\api" }, [], "local_1")).toBe("acme/api");
  });

  it("keeps only the first sentence of a long blocker for summary surfaces", () => {
    const long = "PROJECT_DNA_PATH is not set. Clone the repo, install it, then set the variable. DNAFix does not fabricate repository analysis.";
    expect(briefMessage(long)).toBe("PROJECT_DNA_PATH is not set.");
    expect(briefMessage("Single sentence with no trailing stop")).toBe("Single sentence with no trailing stop");
    expect(briefMessage(`.${"x".repeat(300)}`)).toHaveLength(180);
  });

  it("says how old a recorded timestamp is instead of showing a raw clock", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(formatAgo("2026-01-01T11:59:55Z", now)).toBe("just now");
    expect(formatAgo("2026-01-01T11:59:00Z", now)).toBe("1m ago");
    expect(formatAgo("2026-01-01T09:00:00Z", now)).toBe("3h ago");
    expect(formatAgo("2025-12-29T12:00:00Z", now)).toBe("3d ago");
    expect(formatAgo("2026-01-01T13:00:00Z", now)).toBe("just now");
    expect(formatAgo("not a date", now)).toBe("—");
  });
});

describe("decision queues", () => {
  const check = { id: "test", kind: "command", status: "failed", result: null };

  it("asks the server for a verdict only on runs that recorded checks and are not finished", () => {
    const runs = [
      { id: "a", state: "FINAL_VERIFICATION", verificationChecks: [check] },
      { id: "b", state: "COMPLETED", verificationChecks: [check] },
      { id: "c", state: "AGENT_EXECUTION", verificationChecks: null },
      { id: "d", state: "BLOCKED", verificationChecks: [] },
    ];
    expect(verificationCandidates(runs).map((r) => r.id)).toEqual(["a"]);
  });

  it("caps how many verdicts one page asks for at a time", () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({ id: `r${index}`, state: "FINAL_VERIFICATION", verificationChecks: [check] }));
    expect(verificationCandidates(runs)).toHaveLength(12);
  });

  it("counts paused runs, verdicts needing a human and open MCP requests together", () => {
    const runs = [
      { state: "AWAITING_PLAN_APPROVAL" },
      { state: "NEEDS_CLARIFICATION" },
      { state: "AWAITING_PR_APPROVAL" },
      { state: "AGENT_EXECUTION" },
      { state: "COMPLETED" },
    ];
    expect(decisionsWaiting(runs, 0, 0)).toBe(3);
    expect(decisionsWaiting(runs, 2, 1)).toBe(6);
    expect(decisionsWaiting([], 0, 0)).toBe(0);
  });

  it("points each readiness item at the surface that can fix it", () => {
    expect(readinessHref("dna")).toBe("/settings#dna");
    expect(readinessHref("github")).toBe("/connectors/github");
    expect(readinessHref("unknown")).toBe("/settings");
  });
});

describe("configuration summary", () => {
  const github = {
    configured: true,
    connected: true,
    account: { id: 1, login: "dinitheth", name: null, avatarUrl: null, htmlUrl: "https://github.com/dinitheth" },
    installation: { id: 42, accountLogin: "dinitheth", accountType: "User" },
  };
  const mcp = { state: "connected" as const, serverCount: 3, toolCount: 40, enabledToolCount: 12 };

  it("reports the resolved values an operator would be asked for", () => {
    const text = configurationSummary(config(), github, mcp, new Date("2026-11-05T00:00:00.000Z"));
    expect(text).toContain("DNAFix configuration 2026-11-05T00:00:00.000Z");
    expect(text).toContain("lead=muse-wonder-1.0 sub=muse-spark-1.3");
    expect(text).toContain("project-dna: vendor/Project-DNA");
    expect(text).toContain("bind=127.0.0.1:3001 auth=loopback-only");
    expect(text).toContain("account=dinitheth installation=42");
    expect(text).toContain("state=connected servers=3 tools=40 enabled=12");
  });

  it("reports secret presence only, never a secret value", () => {
    const text = configurationSummary(config(), null, null);
    expect(text).toContain("key=present");
    expect(text).toContain("token-encryption=present");
    expect(text).toContain("webhook-secret=missing");
    expect(text).toContain("connection=none");
    expect(text).toContain("status unavailable");
    expect(text).not.toMatch(/Bearer|PRIVATE KEY|BEGIN /);
  });

  it("carries cloud execution detail only when the provider is codebuild", () => {
    const local = configurationSummary(config(), null, null);
    expect(local).not.toContain("region=");
    const cloud = configurationSummary(
      config({ execution: { provider: "codebuild", remoteConfigured: true, project: "dnafix-build", bucket: "dnafix-artifacts", region: "ap-southeast-2" } }),
      null,
      null,
    );
    expect(cloud).toContain("project=dnafix-build bucket=dnafix-artifacts region=ap-southeast-2");
  });
});
