import { describe, expect, it } from "vitest";
import type { AuditEvent, ConfigStatus } from "./api";
import { blockingReasons, formatClock, formatDuration, formatSpan, formatStarted, readinessItems, repositoryLabel, runAttempts, runStages, stageOfAction, stageTimings } from "./status";

const config = (over: Partial<ConfigStatus> = {}): ConfigStatus => ({
  model: { provider: "meta-muse-wonder", modelId: "muse-wonder-1.0", subAgentModelId: "muse-spark-1.3", configured: true, transport: "responses", baseUrl: "https://api.meta.ai/v1" },
  projectDna: { configured: true, path: "vendor/Project-DNA" },
  github: { configured: false },
  sandboxMode: "host",
  execution: { provider: "local", remoteConfigured: false, project: null, bucket: null, region: "ap-southeast-2" },
  workflowEngine: "in-process-durable",
  temporalAddress: null,
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

const audit = (action: string, createdAt: string): AuditEvent => ({ id: `${action}-${createdAt}`, actor: "system", action, result: "ok", evidence: null, createdAt });

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

  it("reads stage starts from the recorded workflow transitions", () => {
    expect(stageOfAction("workflow.repository_preparation")).toBe("scanning");
    expect(stageOfAction("workflow.awaiting_plan_approval")).toBe("planning");
    expect(stageOfAction("workflow.agent_execution")).toBe("coding");
    expect(stageOfAction("workflow.completed")).toBe("review");
    expect(stageOfAction("workflow.blocked")).toBeNull();
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
});
