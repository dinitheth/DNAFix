import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodingAgent, VerificationAgent, type McpAgentToolLike, type McpToolRuntimeLike } from "./index.js";
import type {
  PatchInput,
  ReviewInput,
  ToolCallingModelProvider,
  ToolLoopOptions,
  ToolLoopResult,
} from "@dnafix/model-provider";

const L1_TOOL: McpAgentToolLike = {
  modelName: "mcp_docker_list_containers_12345678",
  serverName: "docker",
  toolName: "list_containers",
  description: "List Docker containers",
  inputSchema: { type: "object", properties: { all: { type: "boolean" } } },
  permissionLevel: 1,
  reviewed: true,
};

function loopResult(overrides: Partial<ToolLoopResult> = {}): ToolLoopResult {
  return {
    text: "evidence gathered",
    context: "[mcp_docker_list_containers_12345678] ok: 2 containers",
    calls: [
      {
        name: L1_TOOL.modelName,
        callId: "call_1",
        argumentsJson: '{"all":true}',
        executed: true,
        isError: false,
        summary: "2 containers",
      },
    ],
    rounds: 1,
    incomplete: false,
    incompleteReason: null,
    skippedTools: [],
    usage: {},
    ...overrides,
  };
}

function fakeRuntime(tools: McpAgentToolLike[] = [L1_TOOL]): McpToolRuntimeLike & {
  toolsForAgent: ReturnType<typeof vi.fn>;
  executeToolCall: ReturnType<typeof vi.fn>;
} {
  return {
    toolsForAgent: vi.fn(async () => tools),
    executeToolCall: vi.fn(async () => ({ text: "BEGIN UNTRUSTED MCP TOOL RESULT\n2 containers\nEND UNTRUSTED MCP TOOL RESULT", isError: false, summary: "2 containers" })),
  };
}

function baseModel(overrides: Partial<ToolCallingModelProvider> = {}): ToolCallingModelProvider {
  return {
    name: "test-model",
    modelId: "muse-spark-test",
    analyzeAndPlan: async () => {
      throw new Error("not used");
    },
    generatePatch: async () => ({ summary: "ok", operations: [{ type: "replace", path: "a.ts", search: "old", replace: "new" }] }),
    reviewVerification: async () => ({ summary: "verified", verdict: "approve", criteria: [], unintendedChanges: [], missingTests: [] }),
    runToolLoop: async () => loopResult(),
    ...overrides,
  };
}

const REVIEW_INPUT: ReviewInput = {
  issueTitle: "Fix the bug",
  acceptanceCriteria: ["works"],
  predictedPaths: ["a.ts"],
  changedPaths: ["a.ts"],
  diff: "diff --git a/a.ts b/a.ts",
  checks: [],
};

