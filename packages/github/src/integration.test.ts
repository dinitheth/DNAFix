import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubIntegrationService,
  SingleFlight,
  loadGitHubAppConfig,
  parseIssueReference,
  parseRepositoryReference,
} from "./integration.js";
import type { GitHubAppConfig } from "./integration.js";
import {
  GitHubAuthError,
  GitHubNotConfiguredError,
  GitHubPermissionError,
  GitHubRateLimitError,
  GitHubValidationError,
  redactSecrets,
} from "./errors.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function makeConfig(overrides: Partial<GitHubAppConfig> = {}): GitHubAppConfig {
  return {
    appId: "12345",
    clientId: "Iv1.client",
    clientSecret: "client-secret",
    privateKey: PRIVATE_KEY_PEM,
    slug: "dnafix-dev",
    userCallbackUrl: "http://localhost:3001/api/v1/integrations/github/callback",
    setupUrl: "http://localhost:3001/api/v1/integrations/github/setup",
    apiBaseUrl: "https://api.github.test",
    oauthBaseUrl: "https://github.test",
    apiVersion: "2022-11-28",
    webBaseUrl: "http://localhost:5173",
    encryptionKey: Buffer.alloc(32, 7),
    missing: [],
    ...overrides,
  };
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** fetch() is called with a string URL; tests want a parsed URL plus init. */
function toFetch(handler: Handler): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    return handler(new URL(raw), init ?? {});
  }) as typeof fetch;
}

function service(handler: Handler, options: { now?: () => number; stateTtlMs?: number } = {}): GitHubIntegrationService {
  return new GitHubIntegrationService({
    config: makeConfig(),
    fetchFn: toFetch(handler),
    now: options.now,
    stateTtlMs: options.stateTtlMs,
  });
}

const installationPayload = {
  total_count: 1,
  installations: [
    {
      id: 42,
      account: { login: "octocat", type: "User", avatar_url: "https://avatars.test/u/1" },
      repository_selection: "selected",
      suspended_at: null,
      html_url: "https://github.com/settings/installations/42",
    },
  ],
};

const repoPayload = (id: number, name: string) => ({
  id,
  name,
  full_name: `octocat/${name}`,
  private: id % 2 === 0,
  visibility: id % 2 === 0 ? "private" : "public",
  description: `${name} description`,
  default_branch: "main",
  language: "TypeScript",
  updated_at: "2026-10-01T00:00:00Z",
  html_url: `https://github.com/octocat/${name}`,
  clone_url: `https://github.com/octocat/${name}.git`,
  owner: { login: "octocat", type: "User", avatar_url: "https://avatars.test/u/1" },
});

function issuePayload(number: number, body: string | null, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body,
    state: "open",
    html_url: `https://github.com/octocat/demo/issues/${number}`,
    user: { login: "developer", avatar_url: null },
    labels: [{ name: "bug", color: "ff0000" }],
    assignees: [{ login: "developer" }],
    milestone: { title: "v1" },
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    comments: 3,
    ...extra,
  };
}

describe("GitHub App configuration", () => {
  it("reports every missing value instead of simulating a connection", () => {
    const config = loadGitHubAppConfig({});
    expect(config.missing).toEqual(
      expect.arrayContaining([
        "GITHUB_APP_ID",
        "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_CLIENT_SECRET",
        "GITHUB_APP_SLUG",
        "GITHUB_APP_PRIVATE_KEY_BASE64 (or GITHUB_APP_PRIVATE_KEY)",
        "GITHUB_TOKEN_ENCRYPTION_KEY (32-byte base64 or 64-char hex)",
      ]),
    );
    expect(config.missing).toHaveLength(6);
    const svc = new GitHubIntegrationService({ config, fetchFn: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch });
    expect(svc.configured).toBe(false);
    expect(() => svc.assertConfigured()).toThrow(GitHubNotConfiguredError);
  });

  it("accepts a 32-byte hex encryption key and rejects a short key", () => {
    const config = loadGitHubAppConfig({
      GITHUB_APP_ID: "1",
      GITHUB_APP_CLIENT_ID: "cid",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_SLUG: "app",
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(PRIVATE_KEY_PEM).toString("base64"),
      GITHUB_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    });
    expect(config.missing).toEqual([]);
    expect(config.encryptionKey?.length).toBe(32);
    const short = loadGitHubAppConfig({ GITHUB_TOKEN_ENCRYPTION_KEY: "abc" });
    expect(short.encryptionKey).toBeNull();
    expect(short.missing).toContain("GITHUB_TOKEN_ENCRYPTION_KEY (32-byte base64 or 64-char hex)");
  });
});

