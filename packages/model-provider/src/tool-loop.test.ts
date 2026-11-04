import { describe, expect, it, vi } from "vitest";
import {
  MetaModelProvider,
  ModelNotConfiguredError,
  ModelResponseError,
  supportsToolCalling,
  type ModelProvider,
  type ModelToolDefinition,
} from "./index.js";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function providerWith(responses: unknown[], transport: "responses" | "chat-completions" = "responses") {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const next = responses.shift();
    if (next === undefined) throw new Error("test model response queue is empty");
    if (next instanceof Error) throw next;
    return jsonResponse(next);
  }) as unknown as typeof fetch;
  const provider = new MetaModelProvider({
    apiKey: "test-key",
    baseURL: "https://model.test/v1",
    model: "muse-wonder-test",
    transport,
    fetchFn,
  });
  return { provider, requests };
}

const TOOL: ModelToolDefinition = {
  name: "mcp_docker_list_containers_12345678",
  description: "List Docker containers",
  parameters: { type: "object", properties: { all: { type: "boolean" } }, additionalProperties: false },
};
const TOOLS: ModelToolDefinition[] = [TOOL];

describe("bounded model tool loop", () => {
  it("executes a Responses function_call, chains previous_response_id, and returns function_call_output with call_id", async () => {
    const { provider, requests } = providerWith([
      {
        id: "resp_1",
        status: "completed",
        output: [{ type: "function_call", call_id: "call_1", name: TOOL.name, arguments: '{"all":true}' }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      { id: "resp_2", status: "completed", output_text: "Two containers are running.", output: [] },
    ]);
    const execute = vi.fn(async () => ({ content: "container-a\ncontainer-b", isError: false, summary: "2 containers" }));

    const result = await provider.runToolLoop({ instructions: "gather evidence", input: "list containers", tools: TOOLS, execute });

    expect(result.text).toBe("Two containers are running.");
    expect(result.incomplete).toBe(false);
    expect(result.calls).toEqual([expect.objectContaining({ name: TOOL.name, callId: "call_1", executed: true, isError: false })]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(execute).toHaveBeenCalledTimes(1);

    expect(requests[0]!.url).toBe("https://model.test/v1/responses");
    expect(requests[0]!.body.tools).toEqual([
      { type: "function", name: TOOL.name, description: TOOL.description, parameters: TOOL.parameters },
    ]);
    expect(requests[1]!.body.previous_response_id).toBe("resp_1");
    expect(requests[1]!.body.input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: expect.stringContaining("container-a") },
    ]);
  });

  it("executes multiple function calls returned in one round", async () => {
    const secondTool: ModelToolDefinition = {
      name: "mcp_docker_inspect_container_87654321",
      description: "Inspect a container",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    };
    const { provider, requests } = providerWith([
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "function_call", call_id: "call_1", name: TOOL.name, arguments: "{}" },
          { type: "function_call", call_id: "call_2", name: secondTool.name, arguments: '{"id":"abc"}' },
        ],
      },
      { id: "resp_2", status: "completed", output_text: "done", output: [] },
    ]);
    const execute = vi.fn(async ({ name }: { name: string }) => ({
      content: `${name}-result`,
      isError: false,
      summary: "ok",
    }));

    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: [TOOL, secondTool], execute });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.calls.map((call) => call.callId)).toEqual(["call_1", "call_2"]);
    expect(requests[1]!.body.input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "mcp_docker_list_containers_12345678-result" },
      { type: "function_call_output", call_id: "call_2", output: "mcp_docker_inspect_container_87654321-result" },
    ]);
  });

  it("rejects unknown tools and malformed arguments locally, without calling the executor", async () => {
    const { provider, requests } = providerWith([
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "function_call", call_id: "call_unknown", name: "not_advertised", arguments: "{}" },
          { type: "function_call", call_id: "call_bad_json", name: TOOL.name, arguments: "{ definitely not json" },
          { type: "function_call", call_id: "call_array", name: TOOL.name, arguments: "[1,2,3]" },
        ],
      },
      { id: "resp_2", status: "completed", output_text: "could not gather evidence", output: [] },
    ]);
    const execute = vi.fn();

    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute });

    expect(execute).not.toHaveBeenCalled();
    expect(result.calls).toHaveLength(3);
    expect(result.calls.every((call) => !call.executed && call.isError)).toBe(true);
    expect(result.text).toBe("could not gather evidence");
    const outputs = requests[1]!.body.input as Array<{ output: string }>;
    expect(outputs).toHaveLength(3);
    expect(outputs[0]!.output).toMatch(/Unknown tool/);
    expect(outputs[1]!.output).toMatch(/not valid JSON/);
    expect(outputs[2]!.output).toMatch(/must be a JSON object/);
  });

  it("suppresses exact duplicate calls within one tool loop", async () => {
    const { provider } = providerWith([
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "function_call", call_id: "call_1", name: TOOL.name, arguments: '{"all":true}' },
          { type: "function_call", call_id: "call_2", name: TOOL.name, arguments: '{"all":true}' },
        ],
      },
      { id: "resp_2", status: "completed", output_text: "done", output: [] },
    ]);
    const execute = vi.fn(async () => ({ content: "ok", isError: false, summary: "ok" }));

    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.calls.map((call) => call.executed)).toEqual([true, false]);
    expect(result.calls[1]!.summary).toMatch(/Duplicate call suppressed/);
  });

  it("stops at the call budget and reports incompleteness instead of continuing", async () => {
    const { provider } = providerWith([
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "function_call", call_id: "call_1", name: TOOL.name, arguments: '{"all":true}' },
          { type: "function_call", call_id: "call_2", name: TOOL.name, arguments: '{"all":false}' },
        ],
      },
    ]);
    const execute = vi.fn(async () => ({ content: "ok", isError: false, summary: "ok" }));

    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute, maxCalls: 1 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.incomplete).toBe(true);
    expect(result.incompleteReason).toMatch(/Maximum tool calls reached \(1\)/);
  });

  it("stops at the round budget", async () => {
    const { provider } = providerWith([
      { id: "resp_1", status: "completed", output: [{ type: "function_call", call_id: "c1", name: TOOL.name, arguments: '{"n":1}' }] },
      { id: "resp_2", status: "completed", output: [{ type: "function_call", call_id: "c2", name: TOOL.name, arguments: '{"n":2}' }] },
    ]);
    const execute = vi.fn(async () => ({ content: "ok", isError: false, summary: "ok" }));

    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute, maxRounds: 2 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.rounds).toBe(2);
    expect(result.incomplete).toBe(true);
    expect(result.incompleteReason).toMatch(/Maximum tool rounds reached \(2\)/);
  });

  it("reports an incomplete provider response instead of inventing a result", async () => {
    const { provider } = providerWith([
      {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
    ]);
    const execute = vi.fn();
    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute });
    expect(result.incomplete).toBe(true);
    expect(result.incompleteReason).toBe("max_output_tokens");
    expect(result.calls).toEqual([]);
  });

  it("surfaces provider errors and cancellation without fabricating output", async () => {
    const { provider } = providerWith([{ error: { message: "model exploded" } }]);
    await expect(provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute: vi.fn() })).rejects.toThrow(/model exploded/);

    const controller = new AbortController();
    controller.abort();
    const { provider: second } = providerWith([{ id: "resp_1", status: "completed", output_text: "x", output: [] }]);
    await expect(
      second.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute: vi.fn(), signal: controller.signal }),
    ).rejects.toBeInstanceOf(ModelResponseError);
  });

  it("bounds tool results before feeding them back to the model", async () => {
    const { provider } = providerWith([
      { id: "resp_1", status: "completed", output: [{ type: "function_call", call_id: "c1", name: TOOL.name, arguments: "{}" }] },
      { id: "resp_2", status: "completed", output_text: "done", output: [] },
    ]);
    const execute = vi.fn(async () => ({ content: "y".repeat(2_000), isError: false, summary: "big" }));
    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute, maxToolResultChars: 500 });
    expect(result.context.length).toBeLessThanOrEqual(500);
  });

  it("supports the Chat Completions fallback with the equivalent tool_call protocol", async () => {
    const { provider, requests } = providerWith(
      [
        {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [{ id: "call_1", function: { name: TOOL.name, arguments: '{"all":true}' } }],
              },
            },
          ],
        },
        { choices: [{ finish_reason: "stop", message: { content: "chat done" } }] },
      ],
      "chat-completions",
    );
    const execute = vi.fn(async () => ({ content: "tool output", isError: false, summary: "ok" }));

    const result = await provider.runToolLoop({ instructions: "i", input: "u", tools: TOOLS, execute });

    expect(result.text).toBe("chat done");
    expect(requests[0]!.url).toBe("https://model.test/v1/chat/completions");
    const secondMessages = requests[1]!.body.messages as Array<Record<string, unknown>>;
    expect(secondMessages.at(-2)!).toMatchObject({ role: "assistant" });
    expect(secondMessages.at(-1)!).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "tool output" });
  });

  it("refuses to run without an API key and exposes tool-calling capability explicitly", async () => {
    const provider = new MetaModelProvider({ apiKey: "", fetchFn: (async () => jsonResponse({})) as unknown as typeof fetch });
    await expect(provider.runToolLoop({ instructions: "i", input: "u", tools: [], execute: vi.fn() })).rejects.toBeInstanceOf(ModelNotConfiguredError);
    expect(supportsToolCalling(provider)).toBe(true);

    const plain: ModelProvider = {
      name: "scripted",
      modelId: "scripted",
      analyzeAndPlan: async () => {
        throw new Error("not used");
      },
      generatePatch: async () => {
        throw new Error("not used");
      },
      reviewVerification: async () => {
        throw new Error("not used");
      },
    };
    expect(supportsToolCalling(plain)).toBe(false);
  });

  it("drops invalid or duplicate tool definitions before they reach the model", async () => {
    const { provider, requests } = providerWith([{ id: "resp_1", status: "completed", output_text: "ok", output: [] }]);
    const result = await provider.runToolLoop({
      instructions: "i",
      input: "u",
      tools: [
        TOOL,
        TOOL,
        { name: "bad name with spaces", description: "bad", parameters: { type: "object" } },
      ],
      execute: vi.fn(),
    });
    expect(result.skippedTools).toEqual(["duplicate-name:mcp_docker_list_containers_12345678", "invalid-name:bad name with spaces"]);
    const sentTools = requests[0]!.body.tools as Array<{ name: string }>;
    expect(sentTools).toHaveLength(1);
  });
});
