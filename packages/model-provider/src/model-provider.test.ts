import { describe, expect, it } from "vitest";
import {
  BudgetedModelProvider,
  BudgetExceededError,
  MetaModelProvider,
  ModelBudget,
  ModelNotConfiguredError,
  ScriptedModelProvider,
  isMeterableModel,
  meterModel,
  modelBudgetLimitsFromEnv,
} from "./index.js";

const patchTask = {
  id: "t1",
  title: "t",
  description: "d",
  expectedOutcome: "o",
  fileScope: ["src/a.ts"],
  dependsOn: [] as string[],
  acceptanceCriteria: ["a"],
  testExpectations: [] as string[],
  retryLimit: 1,
};

function patchFetch(counter: { calls: number; bodies: Array<Record<string, unknown>> }, usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    counter.calls += 1;
    counter.bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ status: "completed", output_text: JSON.stringify({ summary: "s", operations: [{ type: "create", path: "src/a.ts", content: "x" }] }), usage }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("BudgetedModelProvider", () => {
  const limits = (over: Partial<{ maxCostUsd: number }> = {}) => ({
    maxCalls: 12,
    maxTotalTokens: 250_000,
    maxCostUsd: 3,
    maxOutputTokensPerRequest: 16384,
    pricing: { inputPerMillion: 4, outputPerMillion: 20 },
    ...over,
  });

  it("reserves budget, applies a dynamic output cap, and prices input+output", async () => {
    const counter = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    const budgeted = new BudgetedModelProvider(new MetaModelProvider({ apiKey: "k", fetchFn: patchFetch(counter) }), new ModelBudget(limits({ maxCostUsd: 0.05 })));
    await budgeted.generatePatch({ task: { ...patchTask }, issueTitle: "i", issueBody: "b", files: [] });
    expect(counter.calls).toBe(1);
    const cap = counter.bodies[0]?.max_output_tokens as number;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(16384); // dynamically reduced by the $0.05 ceiling
    // $0.05 ceiling: 16384 output tokens alone would cost $0.327 — the dynamic cap must keep spend bounded.
    expect(budgeted.estimatedCostUsd()).toBeLessThanOrEqual(0.05);
    expect(budgeted.calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });

  it("refuses the request before sending when remaining budget is insufficient", async () => {
    const counter = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    const budgeted = new BudgetedModelProvider(new MetaModelProvider({ apiKey: "k", fetchFn: patchFetch(counter) }), new ModelBudget(limits({ maxCostUsd: 0.0001 })));
    await expect(budgeted.generatePatch({ task: { ...patchTask }, issueTitle: "i", issueBody: "b", files: [] })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(counter.calls).toBe(0); // no request was sent
    expect(budgeted.budgetExceeded).toBe(true);
  });

  it("makes no additional request after budget exhaustion", async () => {
    const counter = { calls: 0, bodies: [] as Array<Record<string, unknown>> };
    const budgeted = new BudgetedModelProvider(
      new MetaModelProvider({ apiKey: "k", fetchFn: patchFetch(counter, { input_tokens: 100_000, output_tokens: 140_000, total_tokens: 240_000 }) }),
      new ModelBudget(limits({ maxCostUsd: 3 })),
    );
    // First call consumes $3.20 (100k in @ $4/1M = $0.40 + 140k out @ $20/1M = $2.80), breaching the ceiling on measured usage.
    await budgeted.generatePatch({ task: { ...patchTask }, issueTitle: "i", issueBody: "b", files: [] }).catch(() => undefined);
    const callsAfterFirst = counter.calls;
    await expect(budgeted.generatePatch({ task: { ...patchTask }, issueTitle: "i", issueBody: "b", files: [] })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it("retains usage from incomplete responses", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 500, output_tokens: 8192, total_tokens: 8692 } }),
        { status: 200 },
      )) as typeof fetch;
    const budgeted = new BudgetedModelProvider(new MetaModelProvider({ apiKey: "k", fetchFn }), new ModelBudget(limits()));
    await expect(budgeted.generatePatch({ task: { ...patchTask }, issueTitle: "i", issueBody: "b", files: [] })).rejects.toThrow(/max_output_tokens/);
    expect(budgeted.calls[0]).toMatchObject({ inputTokens: 500, outputTokens: 8192, totalTokens: 8692 });
    expect(budgeted.estimatedCostUsd()).toBeGreaterThan(0);
  });
});