describe("OAuth state", () => {
  it("generates a GitHub authorization URL with a single-use, session-bound state", () => {
    const svc = service(() => json({}));
    const url = new URL(svc.createAuthorizeUrl("session-1", "/new"));
    expect(url.origin).toBe("https://github.test");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.client");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3001/api/v1/integrations/github/callback");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(svc.consumeState(state!, "session-1", "oauth").returnTo).toBe("/new");
    expect(() => svc.consumeState(state!, "session-1", "oauth")).toThrow(/already used|invalid/i);
  });

  it("rejects state from another session", () => {
    const svc = service(() => json({}));
    const state = new URL(svc.createAuthorizeUrl("session-1")).searchParams.get("state");
    expect(() => svc.consumeState(state!, "session-2", "oauth")).toThrow(/different DNAFix session/i);
  });

  it("expires state and rejects the wrong step", () => {
    let now = 1_700_000_000_000;
    const svc = service(() => json({}), { now: () => now, stateTtlMs: 60_000 });
    const state = new URL(svc.createAuthorizeUrl("session-1")).searchParams.get("state");
    now += 61_000;
    expect(() => svc.consumeState(state!, "session-1", "oauth")).toThrow(/expired/i);
    const install = new URL(svc.createInstallUrl("session-1")).searchParams.get("state");
    expect(() => svc.consumeState(install!, "session-1", "oauth")).toThrow(/different step/i);
  });

  it("refuses to create an authorization URL when unconfigured", () => {
    const svc = new GitHubIntegrationService({ config: loadGitHubAppConfig({}), fetchFn: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch });
    expect(() => svc.createAuthorizeUrl("session-1")).toThrow(GitHubNotConfiguredError);
  });
});

