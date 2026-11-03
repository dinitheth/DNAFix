import { generateKeyPairSync } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { GitHubIntegrationService, loadGitHubAppConfig, type GitHubAppConfig } from "@dnafix/github";
import { MemoryStore } from "@dnafix/persistence";
import { GitHubConnectionManager, registerGitHubRoutes } from "./github.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const SESSION = "b".repeat(64);

function config(): GitHubAppConfig {
  return {
    appId: "12345",
    clientId: "Iv1.client",
    clientSecret: "client-secret",
    privateKey: privateKeyPem,
    slug: "dnafix-dev",
    userCallbackUrl: "http://localhost:3001/api/v1/integrations/github/callback",
    setupUrl: "http://localhost:3001/api/v1/integrations/github/setup",
    apiBaseUrl: "https://api.github.test",
    oauthBaseUrl: "https://github.test",
    apiVersion: "2022-11-28",
    webBaseUrl: "http://localhost:5173",
    encryptionKey: Buffer.alloc(32, 3),
    missing: [],
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const installation = {
  total_count: 1,
  installations: [{ id: 42, account: { login: "octocat", type: "User", avatar_url: null }, repository_selection: "selected", suspended_at: null }],
};

const repository = {
  id: 7,
  name: "demo",
  full_name: "octocat/demo",
  private: true,
  visibility: "private",
  description: "Demo",
  default_branch: "main",
  language: "TypeScript",
  updated_at: "2026-10-01T00:00:00Z",
  html_url: "https://github.com/octocat/demo",
  clone_url: "https://github.com/octocat/demo.git",
  owner: { login: "octocat", type: "User", avatar_url: null },
};

const issue = {
  number: 5,
  title: "Real issue",
  body: "Exact **Markdown** body\n\n- [ ] criterion\n",
  state: "open",
  html_url: "https://github.com/octocat/demo/issues/5",
  user: { login: "developer", avatar_url: null },
  labels: [{ name: "bug", color: "ff0000" }],
  assignees: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  comments: 1,
};

const tokens = {
  accessToken: "ghu_plaintext_access",
  accessTokenExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
  refreshToken: "ghr_plaintext_refresh",
  refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 3_600_000).toISOString(),
  scopes: [],
  tokenType: "bearer",
};

function makeManager(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const store = new MemoryStore();
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    return handler(new URL(raw), init ?? {});
  }) as typeof fetch;
  const integration = new GitHubIntegrationService({ config: config(), fetchFn });
  return { store, integration, manager: new GitHubConnectionManager(integration, store) };
}