describe("CodingAgent MCP evidence phase", () => {
  it("uses the coding-agent role, executes only the advertised tool, and passes bounded evidence to patch generation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-mcp-agent-"));
    await writeFile(path.join(dir, "a.ts"), "old");
    const runtime = fakeRuntime();
    let loopOptions: ToolLoopOptions | null = null;
    let patchInput: PatchInput | null = null;
    const model = baseModel({
      runToolLoop: async (options) => {
        loopOptions = options;
        const execution = await options.execute({
          name: L1_TOOL.modelName,
          args: { all: true },
          callId: "call_1",
          signal: new AbortController().signal,
        });
        expect(execution.isError).toBe(false);
        return loopResult();
      },
      generatePatch: async (input) => {
        patchInput = input;
        return { summary: "done", operations: [{ type: "replace", path: "a.ts", search: "old", replace: "new" }] };
      },
    });
    const agent = new CodingAgent(model);
    const result = await agent.execute(
      {
        id: "task-1",
        title: "change a.ts",
        description: "replace old",
        expectedOutcome: "new",
        fileScope: ["a.ts"],
        dependsOn: [],
        acceptanceCriteria: ["works"],
        testExpectations: [],
        retryLimit: 0,
      },
      {
        issueTitle: "Fix",
        issueBody: "Body",
        worktreePath: dir,
        mcp: { runtime, runId: "run_1", repositoryId: "repo_1" },
      },
    );

    expect(runtime.toolsForAgent).toHaveBeenCalledWith("run_1", "coding-agent");
    expect(runtime.executeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_1",
        repositoryId: "repo_1",
        agent: "coding-agent",
        modelId: "muse-spark-test",
        tool: L1_TOOL,
        arguments: { all: true },
      }),
    );
    expect(loopOptions!.tools).toEqual([
      { name: L1_TOOL.modelName, description: "docker: List Docker containers", parameters: L1_TOOL.inputSchema },
    ]);
    expect(loopOptions!.maxCalls).toBe(4);
    expect(patchInput!.mcpContext).toBe(loopResult().context);
    expect(result.mcp).toMatchObject({ calls: 1, incomplete: false, warning: null });
  });

  it("skips the phase entirely when no tools are enabled for the agent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-mcp-agent-"));
    await writeFile(path.join(dir, "a.ts"), "old");
    const runtime = fakeRuntime([]);
    const runToolLoop = vi.fn(async () => loopResult());
    let patchInput: PatchInput | null = null;
    const model = baseModel({
      runToolLoop,
      generatePatch: async (input) => {
        patchInput = input;
        return { summary: "done", operations: [{ type: "replace", path: "a.ts", search: "old", replace: "new" }] };
      },
    });
    const result = await new CodingAgent(model).execute(
      {
        id: "task-1",
        title: "change a.ts",
        description: "replace old",
        expectedOutcome: "new",
        fileScope: ["a.ts"],
        dependsOn: [],
        acceptanceCriteria: ["works"],
        testExpectations: [],
        retryLimit: 0,
      },
      { issueTitle: "Fix", issueBody: "Body", worktreePath: dir, mcp: { runtime, runId: "run_1", repositoryId: null } },
    );
    expect(runToolLoop).not.toHaveBeenCalled();
    expect(patchInput!.mcpContext).toBeUndefined();
    expect(result.mcp).toEqual({ context: null, calls: 0, incomplete: false, reason: null, warning: null });
  });

  it("reports an MCP failure as a warning and still generates the patch without fabricated evidence", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dnafix-mcp-agent-"));
    await writeFile(path.join(dir, "a.ts"), "old");
    const runtime = fakeRuntime();
    let patchInput: PatchInput | null = null;
    const model = baseModel({
      runToolLoop: async () => {
        throw new Error("gateway dropped the stdio connection");
      },
      generatePatch: async (input) => {
        patchInput = input;
        return { summary: "done", operations: [{ type: "replace", path: "a.ts", search: "old", replace: "new" }] };
      },
    });
    const result = await new CodingAgent(model).execute(
      {
        id: "task-1",
        title: "change a.ts",
        description: "replace old",
        expectedOutcome: "new",
        fileScope: ["a.ts"],
        dependsOn: [],
        acceptanceCriteria: ["works"],
        testExpectations: [],
        retryLimit: 0,
      },
      { issueTitle: "Fix", issueBody: "Body", worktreePath: dir, mcp: { runtime, runId: "run_1", repositoryId: null } },
    );
    expect(patchInput!.mcpContext).toBeUndefined();
    expect(result.mcp).toMatchObject({ context: null, calls: 0, incomplete: true, reason: "tool-loop-failed" });
    expect(result.mcp!.warning).toMatch(/gateway dropped/);
  });
});

describe("VerificationAgent MCP evidence phase", () => {
  it("requests verification-agent tools and appends untrusted evidence to the review", async () => {
    const runtime = fakeRuntime();
    let reviewInput: ReviewInput | null = null;
    let loopOptions: ToolLoopOptions | null = null;
    const model = baseModel({
      runToolLoop: async (options) => {
        loopOptions = options;
        await options.execute({ name: L1_TOOL.modelName, args: {}, callId: "call_verify", signal: new AbortController().signal });
        return loopResult();
      },
      reviewVerification: async (input) => {
        reviewInput = input;
        return { summary: "verified", verdict: "approve", criteria: [], unintendedChanges: [], missingTests: [] };
      },
    });
    const outcome = await new VerificationAgent(model).reviewWithMcp(REVIEW_INPUT, {
      runtime,
      runId: "run_verify",
      repositoryId: "repo_1",
    });

    expect(runtime.toolsForAgent).toHaveBeenCalledWith("run_verify", "verification-agent");
    expect(runtime.executeToolCall).toHaveBeenCalledWith(expect.objectContaining({ agent: "verification-agent", runId: "run_verify" }));
    expect(loopOptions!.maxCalls).toBe(3);
    expect(reviewInput!.mcpContext).toBe(loopResult().context);
    expect(outcome.review.verdict).toBe("approve");
    expect(outcome.mcp).toMatchObject({ calls: 1, incomplete: false, warning: null });
  });

  it("never lets an MCP failure block or fabricate the verification review", async () => {
    const runtime = fakeRuntime();
    let reviewInput: ReviewInput | null = null;
    const model = baseModel({
      runToolLoop: async () => {
        throw new Error("tool loop timed out");
      },
      reviewVerification: async (input) => {
        reviewInput = input;
        return { summary: "verified", verdict: "uncertain", criteria: [], unintendedChanges: [], missingTests: [] };
      },
    });
    const outcome = await new VerificationAgent(model).reviewWithMcp(REVIEW_INPUT, {
      runtime,
      runId: "run_verify",
      repositoryId: null,
    });
    expect(reviewInput!.mcpContext).toBeUndefined();
    expect(outcome.review.verdict).toBe("uncertain");
    expect(outcome.mcp.warning).toMatch(/tool loop timed out/);
  });
});
