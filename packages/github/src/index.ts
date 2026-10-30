import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubNotConfiguredError extends GitHubError {
  constructor() {
    super("GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID required). No GitHub action was taken.");
    this.name = "GitHubNotConfiguredError";
  }
}

export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=") || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** GitHub App JWT (RS256), valid 9 minutes. Private key comes from env only and is never logged. */
export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${header}.${payload}.${signature}`;
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

export class GitHubAdapter {
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private readonly fetchFn: typeof fetch;
  constructor(private readonly config: GitHubConfig = {}) {
    this.fetchFn = config.fetchFn ?? fetch;
  }

  get configured(): boolean {
    return Boolean(
      (this.config.appId ?? process.env.GITHUB_APP_ID) &&
        (this.config.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY) &&
        (this.config.installationId ?? process.env.GITHUB_INSTALLATION_ID),
    );
  }

  private async installationToken(): Promise<string> {
    if (!this.configured) throw new GitHubNotConfiguredError();
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) return this.tokenCache.token;
    const appId = this.config.appId ?? process.env.GITHUB_APP_ID!;
    const privateKey = (this.config.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY!).replaceAll("\\n", "\n");
    const installationId = this.config.installationId ?? process.env.GITHUB_INSTALLATION_ID!;
    const jwt = createAppJwt(appId, privateKey);
    const res = await this.fetchFn(`${this.apiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new GitHubError(`Installation token request failed: ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`, res.status);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.tokenCache = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  private get apiBase(): string {
    return this.config.apiBaseUrl ?? process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.installationToken();
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
      throw new GitHubError(`GitHub rate limit / permission response ${res.status}${retryAfter ? ` (retry-after: ${retryAfter}s)` : ""}`, res.status);
    }
    if (!res.ok) throw new GitHubError(`GitHub ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    return (await res.json()) as T;
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return IssueSchema.parse(await this.api("GET", `/repos/${owner}/${repo}/issues/${number}`));
  }

  async getRepository(owner: string, repo: string): Promise<{ defaultBranch: string; cloneUrl: string }> {
    const data = await this.api<{ default_branch: string; clone_url: string }>("GET", `/repos/${owner}/${repo}`);
    return { defaultBranch: data.default_branch, cloneUrl: data.clone_url };
  }

  /** Creates a DRAFT pull request. This adapter exposes no merge capability at all. */
  async createDraftPullRequest(input: { owner: string; repo: string; title: string; body: string; head: string; base: string }): Promise<{ url: string; number: number }> {
    const pr = PullRequestSchema.parse(
      await this.api("POST", `/repos/${input.owner}/${input.repo}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: true,
      }),
    );
    return { url: pr.html_url, number: pr.number };
  }

  /** Token for a single git push, used only inside the trusted control plane. Never logged. */
  async pushToken(): Promise<string> {
    return this.installationToken();
  }
}
