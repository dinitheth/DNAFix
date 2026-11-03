import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  GitHubAuthError,
  GitHubError,
  GitHubInstallationSuspendedError,
  GitHubNotFoundError,
  GitHubNotConfiguredError,
  GitHubPermissionError,
  GitHubRateLimitError,
  GitHubValidationError,
} from "./errors.js";
import { createAppJwt, normalizePrivateKey } from "./jwt.js";
import { parseEncryptionKey } from "./crypto.js";

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

export interface GitHubAppConfig {
  appId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  privateKey: string | null;
  slug: string | null;
  userCallbackUrl: string | null;
  setupUrl: string | null;
  apiBaseUrl: string;
  oauthBaseUrl: string;
  apiVersion: string;
  webBaseUrl: string;
  encryptionKey: Buffer | null;
  missing: string[];
}

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve GitHub App configuration from the environment. Missing values are
 * reported explicitly; nothing is invented and no token is ever logged.
 */
export function loadGitHubAppConfig(env: Record<string, string | undefined> = process.env): GitHubAppConfig {
  const appBaseUrl = trimOrNull(env.APP_BASE_URL) ?? `http://localhost:${env.API_PORT ?? "3001"}`;
  const privateKey = normalizePrivateKey(trimOrNull(env.GITHUB_APP_PRIVATE_KEY_BASE64) ?? trimOrNull(env.GITHUB_APP_PRIVATE_KEY));
  const config: GitHubAppConfig = {
    appId: trimOrNull(env.GITHUB_APP_ID),
    clientId: trimOrNull(env.GITHUB_APP_CLIENT_ID),
    clientSecret: trimOrNull(env.GITHUB_APP_CLIENT_SECRET),
    privateKey,
    slug: trimOrNull(env.GITHUB_APP_SLUG),
    userCallbackUrl: trimOrNull(env.GITHUB_APP_USER_CALLBACK_URL) ?? `${appBaseUrl}/api/v1/integrations/github/callback`,
    setupUrl: trimOrNull(env.GITHUB_APP_SETUP_URL) ?? `${appBaseUrl}/api/v1/integrations/github/setup`,
    apiBaseUrl: (trimOrNull(env.GITHUB_API_BASE_URL) ?? "https://api.github.com").replace(/\/$/, ""),
    oauthBaseUrl: (trimOrNull(env.GITHUB_OAUTH_BASE_URL) ?? "https://github.com").replace(/\/$/, ""),
    apiVersion: trimOrNull(env.GITHUB_API_VERSION) ?? "2022-11-28",
    webBaseUrl: trimOrNull(env.WEB_ORIGIN) ?? "http://localhost:5173",
    encryptionKey: parseEncryptionKey(trimOrNull(env.GITHUB_TOKEN_ENCRYPTION_KEY)),
    missing: [],
  };
  const missing: string[] = [];
  if (!config.appId) missing.push("GITHUB_APP_ID");
  if (!config.clientId) missing.push("GITHUB_APP_CLIENT_ID");
  if (!config.clientSecret) missing.push("GITHUB_APP_CLIENT_SECRET");
  if (!config.privateKey) missing.push("GITHUB_APP_PRIVATE_KEY_BASE64 (or GITHUB_APP_PRIVATE_KEY)");
  if (!config.slug) missing.push("GITHUB_APP_SLUG");
  if (!config.encryptionKey) missing.push("GITHUB_TOKEN_ENCRYPTION_KEY (32-byte base64 or 64-char hex)");
  config.missing = missing;
  return config;
}

/** Runtime check for the user-facing integration (OAuth + App credentials + encryption). */
export function isGitHubIntegrationConfigured(config: GitHubAppConfig): boolean {
  return config.missing.length === 0;
}

/* ------------------------------------------------------------------ */
/* Public data shapes (no secrets)                                    */
/* ------------------------------------------------------------------ */

export interface GitHubTokenSet {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
  tokenType: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
}

export interface GitHubInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
  avatarUrl: string | null;
  repositorySelection: string;
  suspended: boolean;
  htmlUrl: string | null;
}

export interface GitHubRepositorySummary {
  id: number;
  owner: string;
  ownerAvatarUrl: string | null;
  ownerType: string | null;
  name: string;
  fullName: string;
  private: boolean;
  visibility: string;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  updatedAt: string;
  htmlUrl: string;
  cloneUrl: string;
}