describe("MetaModelProvider", () => {
  it("fails explicitly without MODEL_API_KEY instead of fabricating output", async () => {
    const provider = new MetaModelProvider({ apiKey: "" });
    expect(provider.configured).toBe(false);
    expect(provider.modelId).toBe("muse-wonder-1.0");
    await expect(
      provider.analyzeAndPlan({
        issueTitle: "t",
        issueBody: "b",
        baseCommitSha: "abc1234",
        repositorySnapshotId: "s",
        intelligence: {
          repositoryId: "r",
          baseCommitSha: "abc1234",
          analysisVersion: 1,
          analyzedAt: new Date().toISOString(),
          architecture: { layers: [], patterns: [], summary: "" },
          criticalComponents: [],
          risks: [],
          languages: [],
          files: [],
          targets: [],
          workingTree: null,
          complete: true,
          warnings: [],
        },
        fileExcerpts: [],
      }),
    ).rejects.toBeInstanceOf(ModelNotConfiguredError);
  });

  it("never silently downgrades the configured model id", () => {
    const provider = new MetaModelProvider({ apiKey: "k", model: "muse-wonder-1.0" });
    expect(provider.modelId).toBe("muse-wonder-1.0");
  });
});

describe("MetaModelProvider transport (mocked fetch, no network)", () => {
  it("sends Responses text.format json_schema and locally validates the output", async () => {
    const plan = {
      analysis: {
        summary: "s",
        problemDescription: "p",
        expectedBehavior: "e",
        requirements: ["r"],
        acceptanceCriteria: ["a"],
        ambiguities: [],
        assumptions: [],
        riskLevel: "low",
      },
      plan: {
        baseCommitSha: "abc1234",
        repositorySnapshotId: "s",
        steps: [{ id: "1", description: "d" }],
        tasks: [
          { id: "t1", title: "t", description: "d", expectedOutcome: "o", fileScope: ["src/a.ts"], dependsOn: [], acceptanceCriteria: ["a"], testExpectations: [], retryLimit: 1 },
        ],
        validationPlan: [],
        predictedAffectedPaths: [],
        unresolvedQuestions: [],
        requiresHumanClarification: false,
      },
      nominatedTargets: [],
    };
    let requestBody: Record<string, unknown> = {};
    const fetchFn = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.meta.ai/v1/responses");
      requestBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ id: "resp_1", status: "completed", model: "muse-wonder-1.0", output_text: JSON.stringify(plan), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const provider = new MetaModelProvider({ apiKey: "test-key", fetchFn });
    const out = await provider.analyzeAndPlan({
      issueTitle: "t",
      issueBody: "b",
      baseCommitSha: "abc1234",
      repositorySnapshotId: "s",
      intelligence: {
        repositoryId: "r",
        baseCommitSha: "abc1234",
        analysisVersion: 1,
        analyzedAt: new Date().toISOString(),
        architecture: { layers: [], patterns: [], summary: "" },
        criticalComponents: [],
        risks: [],
        languages: [],
        files: ["src/a.ts"],
        targets: [],
        workingTree: null,
        complete: true,
        warnings: [],
      },
      fileExcerpts: [],
    });
    expect(out.plan.tasks[0]?.id).toBe("t1");
    expect(provider.lastUsage?.totalTokens).toBe(15);
    const text = requestBody.text as { format: { type: string; name: string; schema: Record<string, unknown> } };
    expect(text.format.type).toBe("json_schema");
    expect(text.format.name).toBe("dnafix_plan");
    expect(text.format.schema.type).toBe("object");
    expect(requestBody.model).toBe("muse-wonder-1.0");
  });

  it("rejects model output that violates the contract schema", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ nope: true }) }), { status: 200 })) as typeof fetch;
    const provider = new MetaModelProvider({ apiKey: "k", fetchFn });
    await expect(
      provider.generatePatch({
        task: { id: "t1", title: "t", description: "d", expectedOutcome: "o", fileScope: ["src/a.ts"], dependsOn: [], acceptanceCriteria: ["a"], testExpectations: [], retryLimit: 1 },
        issueTitle: "i",
        issueBody: "b",
        files: [],
      }),
    ).rejects.toThrow();
  });

  it("reports incomplete responses (output-cap exhaustion) explicitly", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ status: "incomplete", output: [] }), { status: 200 })) as typeof fetch;
    const provider = new MetaModelProvider({ apiKey: "k", fetchFn, maxOutputTokens: 8192 });
    await expect(
      provider.generatePatch({
        task: { id: "t1", title: "t", description: "d", expectedOutcome: "o", fileScope: ["src/a.ts"], dependsOn: [], acceptanceCriteria: ["a"], testExpectations: [], retryLimit: 1 },
        issueTitle: "i",
        issueBody: "b",
        files: [],
      }),
    ).rejects.toThrow(/status=incomplete/);
  });

  it("sends the per-request output cap when configured", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ summary: "s", operations: [{ type: "create", path: "src/a.ts", content: "x" }] }) }), { status: 200 });
    }) as typeof fetch;
    const provider = new MetaModelProvider({ apiKey: "k", fetchFn, maxOutputTokens: 16384 });
    await provider.generatePatch({
      task: { id: "t1", title: "t", description: "d", expectedOutcome: "o", fileScope: ["src/a.ts"], dependsOn: [], acceptanceCriteria: ["a"], testExpectations: [], retryLimit: 1 },
      issueTitle: "i",
      issueBody: "b",
      files: [],
    });
    expect(body.max_output_tokens).toBe(16384);
  });

  it("surfaces HTTP errors instead of fabricating output", async () => {
    const fetchFn = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    const provider = new MetaModelProvider({ apiKey: "k", fetchFn });
    await expect(
      provider.reviewVerification({ issueTitle: "i", acceptanceCriteria: [], predictedPaths: [], changedPaths: [], diff: "", checks: [] }),
    ).rejects.toThrow(/429/);
  });
});

