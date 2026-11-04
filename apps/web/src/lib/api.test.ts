import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

function captureFetch(): Array<{ input: RequestInfo | URL; init?: RequestInit }> {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("omits the JSON content type for empty-body POST requests", async () => {
    const calls = captureFetch();
    await api("/integrations/github/installations/start", { method: "POST" });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("content-type")).toBe(false);
  });

  it("sets the JSON content type when a body is present", async () => {
    const calls = captureFetch();
    await api("/integrations/github/installations/select", {
      method: "POST",
      body: JSON.stringify({ installationId: 42 }),
    });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.init?.body).toBe('{"installationId":42}');
  });

  it("preserves an explicitly supplied content type", async () => {
    const calls = captureFetch();
    await api("/health", { method: "POST", body: "plain", headers: { "Content-Type": "text/plain" } });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("text/plain");
  });
});