export interface GitHubIssueLabel {
  name: string;
  color: string | null;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: { login: string; avatarUrl: string | null } | null;
  labels: GitHubIssueLabel[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  comments: number;
  htmlUrl: string;
}

export interface GitHubIssueDetail extends GitHubIssueSummary {
  body: string | null;
  closedAt: string | null;
  milestone: string | null;
  repositoryFullName: string;
  isPullRequest: false;
}

export interface GitHubIssuePage {
  items: GitHubIssueSummary[];
  page: number;
  perPage: number;
  hasNext: boolean;
  totalCount: number | null;
  source: "issues" | "search";
}

export interface GitHubIssueDetailResult {
  issue: GitHubIssueDetail;
  fetchedAt: string;
  validatedAt: string;
  cached: boolean;
  etag: string | null;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                 */
/* ------------------------------------------------------------------ */

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function assertOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_RE.test(owner)) throw new GitHubValidationError(`Invalid GitHub repository owner: ${JSON.stringify(owner)}`);
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") throw new GitHubValidationError(`Invalid GitHub repository name: ${JSON.stringify(repo)}`);
}

/** Accept `owner/repo` or a canonical `https://github.com/owner/repo` URL. Reject every other host. */
export function parseRepositoryReference(input: string): { owner: string; repo: string } {
  const value = input.trim();
  const url = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  const match = url ?? short;
  if (!match) throw new GitHubValidationError("Enter a repository as owner/repository or a canonical https://github.com/owner/repository URL.");
  const owner = match[1]!;
  const repo = match[2]!;
  assertOwnerRepo(owner, repo);
  return { owner, repo };
}

/** Accept a canonical GitHub issue URL only. */
export function parseIssueReference(input: string): { owner: string; repo: string; issueNumber: number } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d{1,10})(?:[?#/].*)?$/.exec(input.trim());
  if (!match) throw new GitHubValidationError("Enter a canonical GitHub issue URL: https://github.com/owner/repository/issues/123");
  const owner = match[1]!;
  const repo = match[2]!;
  const issueNumber = Number(match[3]);
  assertOwnerRepo(owner, repo);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new GitHubValidationError("Issue number must be a positive integer.");
  return { owner, repo, issueNumber };
}

export function parseIssueNumber(input: string | number): number {
  const value = typeof input === "number" ? input : Number(input.trim().replace(/^#/, ""));
  if (!Number.isSafeInteger(value) || value <= 0) throw new GitHubValidationError("Issue number must be a positive integer.");
  return value;
}

/* ------------------------------------------------------------------ */
/* Response schemas                                                   */
/* ------------------------------------------------------------------ */

const UserSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  html_url: z.string(),
});

const InstallationSchema = z.object({
  id: z.number(),
  account: z.object({
    login: z.string(),
    type: z.string().optional(),
    avatar_url: z.string().nullable().optional(),
  }),
  repository_selection: z.string().optional(),
  suspended_at: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
});

const RepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean().optional(),
  visibility: z.string().optional(),
  description: z.string().nullable().optional(),
  default_branch: z.string().optional(),
  language: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  html_url: z.string(),
  clone_url: z.string().optional(),
  owner: z.object({
    login: z.string(),
    type: z.string().optional(),
    avatar_url: z.string().nullable().optional(),
  }),
});

const LabelSchema = z.object({ name: z.string(), color: z.string().nullable().optional() });

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.string(),
  html_url: z.string(),
  user: z.object({ login: z.string(), avatar_url: z.string().nullable().optional() }).nullable().optional(),
  labels: z.array(z.union([LabelSchema, z.string()])).optional(),
  assignees: z.array(z.object({ login: z.string() })).nullable().optional(),
  milestone: z.object({ title: z.string() }).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().optional(),
  closed_at: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.number().nullable().optional(),
  refresh_token: z.string().nullable().optional(),
  refresh_token_expires_in: z.number().nullable().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

type RawIssue = z.infer<typeof IssueSchema>;

function toIsoFromSeconds(seconds: number | null | undefined, now: number): string | null {
  if (seconds === null || seconds === undefined) return null;
  return new Date(now + seconds * 1000).toISOString();
}