describe("ScriptedModelProvider (test double)", () => {
  it("validates scripted output against the contracts", async () => {
    const provider = new ScriptedModelProvider({
      plan: () => ({
        analysis: {
          summary: "s",
          problemDescription: "p",
          expectedBehavior: "e",
          requirements: ["r"],
          acceptanceCriteria: ["a"],
          ambiguities: [],
          assumptions: [],
          riskLevel: "low",
        },
        plan: {
          baseCommitSha: "abc1234",
          repositorySnapshotId: "s",
          steps: [{ id: "1", description: "d" }],
          tasks: [
            {
              id: "t1",
              title: "t",
              description: "d",
              expectedOutcome: "o",
              fileScope: ["src/a.ts"],
              dependsOn: [],
              acceptanceCriteria: ["a"],
              testExpectations: [],
              retryLimit: 1,
            },
          ],
          validationPlan: [],
          predictedAffectedPaths: [],
          unresolvedQuestions: [],
          requiresHumanClarification: false,
        },
        nominatedTargets: [],
      }),
      patch: () => ({ summary: "s", operations: [{ type: "create", path: "src/a.ts", content: "x" }] }),
    });
    expect(provider.name).toBe("scripted-test-double");
    const patch = await provider.generatePatch({
      task: {
        id: "t1",
        title: "t",
        description: "d",
        expectedOutcome: "o",
        fileScope: ["src/a.ts"],
        dependsOn: [],
        acceptanceCriteria: ["a"],
        testExpectations: [],
        retryLimit: 1,
      },
      issueTitle: "i",
      issueBody: "b",
      files: [],
    });
    expect(patch.operations).toHaveLength(1);
  });
});
