import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { GitHubError, GitHubNotConfiguredError } from "./errors.js";
import { createAppJwt, normalizePrivateKey } from "./jwt.js";

export * from "./errors.js";
export * from "./crypto.js";
export * from "./integration.js";
export { createAppJwt, normalizePrivateKey } from "./jwt.js";

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=") || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.string(),
});
export type GitHubIssue = z.infer<typeof IssueSchema>;

const PullRequestSchema = z.object({ number: z.number(), html_url: z.string(), draft: z.boolean() });

export interface GitHubConfig {
  appId?: string;
  privateKey?: string;
  installationId?: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * GitHub App adapter for repository-scoped operations (issues, draft PRs).
 * App credentials are required; an installation ID may be supplied per call,
 * which the user-facing integration flow does after verifying ownership.
 */
export class GitHubAdapter {
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly fetchFn: typeof fetch;
  constructor(private readonly config: GitHubConfig = {}) {
    this.fetchFn = config.fetchFn ?? fetch;
  }

  get appConfigured(): boolean {
    return Boolean((this.config.appId ?? process.env.GITHUB_APP_ID) && (this.config.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ?? process.env.GITHUB_APP_PRIVATE_KEY));
  }

  get installationConfigured(): boolean {
    return Boolean(this.appConfigured && (this.config.installationId ?? process.env.GITHUB_INSTALLATION_ID));
  }

  /** Backwards-compatible readiness flag: draft-PR delivery needs an installation. */
  get configured(): boolean {
    return this.installationConfigured;
  }

  private credential(): { appId: string; privateKey: string } {
    if (!this.appConfigured) {
      throw new GitHubNotConfiguredError(
        ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_BASE64"].filter((key) => !process.env[key]),
      );
    }
    const appId = this.config.appId ?? process.env.GITHUB_APP_ID!;
    const privateKey = normalizePrivateKey(this.config.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ?? process.env.GITHUB_APP_PRIVATE_KEY);
    if (!privateKey) throw new GitHubNotConfiguredError(["GITHUB_APP_PRIVATE_KEY_BASE64"]);
    return { appId, privateKey };
  }

  /** Installation token, scoped by GitHub and cached until shortly before expiry. */
  async installationToken(installationId?: string | number): Promise<string> {
    const id = String(installationId ?? this.config.installationId ?? process.env.GITHUB_INSTALLATION_ID ?? "");
    if (!id) throw new GitHubNotConfiguredError(["GITHUB_INSTALLATION_ID"]);
    const cached = this.tokenCache.get(id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const { appId, privateKey } = this.credential();
    const jwt = createAppJwt(appId, privateKey);
    const res = await this.fetchFn(`${this.apiBase}/app/installations/${encodeURIComponent(id)}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new GitHubError(`Installation token request failed: ${res.status}`, res.status, "installation_token_failed");
    const body = (await res.json()) as { token: string; expires_at: string };
    this.tokenCache.set(id, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  private get apiBase(): string {
    return (this.config.apiBaseUrl ?? process.env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(/\/$/, "");
  }

  private async api<T>(method: string, path: string, body?: unknown, installationId?: string | number): Promise<T> {
    const token = await this.installationToken(installationId);
    const res = await this.fetchFn(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status === 403) {
      const retryAfter = res.headers.get("retry-after");
      throw new GitHubError(`GitHub rate limit / permission response ${res.status}${retryAfter ? ` (retry-after: ${retryAfter}s)` : ""}`, res.status, "rate_limited_or_denied");
    }
    if (!res.ok) throw new GitHubError(`GitHub ${method} ${path} failed: ${res.status}`, res.status, "github_request_failed");
    return (await res.json()) as T;
  }

  async getIssue(owner: string, repo: string, number: number, installationId?: string | number): Promise<GitHubIssue> {
    return IssueSchema.parse(await this.api("GET", `/repos/${owner}/${repo}/issues/${number}`, undefined, installationId));
  }

  async getRepository(owner: string, repo: string, installationId?: string | number): Promise<{ defaultBranch: string; cloneUrl: string }> {
    const data = await this.api<{ default_branch: string; clone_url: string }>("GET", `/repos/${owner}/${repo}`, undefined, installationId);
    return { defaultBranch: data.default_branch, cloneUrl: data.clone_url };
  }

  /** Creates a DRAFT pull request. This adapter exposes no merge capability at all. */
  async createDraftPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    installationId?: string | number;
  }): Promise<{ url: string; number: number }> {
    const pr = PullRequestSchema.parse(
      await this.api(
        "POST",
        `/repos/${input.owner}/${input.repo}/pulls`,
        {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: true,
        },
        input.installationId,
      ),
    );
    return { url: pr.html_url, number: pr.number };
  }

  /** Token for a single git push, used only inside the trusted control plane. Never logged. */
  async pushToken(installationId?: string | number): Promise<string> {
    return this.installationToken(installationId);
  }
}
