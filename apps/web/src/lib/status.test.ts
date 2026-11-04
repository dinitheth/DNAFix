import { describe, expect, it } from "vitest";
import type { ConfigStatus } from "./api";
import { blockingReasons, formatDuration, formatStarted, readinessItems, repositoryLabel, runStages } from "./status";

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