function mapRepository(raw: z.infer<typeof RepositorySchema>): GitHubRepositorySummary {
  return {
    id: raw.id,
    owner: raw.owner.login,
    ownerAvatarUrl: raw.owner.avatar_url ?? null,
    ownerType: raw.owner.type ?? null,
    name: raw.name,
    fullName: raw.full_name,
    private: raw.private ?? false,
    visibility: raw.visibility ?? (raw.private ? "private" : "public"),
    description: raw.description ?? null,
    defaultBranch: raw.default_branch ?? "main",
    language: raw.language ?? null,
    updatedAt: raw.updated_at ?? "",
    htmlUrl: raw.html_url,
    cloneUrl: raw.clone_url ?? `https://github.com/${raw.full_name}.git`,
  };
}

function mapIssue(raw: RawIssue): GitHubIssueSummary {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: raw.user ? { login: raw.user.login, avatarUrl: raw.user.avatar_url ?? null } : null,
    labels: (raw.labels ?? []).map((label) => (typeof label === "string" ? { name: label, color: null } : { name: label.name, color: label.color ?? null })),
    assignees: (raw.assignees ?? []).map((a) => a.login),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    comments: raw.comments ?? 0,
    htmlUrl: raw.html_url,
  };
}

function mapIssueDetail(raw: RawIssue, repositoryFullName: string): GitHubIssueDetail {
  return {
    ...mapIssue(raw),
    body: raw.body ?? null,
    closedAt: raw.closed_at ?? null,
    milestone: raw.milestone?.title ?? null,
    repositoryFullName,
    isPullRequest: false,
  };
}

function isPullRequest(raw: RawIssue): boolean {
  return raw.pull_request !== undefined && raw.pull_request !== null;
}

function parseNextLink(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return /rel="next"/.test(linkHeader);
}

/* ------------------------------------------------------------------ */
/* Single-flight helper (concurrent token refresh protection)          */
/* ------------------------------------------------------------------ */

export class SingleFlight<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  run(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.inFlight.size;
  }
}

/* ------------------------------------------------------------------ */
/* Service                                                            */
/* ------------------------------------------------------------------ */

interface OAuthState {
  sessionId: string;
  kind: "oauth" | "install";
  createdAt: number;
  expiresAt: number;
  returnTo: string | null;
}

interface CacheEntry {
  etag: string;
  issue: GitHubIssueDetail;
  fetchedAt: string;
  storedAt: number;
}

export interface GitHubIntegrationOptions {
  config?: GitHubAppConfig;
  fetchFn?: typeof fetch;
  now?: () => number;
  stateTtlMs?: number;
  timeoutMs?: number;
  installationTokenRefreshMs?: number;
  issueCacheTtlMs?: number;
  maxIssueCacheEntries?: number;
}

interface RequestOptions {
  method?: string;
  token?: string;
  appJwt?: boolean;
  /** Use HTTP Basic client credentials (only valid for OAuth grant revocation). */
  basicClientAuth?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
  context: string;
}

/**
 * Server-side GitHub App integration. All privileged calls live here; the
 * browser only ever receives normalized, token-free DTOs.
 */
export class GitHubIntegrationService {
  readonly config: GitHubAppConfig;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly stateTtlMs: number;
  private readonly timeoutMs: number;
  private readonly installationTokenRefreshMs: number;
  private readonly issueCacheTtlMs: number;
  private readonly maxIssueCacheEntries: number;
  private readonly states = new Map<string, OAuthState>();
  private readonly installationTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly issueCache = new Map<string, CacheEntry>();
  private readonly installationTokenFlights = new SingleFlight<string, string>();

  constructor(options: GitHubIntegrationOptions = {}) {
    this.config = options.config ?? loadGitHubAppConfig();
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.stateTtlMs = options.stateTtlMs ?? 10 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.installationTokenRefreshMs = options.installationTokenRefreshMs ?? 5 * 60 * 1000;
    this.issueCacheTtlMs = options.issueCacheTtlMs ?? 5 * 60 * 1000;
    this.maxIssueCacheEntries = options.maxIssueCacheEntries ?? 200;
  }

  get configured(): boolean {
    return isGitHubIntegrationConfigured(this.config);
  }

  get missingConfiguration(): string[] {
    return [...this.config.missing];
  }

  assertConfigured(): void {
    if (!this.configured) throw new GitHubNotConfiguredError(this.config.missing);
  }

