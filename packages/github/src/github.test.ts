import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAdapter, createAppJwt, verifyWebhookSignature } from "./index.js";

describe("webhook signature verification", () => {
  it("accepts valid HMAC and rejects tampered payloads", () => {
    const secret = "test-secret";
    const body = JSON.stringify({ action: "opened" });
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, sig, secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, sig, "wrong")).toBe(false);
  });
});

describe("GitHub App adapter", () => {
  it("creates a well-formed RS256 JWT", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = createAppJwt("12345", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1_700_000_000);
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    const header = JSON.parse(Buffer.from(segments[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(header?.alg).toBe("RS256");
    expect(payload?.iss).toBe("12345");
  });

  it("creates draft PRs only, with the approval-gated payload", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined });
      if (url.includes("access_tokens")) {
        return new Response(JSON.stringify({ token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
      }
      return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7", draft: true }), { status: 201 });
    }) as typeof fetch;
    const gh = new GitHubAdapter({ appId: "1", privateKey: pem, installationId: "2", fetchFn });
    const pr = await gh.createDraftPullRequest({ owner: "o", repo: "r", title: "t", body: "b", head: "dnafix/x", base: "main" });
    expect(pr.url).toContain("/pull/7");
    const prCall = calls.find((c) => c.url.endsWith("/pulls"));
    expect(prCall?.body?.draft).toBe(true);
    // The adapter exposes no merge capability.
    expect(typeof (gh as unknown as Record<string, unknown>).mergePullRequest).toBe("undefined");
  });
});