const baseHandler = (url: URL, init: RequestInit): Response => {
  const method = init.method ?? "GET";
  if (method === "GET" && url.pathname === "/user") {
    return json({ id: 7, login: "octocat", name: "The Octocat", avatar_url: null, html_url: "https://github.com/octocat" });
  }
  if (method === "GET" && url.pathname === "/user/installations") return json(installation);
  if (method === "GET" && url.pathname === "/user/installations/42/repositories") return json({ total_count: 1, repositories: [repository] });
  if (method === "GET" && url.pathname === "/repos/octocat/demo") return json(repository);
  if (method === "GET" && url.pathname === "/repos/octocat/demo/issues/5") return json(issue, 200, { etag: '"issue-5"' });
  if (method === "GET" && url.pathname === "/repos/octocat/demo/issues") {
    return json([issue, { ...issue, number: 6, html_url: "https://github.com/octocat/demo/pull/6", pull_request: { url: "https://api.github.test/pulls/6" } }]);
  }
  if (method === "POST" && url.pathname === "/login/oauth/access_token") {
    return json({ access_token: "ghu_plaintext_access", refresh_token: "ghr_plaintext_refresh", expires_in: 28800, refresh_token_expires_in: 15000000, token_type: "bearer", scope: "" });
  }
  if (method === "POST" && url.pathname === "/app/installations/42/access_tokens") {
    return json({ token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  }
  if (method === "DELETE" && url.pathname.startsWith("/applications/")) return new Response(null, { status: 204 });
  if (method === "DELETE" && url.pathname === "/installation/token") return new Response(null, { status: 204 });
  return json({ message: "Not Found" }, 404);
};

const providerFetch = (async (input: unknown, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
  return baseHandler(new URL(raw), init ?? {});
}) as typeof fetch;

describe("GitHub connection manager", () => {
  it("stores tokens encrypted at rest and keeps them out of API-facing status", async () => {
    const { store, manager } = makeManager(baseHandler);
    await manager.completeAuthorization(SESSION, tokens);
    const stored = await store.getGitHubConnection(SESSION);
    expect(stored).not.toBeNull();
    expect(stored!.accessTokenCiphertext).toMatch(/^v1\./);
    expect(stored!.accessTokenCiphertext).not.toContain(tokens.accessToken);
    expect(stored!.refreshTokenCiphertext).not.toContain(tokens.refreshToken);
    expect(JSON.stringify(stored)).not.toContain("ghu_plaintext_access");
    expect(JSON.stringify(stored)).not.toContain("ghr_plaintext_refresh");

    const status = await manager.status(SESSION);
    expect(status.connected).toBe(true);
    expect(status.account?.login).toBe("octocat");
    expect(status.installation?.id).toBe(42);
    expect(JSON.stringify(status)).not.toContain("ghu_plaintext_access");
    expect(JSON.stringify(status)).not.toContain("ghr_plaintext_refresh");

    const { token } = await manager.requireToken(SESSION);
    expect(token).toBe(tokens.accessToken);
  });

  it("refreshes an expired user token concurrently only once", async () => {
    let refreshCalls = 0;
    const { store, manager } = makeManager((url, init) => {
      if ((init.method ?? "GET") === "POST" && url.pathname === "/login/oauth/access_token") {
        refreshCalls += 1;
        const body = JSON.parse(String(init.body)) as { grant_type?: string };
        expect(body.grant_type).toBe("refresh_token");
        return json({ access_token: "ghu_refreshed", refresh_token: "ghr_rotated", expires_in: 28800, refresh_token_expires_in: 15000000, token_type: "bearer", scope: "" });
      }
      return baseHandler(url, init);
    });
    await manager.completeAuthorization(SESSION, tokens);
    const stored = await store.getGitHubConnection(SESSION);
    await store.saveGitHubConnection({ ...stored!, accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });

    const results = await Promise.all([manager.requireToken(SESSION), manager.requireToken(SESSION), manager.requireToken(SESSION)]);
    expect(refreshCalls).toBe(1);
    expect(results.map((r) => r.token)).toEqual(["ghu_refreshed", "ghu_refreshed", "ghu_refreshed"]);
    const refreshed = await store.getGitHubConnection(SESSION);
    expect(refreshed!.accessTokenCiphertext).not.toBe(stored!.accessTokenCiphertext);
    expect(refreshed!.refreshTokenCiphertext).not.toBe(stored!.refreshTokenCiphertext);
    expect(JSON.stringify(refreshed)).not.toContain("ghr_rotated");
  });

  it("rejects spoofed installations, mismatched issue URLs, and pull requests before accepting provenance", async () => {
    const { manager } = makeManager((url, init) => {
      if (url.pathname === "/repos/octocat/demo/issues/6") return json({ ...issue, number: 6, pull_request: { url: "https://api.github.test/pulls/6" } }, 200, { etag: '"issue-6"' });
      return baseHandler(url, init);
    });
    await manager.completeAuthorization(SESSION, tokens);

    await expect(
      manager.validateRunProvenance(SESSION, { githubOwner: "octocat", githubRepo: "demo", issueNumber: 5, githubInstallationId: 999 }),
    ).rejects.toMatchObject({ code: "permission_denied" });

    await expect(
      manager.validateRunProvenance(SESSION, { githubOwner: "other", githubRepo: "demo", issueUrl: "https://github.com/octocat/demo/issues/5" }),
    ).rejects.toBeInstanceOf(Error);

    await expect(
      manager.validateRunProvenance(SESSION, { githubOwner: "octocat", githubRepo: "demo", issueUrl: "https://github.com/octocat/demo/issues/6" }),
    ).rejects.toThrow(/pull request, not an issue/i);

    const valid = await manager.validateRunProvenance(SESSION, { githubOwner: "octocat", githubRepo: "demo", issueUrl: "https://github.com/octocat/demo/issues/5" });
    expect(valid).toEqual({
      installationId: 42,
      issueUrl: "https://github.com/octocat/demo/issues/5",
      issueNumber: 5,
      repositoryFullName: "octocat/demo",
    });
  });

  it("selects and persists a verified repository with installation provenance", async () => {
    const { store, manager } = makeManager(baseHandler);
    await manager.completeAuthorization(SESSION, tokens);
    const result = await manager.selectRepository(SESSION, "https://github.com/octocat/demo");
    expect(result.repository.fullName).toBe("octocat/demo");
    expect(result.record.githubInstallationId).toBe(42);
    const persisted = await store.getRepository(result.record.id);
    expect(persisted?.githubInstallationId).toBe(42);
  });

  it("revokes credentials and deletes the connection on disconnect", async () => {
    const calls: string[] = [];
    const { store, manager } = makeManager((url, init) => {
      calls.push(`${init.method ?? "GET"} ${url.pathname}`);
      return baseHandler(url, init);
    });
    await manager.completeAuthorization(SESSION, tokens);
    const result = await manager.disconnect(SESSION);
    expect(result.disconnected).toBe(true);
    expect(result.userAuthorization).toBe("revoked");
    expect(result.installationToken).toBe("revoked");
    expect(calls).toContain("DELETE /applications/Iv1.client/grant");
    expect(calls).toContain("DELETE /installation/token");
    expect(await store.getGitHubConnection(SESSION)).toBeNull();
  });

  it("reports expired authorization when no refresh token remains", async () => {
    const { store, manager } = makeManager(baseHandler);
    await manager.completeAuthorization(SESSION, tokens);
    const stored = await store.getGitHubConnection(SESSION);
    await store.saveGitHubConnection({
      ...stored!,
      accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshTokenCiphertext: null,
      refreshTokenExpiresAt: null,
    });
    const status = await manager.status(SESSION);
    expect(status.authorizationExpired).toBe(true);
    await expect(manager.requireToken(SESSION)).rejects.toMatchObject({ code: "authentication_expired" });
  });
});

function makeApp(integration: GitHubIntegrationService, store = new MemoryStore()) {
  const app = Fastify();
  const manager = new GitHubConnectionManager(integration, store);
  registerGitHubRoutes(app, { manager, integration });
  return { app, store, manager };
}

function cookiePair(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return String(value).split(";")[0] ?? "";
}

describe("GitHub integration routes", () => {
  it("reports missing configuration and refuses to start a fake connection", async () => {
    let calls = 0;
    const integration = new GitHubIntegrationService({
      config: loadGitHubAppConfig({}),
      fetchFn: (async () => {
        calls += 1;
        throw new Error("network must not be used");
      }) as typeof fetch,
    });
    const { app } = makeApp(integration);
    const status = await app.inject({ method: "GET", url: "/api/v1/integrations/github/status" });
    expect(status.statusCode).toBe(200);
    const body = status.json() as { configured: boolean; connected: boolean; missing: string[] };
    expect(body.configured).toBe(false);
    expect(body.connected).toBe(false);
    expect(body.missing).toEqual(expect.arrayContaining(["GITHUB_APP_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_TOKEN_ENCRYPTION_KEY (32-byte base64 or 64-char hex)"]));

    const connect = await app.inject({ method: "POST", url: "/api/v1/integrations/github/connect", payload: {} });
    expect(connect.statusCode).toBe(503);
    expect(connect.json()).toMatchObject({ code: "not_configured" });
    expect(calls).toBe(0);
  });

  it("sets an HttpOnly, SameSite session cookie and marks it Secure on HTTPS origins", async () => {
    const integration = new GitHubIntegrationService({ config: loadGitHubAppConfig({}) });
    const { app } = makeApp(integration);
    const status = await app.inject({ method: "GET", url: "/api/v1/integrations/github/status" });
    expect(status.headers["set-cookie"]).toContain("HttpOnly");
    expect(status.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(status.headers["set-cookie"]).toContain("Path=/");

    const previous = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "https://api.example.test";
    try {
      const secure = await app.inject({ method: "GET", url: "/api/v1/integrations/github/status" });
      expect(secure.headers["set-cookie"]).toContain("; Secure");
    } finally {
      if (previous === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = previous;
    }
  });

  it("rejects callbacks without a session or with invalid state before exchanging a code", async () => {
    let calls = 0;
    const integration = new GitHubIntegrationService({
      config: config(),
      fetchFn: (async () => {
        calls += 1;
        return json({}, 500);
      }) as typeof fetch,
    });
    const { app } = makeApp(integration);

    const noSession = await app.inject({ method: "GET", url: "/api/v1/integrations/github/callback?state=x" });
    expect(noSession.statusCode).toBe(302);
    expect(noSession.headers.location).toContain("github=error");
    expect(noSession.headers.location).toContain("github_code=invalid_session");

    const badState = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/github/callback?state=x",
      headers: { cookie: `dnafix_sid=${SESSION}` },
    });
    expect(badState.statusCode).toBe(302);
    expect(badState.headers.location).toContain("github=error");
    expect(badState.headers.location).toContain("github_code=invalid_request");
    expect(calls).toBe(0);
  });

  it("completes the connect, browse, issue import, and disconnect flow without leaking tokens", async () => {
    const { app, store } = makeApp(new GitHubIntegrationService({ config: config(), fetchFn: providerFetch }));
    const connect = await app.inject({ method: "POST", url: "/api/v1/integrations/github/connect", payload: { returnTo: "/new" } });
    expect(connect.statusCode).toBe(200);
    const authorizeUrl = new URL((connect.json() as { authorizeUrl: string }).authorizeUrl);
    expect(authorizeUrl.origin).toBe("https://github.test");
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const cookie = cookiePair(connect);
    const sessionId = cookie.slice(cookie.indexOf("=") + 1);

    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/integrations/github/callback?code=code-1&state=${encodeURIComponent(state!)}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("github=connected");

    const status = await app.inject({ method: "GET", url: "/api/v1/integrations/github/status", headers: { cookie } });
    const statusBody = status.json() as { connected: boolean; account: { login: string } | null; installation: { id: number } | null };
    expect(statusBody.connected).toBe(true);
    expect(statusBody.account?.login).toBe("octocat");
    expect(statusBody.installation?.id).toBe(42);
    expect(status.body).not.toContain("ghu_plaintext_access");
    expect(status.body).not.toContain("ghr_plaintext_refresh");

    const repositories = await app.inject({ method: "GET", url: "/api/v1/integrations/github/repositories?visibility=private", headers: { cookie } });
    expect(repositories.statusCode).toBe(200);
    const repositoriesBody = repositories.json() as { repositories: Array<{ fullName: string }>; totalCount: number };
    expect(repositoriesBody.totalCount).toBe(1);
    expect(repositoriesBody.repositories[0]?.fullName).toBe("octocat/demo");
    expect(repositories.body).not.toContain("ghu_plaintext_access");
    expect(repositories.body).not.toContain("ghs_installation");

    const issues = await app.inject({ method: "GET", url: "/api/v1/integrations/github/repositories/octocat/demo/issues?state=open", headers: { cookie } });
    expect(issues.statusCode).toBe(200);
    const issuesBody = issues.json() as { items: Array<{ number: number }>; repositoryFullName: string };
    expect(issuesBody.repositoryFullName).toBe("octocat/demo");
    expect(issuesBody.items.map((item) => item.number)).toEqual([5]);
    expect(issues.body).not.toContain("ghs_installation");

    const detail = await app.inject({ method: "GET", url: "/api/v1/integrations/github/repositories/octocat/demo/issues/5", headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { issue: { body: string } }).issue.body).toBe(issue.body);
    expect(detail.body).not.toContain("ghu_plaintext_access");

    const disconnect = await app.inject({ method: "POST", url: "/api/v1/integrations/github/disconnect", headers: { cookie } });
    expect(disconnect.statusCode).toBe(200);
    expect(disconnect.json()).toMatchObject({ disconnected: true, userAuthorization: "revoked", installationToken: "revoked" });
    expect(await store.getGitHubConnection(sessionId)).toBeNull();
  });
});