  get webBaseUrl(): string {
    return this.config.webBaseUrl;
  }

  /* -------------------------- OAuth state -------------------------- */

  private pruneStates(): void {
    const now = this.now();
    for (const [state, record] of this.states) {
      if (record.expiresAt <= now) this.states.delete(state);
    }
  }

  createState(sessionId: string, kind: OAuthState["kind"], returnTo?: string | null): string {
    if (!sessionId) throw new GitHubValidationError("A DNAFix session is required before starting GitHub authorization.");
    this.pruneStates();
    const state = randomBytes(32).toString("base64url");
    const now = this.now();
    const safeReturn = returnTo && /^\/(?!\/)/.test(returnTo) ? returnTo : null;
    this.states.set(state, { sessionId, kind, createdAt: now, expiresAt: now + this.stateTtlMs, returnTo: safeReturn });
    return state;
  }

  /** Single-use, expiry-checked, session-bound state validation. */
  consumeState(state: string | undefined, sessionId: string | null, kind: OAuthState["kind"]): OAuthState {
    if (!state) throw new GitHubValidationError("Missing OAuth state. Restart the GitHub connection flow.");
    const record = this.states.get(state);
    if (!record) throw new GitHubValidationError("This GitHub authorization state is invalid, expired, or was already used. Restart the connection flow.");
    this.states.delete(state);
    if (record.expiresAt <= this.now()) {
      throw new GitHubValidationError("This GitHub authorization state expired. Restart the connection flow.");
    }
    if (record.kind !== kind) throw new GitHubValidationError("This GitHub authorization state was issued for a different step. Restart the connection flow.");
    if (!sessionId || record.sessionId !== sessionId) {
      throw new GitHubValidationError("This GitHub authorization state belongs to a different DNAFix session. Restart the connection flow.");
    }
    return record;
  }

  createAuthorizeUrl(sessionId: string, returnTo?: string | null): string {
    this.assertConfigured();
    const state = this.createState(sessionId, "oauth", returnTo);
    const params = new URLSearchParams({
      client_id: this.config.clientId!,
      redirect_uri: this.config.userCallbackUrl!,
      state,
      allow_signup: "false",
    });
    return `${this.config.oauthBaseUrl}/login/oauth/authorize?${params.toString()}`;
  }

  createInstallUrl(sessionId: string): string {
    this.assertConfigured();
    const state = this.createState(sessionId, "install");
    const params = new URLSearchParams({ state });
    return `${this.config.oauthBaseUrl}/apps/${encodeURIComponent(this.config.slug!)}/installations/new?${params.toString()}`;
  }

  /* ----------------------- User authorization ---------------------- */

  async exchangeCode(code: string): Promise<GitHubTokenSet> {
    this.assertConfigured();
    return this.tokenRequest({ code, redirect_uri: this.config.userCallbackUrl!, client_id: this.config.clientId!, client_secret: this.config.clientSecret! });
  }