describe("user authorization and identity", () => {
  it("exchanges a code, refreshes tokens, and never returns credentials in DTOs", async () => {
    const seen: string[] = [];
    const svc = service((url, init) => {
      seen.push(`${init.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/login/oauth/access_token") {
        const body = JSON.parse(String(init.body)) as { grant_type?: string; code?: string };
        if (body.grant_type === "refresh_token") {
          return json({ access_token: "ghu_refreshed", expires_in: 28800, refresh_token: "ghr_2", refresh_token_expires_in: 15000000, scope: "", token_type: "bearer" });
        }
        expect(body.code).toBe("code-1");
        return json({ access_token: "ghu_secret", expires_in: 28800, refresh_token: "ghr_1", refresh_token_expires_in: 15000000, scope: "", token_type: "bearer" });
      }
      if (url.pathname === "/user") return json({ id: 7, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.test/u/7", html_url: "https://github.com/octocat" });
      if (url.pathname === "/user/installations") return json(installationPayload);
      return json({}, 404);
    });
    const tokens = await svc.exchangeCode("code-1");
    expect(tokens.accessToken).toBe("ghu_secret");
    expect(tokens.refreshToken).toBe("ghr_1");
    expect(tokens.accessTokenExpiresAt).toBeTruthy();
    const refreshed = await svc.refreshUserToken("ghr_1");
    expect(refreshed.accessToken).toBe("ghu_refreshed");
    const user = await svc.getUser(tokens.accessToken);
    expect(user).toEqual({ id: 7, login: "octocat", name: "The Octocat", avatarUrl: "https://avatars.test/u/7", htmlUrl: "https://github.com/octocat" });
    expect(JSON.stringify(user)).not.toContain("ghu_secret");
    const installations = await svc.listInstallations(tokens.accessToken);
    expect(installations).toHaveLength(1);
    expect(JSON.stringify(installations)).not.toContain("ghu_secret");
    expect(seen).toContain("POST /login/oauth/access_token");
  });

  it("maps OAuth denial and expired authorization codes", async () => {
    const denied = service(() => json({ error: "access_denied", error_description: "The user denied your request" }, 200));
    await expect(denied.exchangeCode("code")).rejects.toMatchObject({ code: "oauth_failed" });
    const expired = service(() => json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }, 200));
    await expect(expired.exchangeCode("code")).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("rejects a spoofed installation ID that the user cannot access", async () => {
    const svc = service((url) => (url.pathname === "/user/installations" ? json(installationPayload) : json({}, 404)));
    await expect(svc.verifyInstallation("ghu_token", 999)).rejects.toBeInstanceOf(GitHubPermissionError);
    await expect(svc.verifyInstallation("ghu_token", 42)).resolves.toMatchObject({ id: 42, accountLogin: "octocat" });
  });

  it("reports suspended installations distinctly", async () => {
    const suspended = {
      ...installationPayload,
      installations: [{ ...installationPayload.installations[0], suspended_at: "2026-10-01T00:00:00Z" }],
    };
    const svc = service((url) => (url.pathname === "/user/installations" ? json(suspended) : json({}, 404)));
    await expect(svc.verifyInstallation("ghu_token", 42)).rejects.toMatchObject({ code: "installation_suspended" });
  });

  it("maps 401 to authentication expiry and 403 to missing permission", async () => {
    const unauthorized = service(() => json({ message: "Bad credentials" }, 401));
    await expect(unauthorized.getUser("revoked")).rejects.toBeInstanceOf(GitHubAuthError);
    const forbidden = service(() => json({ message: "Resource not accessible by integration" }, 403));
    await expect(forbidden.getUser("token")).rejects.toBeInstanceOf(GitHubPermissionError);
  });
});

describe("repository discovery", () => {
  it("paginates installation repositories and keeps private visibility metadata", async () => {
    const pages: number[] = [];
    const svc = service((url) => {
      if (!url.pathname.endsWith("/repositories")) return json({}, 404);
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      if (page === 1) return json({ total_count: 3, repositories: [repoPayload(1, "public-one"), repoPayload(2, "private-two")] });
      return json({ total_count: 3, repositories: [repoPayload(4, "private-four")] });
    });
    const repositories = await svc.listInstallationRepositories("ghu_token", 42);
    expect(repositories).toHaveLength(3);
    expect(repositories[1]?.private).toBe(true);
    expect(repositories[1]?.visibility).toBe("private");
    expect(pages).toEqual([1, 2]);
  });

  it("uses public repository metadata and maps not-found without exposing a token", async () => {
    const svc = service((url) => (url.pathname === "/repos/octocat/missing" ? json({ message: "Not Found" }, 404) : json({}, 404)));
    await expect(svc.getRepository("ghu_secret", "octocat", "missing")).rejects.toMatchObject({ code: "not_found" });
    try {
      await svc.getRepository("ghu_secret", "octocat", "missing");
    } catch (err) {
      expect((err as Error).message).not.toContain("ghu_secret");
    }
  });

  it("validates manual repository and issue references against the canonical host", () => {
    expect(parseRepositoryReference("https://github.com/octocat/demo.git")).toEqual({ owner: "octocat", repo: "demo" });
    expect(parseRepositoryReference("octocat/demo")).toEqual({ owner: "octocat", repo: "demo" });
    expect(() => parseRepositoryReference("https://evil.example/octocat/demo")).toThrow(GitHubValidationError);
    expect(() => parseRepositoryReference("https://gitlab.com/octocat/demo")).toThrow(GitHubValidationError);
    expect(parseIssueReference("https://github.com/octocat/demo/issues/123?foo=bar")).toEqual({ owner: "octocat", repo: "demo", issueNumber: 123 });
    expect(() => parseIssueReference("https://github.com/octocat/demo/pull/123")).toThrow(GitHubValidationError);
  });
});

describe("issue discovery", () => {
  it("lists issues and excludes pull requests returned by the Issues API", async () => {
    const svc = service((url) => {
      if (url.pathname === "/repos/octocat/demo/issues") {
        expect(url.searchParams.get("state")).toBe("open");
        return json([issuePayload(1, "body"), issuePayload(2, "pr body", { pull_request: { url: "https://api.github.test/pulls/2" } })]);
      }
      return json({}, 404);
    });
    const page = await svc.listIssues({ token: "ghs_token", owner: "octocat", repo: "demo", state: "open", page: 1, perPage: 20 });
    expect(page.source).toBe("issues");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.number).toBe(1);
  });

  it("uses GitHub search with an explicit is:issue constraint and state filter", async () => {
    let requested = "";
    const svc = service((url) => {
      if (url.pathname === "/search/issues") {
        requested = url.searchParams.get("q") ?? "";
        return json({ total_count: 2, incomplete_results: false, items: [issuePayload(5, "matches"), issuePayload(6, "pr", { pull_request: {} })] });
      }
      return json({}, 404);
    });
    const page = await svc.listIssues({ token: "ghs_token", owner: "octocat", repo: "demo", state: "closed", page: 2, perPage: 10, query: "login timeout" });
    expect(requested).toContain("repo:octocat/demo");
    expect(requested).toContain("is:issue");
    expect(requested).toContain("state:closed");
    expect(requested).toContain("login timeout");
    expect(page.source).toBe("search");
    expect(page.items.map((i) => i.number)).toEqual([5]);
    expect(page.hasNext).toBe(false);
    expect(page.totalCount).toBe(2);
  });

  it("returns complete issue details and preserves Markdown exactly", async () => {
    const markdown = "Steps to reproduce:\n\n1. Run `pnpm test`\n2. Observe **failure**\n\n- [ ] acceptance one\n- [ ] acceptance two\n";
    const svc = service((url) => (url.pathname === "/repos/octocat/demo/issues/9" ? json(issuePayload(9, markdown), 200, { etag: '"etag-9"' }) : json({}, 404)));
    const result = await svc.getIssueDetail({ token: "ghs_token", owner: "octocat", repo: "demo", issueNumber: 9 });
    expect(result.issue.body).toBe(markdown);
    expect(result.issue.repositoryFullName).toBe("octocat/demo");
    expect(result.issue.milestone).toBe("v1");
    expect(result.cached).toBe(false);
    expect(result.etag).toBe('"etag-9"');
  });

  it("revalidates with ETag and returns cached bytes on HTTP 304", async () => {
    let calls = 0;
    const svc = service((url, init) => {
      calls += 1;
      if (calls === 1) return json(issuePayload(9, "original body"), 200, { etag: '"v1"' });
      expect(new Headers(init.headers).get("if-none-match")).toBe('"v1"');
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    });
    const first = await svc.getIssueDetail({ token: "ghs_token", owner: "octocat", repo: "demo", issueNumber: 9 });
    const second = await svc.getIssueDetail({ token: "ghs_token", owner: "octocat", repo: "demo", issueNumber: 9 });
    expect(second.cached).toBe(true);
    expect(second.issue.body).toBe(first.issue.body);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it("rejects pull request detail and invalid issue numbers", async () => {
    const svc = service((url) => (url.pathname.endsWith("/issues/10") ? json(issuePayload(10, "pr", { pull_request: {} })) : json({}, 404)));
    await expect(svc.getIssueDetail({ token: "t", owner: "octocat", repo: "demo", issueNumber: 10 })).rejects.toThrow(/pull request, not an issue/i);
    await expect(svc.getIssueDetail({ token: "t", owner: "octocat", repo: "demo", issueNumber: 0 })).rejects.toBeInstanceOf(GitHubValidationError);
  });

  it("handles primary and secondary rate limits with reset information", async () => {
    const primary = service(() =>
      json({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1700000000",
      }),
    );
    const error = await primary.getUser("token").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt).toBe(new Date(1_700_000_000_000).toISOString());

    const secondary = service(() => json({ message: "You have exceeded a secondary rate limit" }, 429, { "retry-after": "30" }));
    const retryError = await secondary.getUser("token").catch((err: unknown) => err);
    expect(retryError).toBeInstanceOf(GitHubRateLimitError);
    expect((retryError as GitHubRateLimitError).retryAfterSeconds).toBe(30);
  });
});

describe("installation tokens and revocation", () => {
  it("creates repository-scoped installation tokens and caches them", async () => {
    const calls: Array<{ repositoryIds: unknown; repositoryNames: unknown; permissions: unknown; authorization: string | null }> = [];
    const svc = service((url, init) => {
      if (url.pathname === "/app/installations/42/access_tokens") {
        const body = JSON.parse(String(init.body ?? "{}")) as { repository_ids?: unknown; repositories?: unknown; permissions?: unknown };
        calls.push({ repositoryIds: body.repository_ids, repositoryNames: body.repositories, permissions: body.permissions, authorization: new Headers(init.headers).get("authorization") });
        return json({ token: `ghs_${calls.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      return json({}, 404);
    });
    const first = await svc.repositoryToken(42, 7);
    const second = await svc.repositoryToken(42, 7);
    expect(first).toBe("ghs_1");
    expect(second).toBe("ghs_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.repositoryIds).toEqual([7]);
    expect(calls[0]?.repositoryNames).toBeUndefined();
    expect(calls[0]?.permissions).toEqual({ metadata: "read", contents: "read", issues: "read" });
    expect(calls[0]?.authorization).toMatch(/^Bearer /);
  });

  it("revokes the user grant and installation token without returning secrets", async () => {
    const calls: string[] = [];
    const svc = service((url, init) => {
      calls.push(`${init.method} ${url.pathname}`);
      if (url.pathname.startsWith("/applications/")) return new Response(null, { status: 204 });
      if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
      return json({}, 404);
    });
    await svc.revokeUserAuthorization("ghu_secret");
    await svc.revokeInstallationToken("ghs_secret");
    expect(calls).toEqual(["DELETE /applications/Iv1.client/grant", "DELETE /installation/token"]);
  });

  it("redacts credential material from log text", () => {
    expect(redactSecrets("failed with ghu_secret and ghs_secret", ["ghu_secret", "ghs_secret"])).toBe("failed with [redacted] and [redacted]");
  });
});

describe("single-flight refresh protection", () => {
  it("runs concurrent refreshes for the same session exactly once", async () => {
    const flight = new SingleFlight<string, string>();
    const fn = vi.fn(async (value: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return value;
    });
    const [a, b, c] = await Promise.all([flight.run("session", () => fn("first")), flight.run("session", () => fn("second")), flight.run("session", () => fn("third"))]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toBe("first");
    expect(b).toBe("first");
    expect(c).toBe("first");
    expect(flight.size).toBe(0);
  });
});