  async refreshUserToken(refreshToken: string): Promise<GitHubTokenSet> {
    this.assertConfigured();
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
    });
  }

  private async tokenRequest(params: Record<string, string>): Promise<GitHubTokenSet> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.oauthBaseUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      throw new GitHubError(`GitHub authorization token request failed: ${(err as Error).name === "AbortError" ? "timeout" : "network error"}.`, undefined, "network_error");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: z.infer<typeof TokenResponseSchema>;
    try {
      parsed = TokenResponseSchema.parse(JSON.parse(text));
    } catch {
      throw new GitHubError(`GitHub authorization token response was not valid JSON (HTTP ${res.status}).`, res.status, "bad_response");
    }
    if (!res.ok || parsed.error) {
      const detail = parsed.error_description ?? parsed.error ?? `HTTP ${res.status}`;
      if (/bad_verification_code|expired|revoked/i.test(detail)) throw new GitHubAuthError(`GitHub authorization failed: ${detail}`);
      throw new GitHubError(`GitHub authorization failed: ${detail}`, res.status, "oauth_failed");
    }
    if (!parsed.access_token) throw new GitHubError("GitHub authorization response did not include an access token.", res.status, "bad_response");
    const now = this.now();
    return {
      accessToken: parsed.access_token,
      accessTokenExpiresAt: toIsoFromSeconds(parsed.expires_in, now),
      refreshToken: parsed.refresh_token ?? null,
      refreshTokenExpiresAt: toIsoFromSeconds(parsed.refresh_token_expires_in, now),
      scopes: parsed.scope ? parsed.scope.split(/[,\s]+/).filter(Boolean) : [],
      tokenType: parsed.token_type ?? "bearer",
    };
  }

  async getUser(accessToken: string): Promise<GitHubUser> {
    const raw = await this.requestJson("/user", { token: accessToken, context: "get authenticated user" });
    const user = UserSchema.parse(raw);
    return { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null, htmlUrl: user.html_url };
  }

  async listInstallations(accessToken: string): Promise<GitHubInstallation[]> {
    const installations: GitHubInstallation[] = [];
    for (let page = 1; page <= 10; page++) {
      const raw = z
        .object({ total_count: z.number().optional(), installations: z.array(InstallationSchema) })
        .parse(await this.requestJson(`/user/installations?per_page=100&page=${page}`, { token: accessToken, context: "list user installations" }));
      installations.push(
        ...raw.installations.map((i) => ({
          id: i.id,
          accountLogin: i.account.login,
          accountType: i.account.type ?? "User",
          avatarUrl: i.account.avatar_url ?? null,
          repositorySelection: i.repository_selection ?? "selected",
          suspended: Boolean(i.suspended_at),
          htmlUrl: i.html_url ?? null,
        })),
      );
      if (raw.installations.length === 0) break;
      if (raw.total_count !== undefined ? installations.length >= raw.total_count : raw.installations.length < 100) break;
    }
    return installations;
  }

  /** GitHub warns that setup callbacks can be spoofed; membership in this list is the proof. */
  async verifyInstallation(accessToken: string, installationId: number): Promise<GitHubInstallation> {
    const installations = await this.listInstallations(accessToken);
    const found = installations.find((i) => i.id === installationId);
    if (!found) {
      throw new GitHubPermissionError("The returned installation is not accessible to the authenticated GitHub user. Installation was not linked.");
    }
    if (found.suspended) throw new GitHubInstallationSuspendedError();
    return found;
  }

  /* ---------------------- Installation tokens --------------------- */

  async installationToken(
    installationId: number,
    options: { repositoryIds?: number[]; permissions?: Record<string, string> } = {},
  ): Promise<string> {
    this.assertConfigured();
    const key = `${installationId}:${(options.repositoryIds ?? []).join(",")}:${JSON.stringify(options.permissions ?? {})}`;
    const cached = this.installationTokens.get(key);
    if (cached && cached.expiresAt - this.installationTokenRefreshMs > this.now()) return cached.token;
    return this.installationTokenFlights.run(key, async () => {
      const cachedAgain = this.installationTokens.get(key);
      if (cachedAgain && cachedAgain.expiresAt - this.installationTokenRefreshMs > this.now()) return cachedAgain.token;
      const body: Record<string, unknown> = {};
      if (options.repositoryIds?.length) body.repositories = options.repositoryIds.map(String);
      if (options.permissions) body.permissions = options.permissions;
      const raw = await this.requestJson(`/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        appJwt: true,
        body,
        context: "create installation access token",
      });
      const parsed = z.object({ token: z.string(), expires_at: z.string() }).parse(raw);
      this.installationTokens.set(key, { token: parsed.token, expiresAt: Date.parse(parsed.expires_at) });
      return parsed.token;
    }).catch((err: unknown) => {
      if (err instanceof GitHubNotFoundError) throw new GitHubPermissionError("The GitHub App is not installed on that account, or the installation was removed.");
      throw err;
    });
  }

  /** Validate installation state and return a repository-scoped token. */
  async repositoryToken(installationId: number, repositoryId: number): Promise<string> {
    return this.installationToken(installationId, {
      repositoryIds: [repositoryId],
      permissions: { metadata: "read", contents: "read", issues: "read" },
    });
  }

  /* --------------------- Repositories and issues ------------------ */

  async listInstallationRepositories(accessToken: string, installationId: number): Promise<GitHubRepositorySummary[]> {
    const repositories: GitHubRepositorySummary[] = [];
    for (let page = 1; page <= 10; page++) {
      const raw = z
        .object({ total_count: z.number().optional(), repositories: z.array(RepositorySchema) })
        .parse(
          await this.requestJson(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, {
            token: accessToken,
            context: "list installation repositories",
          }),
        );
      repositories.push(...raw.repositories.map(mapRepository));
      if (raw.repositories.length === 0) break;
      if (raw.total_count !== undefined ? repositories.length >= raw.total_count : raw.repositories.length < 100) break;
    }
    return repositories;
  }

  async getRepository(accessToken: string, owner: string, repo: string): Promise<GitHubRepositorySummary> {
    assertOwnerRepo(owner, repo);
    const raw = await this.requestJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      token: accessToken,
      context: "get repository metadata",
    });
    return mapRepository(RepositorySchema.parse(raw));
  }

  async listIssues(input: {
    token: string;
    owner: string;
    repo: string;
    state: "open" | "closed" | "all";
    page: number;
    perPage: number;
    query?: string | null;
  }): Promise<GitHubIssuePage> {
    assertOwnerRepo(input.owner, input.repo);
    const { token, owner, repo, state, page, perPage, query } = input;
    const perPageClamped = Math.min(100, Math.max(1, perPage));
    const pageClamped = Math.max(1, page);
    const search = query?.trim();
    if (search) {
      const qualifiers = [`repo:${owner}/${repo}`, "is:issue"];
      if (state !== "all") qualifiers.push(`state:${state}`);
      const q = `${qualifiers.join(" ")} ${search}`.trim();
      const raw = z
        .object({ total_count: z.number(), incomplete_results: z.boolean().optional(), items: z.array(IssueSchema) })
        .parse(
          await this.requestJson(`/search/issues?q=${encodeURIComponent(q)}&per_page=${perPageClamped}&page=${pageClamped}`, {
            token,
            context: "search issues",
            headers: { Accept: "application/vnd.github+json" },
          }),
        );
      const items = raw.items.filter((i) => !isPullRequest(i)).map(mapIssue);
      return {
        items,
        page: pageClamped,
        perPage: perPageClamped,
        hasNext: pageClamped * perPageClamped < raw.total_count,
        totalCount: raw.total_count,
        source: "search",
      };
    }
    const res = await this.fetchApi(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=${perPageClamped}&page=${pageClamped}&sort=updated&direction=desc`,
      { token, context: "list issues" },
    );
    await this.ensureOk(res, "list issues");
    const raw = z.array(IssueSchema).parse(await res.json());
    const items = raw.filter((i) => !isPullRequest(i)).map(mapIssue);
    return {
      items,
      page: pageClamped,
      perPage: perPageClamped,
      hasNext: parseNextLink(res.headers.get("link")) || raw.length === perPageClamped,
      totalCount: null,
      source: "issues",
    };
  }

  async getIssueDetail(input: {
    token: string;
    owner: string;
    repo: string;
    issueNumber: number;
    refresh?: boolean;
  }): Promise<GitHubIssueDetailResult> {
    assertOwnerRepo(input.owner, input.repo);
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) throw new GitHubValidationError("Issue number must be a positive integer.");
    const key = `${input.owner}/${input.repo}#${input.issueNumber}`;
    const cached = this.issueCache.get(key);
    const useCache = cached && !input.refresh && this.now() - cached.storedAt < this.issueCacheTtlMs;
    const headers: Record<string, string> = {};
    if (useCache) headers["If-None-Match"] = cached.etag;
    const res = await this.fetchApi(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}`, {
      token: input.token,
      headers,
      context: "get issue details",
    });
    const nowIso = new Date(this.now()).toISOString();
    if (res.status === 304 && useCache) {
      return { issue: cached.issue, fetchedAt: cached.fetchedAt, validatedAt: nowIso, cached: true, etag: cached.etag };
    }
    await this.ensureOk(res, "get issue details");
    const raw = IssueSchema.parse(await res.json());
    if (isPullRequest(raw)) throw new GitHubValidationError(`#${input.issueNumber} is a pull request, not an issue.`);
    const issue = mapIssueDetail(raw, `${input.owner}/${input.repo}`);
    const etag = res.headers.get("etag");
    if (etag) {
      this.issueCache.set(key, { etag, issue, fetchedAt: nowIso, storedAt: this.now() });
      if (this.issueCache.size > this.maxIssueCacheEntries) {
        const oldest = [...this.issueCache.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
        if (oldest) this.issueCache.delete(oldest[0]);
      }
    }
    return { issue, fetchedAt: nowIso, validatedAt: nowIso, cached: false, etag };
  }

  clearIssueCache(): void {
    this.issueCache.clear();
  }

  /* --------------------------- Revocation -------------------------- */

  async revokeUserAuthorization(accessToken: string): Promise<void> {
    this.assertConfigured();
    const res = await this.fetchApi(`/applications/${encodeURIComponent(this.config.clientId!)}/grant`, {
      method: "DELETE",
      basicClientAuth: true,
      body: { access_token: accessToken },
      context: "revoke user authorization",
    });
    // 204 = revoked, 404 = already revoked. Anything else is reported but never blocks local disconnect.
    if (!res.ok && res.status !== 404) {
      throw new GitHubError(`GitHub authorization revocation returned HTTP ${res.status}.`, res.status, "revocation_failed");
    }
  }

  async revokeInstallationToken(installationToken: string): Promise<void> {
    const res = await this.fetchApi("/installation/token", {
      method: "DELETE",
      token: installationToken,
      context: "revoke installation token",
    });
    if (!res.ok && res.status !== 404) throw new GitHubError(`Installation token revocation returned HTTP ${res.status}.`, res.status, "revocation_failed");
  }

  /* ------------------------- HTTP plumbing ------------------------ */

  private async fetchApi(path: string, options: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let authorization: string;
      if (options.basicClientAuth) {
        if (!this.config.clientId || !this.config.clientSecret) throw new GitHubNotConfiguredError(this.config.missing);
        const encoded = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
        authorization = `Basic ${encoded}`;
      } else if (options.appJwt) {
        if (!this.config.appId || !this.config.privateKey) throw new GitHubNotConfiguredError(this.config.missing);
        authorization = `Bearer ${createAppJwt(this.config.appId, this.config.privateKey)}`;
      } else if (options.token) {
        authorization = `Bearer ${options.token}`;
      } else {
        throw new GitHubError("Refusing to make an unauthenticated GitHub API request.", undefined, "unauthenticated_request");
      }
      return await this.fetchFn(`${this.config.apiBaseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: authorization,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": this.config.apiVersion,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof GitHubError) throw err;
      const name = (err as Error).name;
      throw new GitHubError(`GitHub ${options.context} failed: ${name === "AbortError" ? "request timed out" : "network error"}.`, undefined, "network_error");
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestJson(path: string, options: RequestOptions): Promise<unknown> {
    const res = await this.fetchApi(path, options);
    await this.ensureOk(res, options.context);
    try {
      return await res.json();
    } catch {
      throw new GitHubError(`GitHub ${options.context} returned an unreadable response.`, res.status, "bad_response");
    }
  }

  private async ensureOk(res: Response, context: string): Promise<void> {
    if (res.ok) return;
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");
    const text = await res.text().catch(() => "");
    const rateLimited = res.status === 429 || retryAfter !== null || remaining === "0" || /rate limit/i.test(text);
    if (rateLimited) {
      const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
      const retry = retryAfter ? Number(retryAfter) : null;
      throw new GitHubRateLimitError(
        `GitHub rate limit reached while trying to ${context}.${resetAt ? ` The limit resets at ${resetAt}.` : ""}${retry ? ` Retry after ${retry}s.` : ""}`,
        resetAt,
        Number.isFinite(retry) ? retry : null,
      );
    }
    if (res.status === 401) throw new GitHubAuthError("GitHub authorization expired or was revoked. Reconnect your GitHub account.");
    if (res.status === 404 || res.status === 410) {
      throw new GitHubNotFoundError(`GitHub could not find the resource needed to ${context}. It may not exist or the installation may not have access.`);
    }
    if (res.status === 403) {
      throw new GitHubPermissionError(`GitHub denied permission to ${context}. Verify the App's Issues/Contents/Metadata read permissions and repository access.`);
    }
    if (res.status === 422) {
      throw new GitHubValidationError(`GitHub rejected the request to ${context} (HTTP 422).`);
    }
    if (res.status === 451) {
      throw new GitHubPermissionError(`GitHub blocked the request to ${context} for legal reasons.`);
    }
    throw new GitHubError(`GitHub request to ${context} failed with HTTP ${res.status}.`, res.status, res.status >= 500 ? "github_unavailable" : "github_error");
  }
}
