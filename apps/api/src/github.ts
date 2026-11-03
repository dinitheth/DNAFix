import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  GitHubAuthError,
  GitHubError,
  GitHubIntegrationService,
  GitHubIssueDetailResult,
  GitHubIssuePage,
  GitHubNotConfiguredError,
  GitHubPermissionError,
  GitHubRepositorySummary,
  GitHubValidationError,
  SingleFlight,
  decryptSecret,
  encryptSecret,
  parseIssueReference,
  parseRepositoryReference,
} from "@dnafix/github";
import type { GitHubConnectionRecord, RepositoryRecord, Store } from "@dnafix/persistence";

export const GITHUB_SESSION_COOKIE = "dnafix_sid";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const REPOSITORY_CACHE_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Cookie helpers                                                     */
/* ------------------------------------------------------------------ */

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function readGitHubSessionId(req: Pick<FastifyRequest, "headers">): string | null {
  const value = parseCookies(req.headers.cookie)[GITHUB_SESSION_COOKIE];
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function secureCookies(): boolean {
  return process.env.NODE_ENV === "production" || (process.env.APP_BASE_URL ?? "").startsWith("https://");
}

function ensureSession(req: FastifyRequest, reply: FastifyReply): string {
  const existing = readGitHubSessionId(req);
  if (existing) return existing;
  const sessionId = randomBytes(32).toString("hex");
  reply.header(
    "set-cookie",
    `${GITHUB_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureCookies() ? "; Secure" : ""}`,
  );
  return sessionId;
}

/* ------------------------------------------------------------------ */
/* Connection manager                                                 */
/* ------------------------------------------------------------------ */

export interface GitHubProvenance {
  installationId: number;
  issueUrl: string | null;
  issueNumber: number | null;
  repositoryFullName: string;
}

export interface GitHubRepositoryPage {
  repositories: GitHubRepositorySummary[];
  owners: Array<{ login: string; type: string; avatarUrl: string | null }>;
  page: number;
  perPage: number;
  totalCount: number;
  hasNext: boolean;
  installation: { id: number; accountLogin: string };
  fetchedAt: string;
  cached: boolean;
}

export class GitHubConnectionManager {
  private readonly refreshFlights = new SingleFlight<string, GitHubConnectionRecord>();
  private readonly repositoryCache = new Map<string, { fetchedAt: number; repositories: GitHubRepositorySummary[] }>();

  constructor(
    readonly integration: GitHubIntegrationService,
    private readonly store: Store,
  ) {}

  private get encryptionKey(): Buffer {
    const key = this.integration.config.encryptionKey;
    if (!key) throw new GitHubNotConfiguredError(this.integration.missingConfiguration);
    return key;
  }

  private aad(sessionId: string, kind: "access" | "refresh"): string {
    return `dnafix:github:${sessionId}:${kind}-token`;
  }

  private encrypt(sessionId: string, kind: "access" | "refresh", value: string): string {
    return encryptSecret(value, this.encryptionKey, this.aad(sessionId, kind));
  }

  private decrypt(connection: GitHubConnectionRecord, kind: "access" | "refresh", payload: string): string {
    return decryptSecret(payload, this.encryptionKey, this.aad(connection.sessionId, kind));
  }

  private encryptedTokens(sessionId: string, tokens: { accessToken: string; accessTokenExpiresAt: string | null; refreshToken: string | null; refreshTokenExpiresAt: string | null }) {
    return {
      accessTokenCiphertext: this.encrypt(sessionId, "access", tokens.accessToken),
      refreshTokenCiphertext: tokens.refreshToken ? this.encrypt(sessionId, "refresh", tokens.refreshToken) : null,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    };
  }

  async getConnection(sessionId: string): Promise<GitHubConnectionRecord | null> {
    return this.store.getGitHubConnection(sessionId);
  }

  async status(sessionId: string) {
    const connection = await this.getConnection(sessionId);
    const now = Date.now();
    const accessExpired = Boolean(connection?.accessTokenExpiresAt && Date.parse(connection.accessTokenExpiresAt) <= now);
    const refreshUsable = Boolean(
      connection?.refreshTokenCiphertext &&
        connection.refreshTokenExpiresAt &&
        Date.parse(connection.refreshTokenExpiresAt) > now,
    );
    return {
      configured: this.integration.configured,
      missing: this.integration.missingConfiguration,
      appSlug: this.integration.config.slug,
      webBaseUrl: this.integration.webBaseUrl,
      connected: Boolean(connection),
      account: connection
        ? {
            id: connection.githubUserId,
            login: connection.login,
            name: connection.name,
            avatarUrl: connection.avatarUrl,
            htmlUrl: connection.htmlUrl,
          }
        : null,
      installation:
        connection?.installationId && connection.installationAccountLogin
          ? {
              id: connection.installationId,
              accountLogin: connection.installationAccountLogin,
              accountType: connection.installationAccountType,
            }
          : null,
      tokenExpiresAt: connection?.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: connection?.refreshTokenExpiresAt ?? null,
      authorizationExpired: Boolean(connection && accessExpired && !refreshUsable),
      lastVerifiedAt: connection?.lastVerifiedAt ?? null,
    };
  }

  async completeAuthorization(
    sessionId: string,
    tokens: {
      accessToken: string;
      accessTokenExpiresAt: string | null;
      refreshToken: string | null;
      refreshTokenExpiresAt: string | null;
      scopes: string[];
      tokenType: string;
    },
    requestedInstallationId?: number | null,
  ): Promise<GitHubConnectionRecord> {
    this.integration.assertConfigured();
    const user = await this.integration.getUser(tokens.accessToken);
    const installations = await this.integration.listInstallations(tokens.accessToken);
    let selected: (typeof installations)[number] | null = null;
    if (requestedInstallationId) {
      selected = installations.find((i) => i.id === requestedInstallationId) ?? null;
      if (!selected) throw new GitHubValidationError("The installation returned by GitHub is not accessible to the authenticated user. Nothing was linked.");
    } else if (installations.length === 1) {
      selected = installations[0]!;
    }
    const existing = await this.getConnection(sessionId);
    const now = new Date().toISOString();
    const encrypted = this.encryptedTokens(sessionId, tokens);
    const record: GitHubConnectionRecord = {
      id: existing?.id ?? `ghconn_${randomUUID().slice(0, 12)}`,
      sessionId,
      githubUserId: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      htmlUrl: user.htmlUrl,
      installationId: selected?.id ?? null,
      installationAccountLogin: selected?.accountLogin ?? null,
      installationAccountType: selected?.accountType ?? null,
      ...encrypted,
      scopes: tokens.scopes,
      tokenType: tokens.tokenType,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastVerifiedAt: now,
    };
    await this.store.saveGitHubConnection(record);
    return record;
  }

  private async refreshLocked(connection: GitHubConnectionRecord, force: boolean): Promise<GitHubConnectionRecord> {
    return this.refreshFlights.run(connection.sessionId, async () => {
      const fresh = await this.getConnection(connection.sessionId);
      if (!fresh) throw new GitHubAuthError("GitHub account is not connected. Connect GitHub to continue.");
      if (!force && fresh.accessTokenExpiresAt && Date.parse(fresh.accessTokenExpiresAt) > Date.now() + 60_000) return fresh;
      if (!fresh.refreshTokenCiphertext) {
        throw new GitHubAuthError("GitHub authorization expired and no refresh token is available. Reconnect your GitHub account.");
      }
      if (fresh.refreshTokenExpiresAt && Date.parse(fresh.refreshTokenExpiresAt) <= Date.now()) {
        throw new GitHubAuthError("The GitHub refresh token expired. Reconnect your GitHub account.");
      }
      const refreshToken = this.decrypt(fresh, "refresh", fresh.refreshTokenCiphertext);
      const tokens = await this.integration.refreshUserToken(refreshToken);
      const encrypted = this.encryptedTokens(fresh.sessionId, tokens);
      const updated: GitHubConnectionRecord = {
        ...fresh,
        ...encrypted,
        refreshTokenCiphertext: encrypted.refreshTokenCiphertext ?? fresh.refreshTokenCiphertext,
        refreshTokenExpiresAt: encrypted.refreshTokenExpiresAt ?? fresh.refreshTokenExpiresAt,
        updatedAt: new Date().toISOString(),
      };
      await this.store.saveGitHubConnection(updated);
      return updated;
    });
  }

  /** Decrypt a usable user token, refreshing through single-flight when needed. */
  async requireToken(sessionId: string): Promise<{ connection: GitHubConnectionRecord; token: string }> {
    this.integration.assertConfigured();
    const connection = await this.getConnection(sessionId);
    if (!connection) throw new GitHubAuthError("GitHub account is not connected. Connect GitHub to continue.");
    const expired = connection.accessTokenExpiresAt !== null && Date.parse(connection.accessTokenExpiresAt) <= Date.now() + 60_000;
    const fresh = expired ? await this.refreshLocked(connection, false) : connection;
    return { connection: fresh, token: this.decrypt(fresh, "access", fresh.accessTokenCiphertext) };
  }

  async forceRefresh(sessionId: string): Promise<GitHubConnectionRecord> {
    const connection = await this.getConnection(sessionId);
    if (!connection) throw new GitHubAuthError("GitHub account is not connected. Connect GitHub to continue.");
    const refreshed = await this.refreshLocked(connection, true);
    return refreshed;
  }

  async listInstallations(sessionId: string) {
    const { connection, token } = await this.requireToken(sessionId);
    const installations = await this.integration.listInstallations(token);
    const selectedStillExists = connection.installationId === null || installations.some((i) => i.id === connection.installationId);
    if (!selectedStillExists) {
      await this.store.saveGitHubConnection({
        ...connection,
        installationId: null,
        installationAccountLogin: null,
        installationAccountType: null,
        updatedAt: new Date().toISOString(),
      });
    }
    return { installations, selectedInstallationId: selectedStillExists ? connection.installationId : null, account: { login: connection.login } };
  }

  async selectInstallation(sessionId: string, installationId: number) {
    const { connection, token } = await this.requireToken(sessionId);
    const installation = await this.integration.verifyInstallation(token, installationId);
    const updated: GitHubConnectionRecord = {
      ...connection,
      installationId: installation.id,
      installationAccountLogin: installation.accountLogin,
      installationAccountType: installation.accountType,
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };
    await this.store.saveGitHubConnection(updated);
    this.repositoryCache.clear();
    return installation;
  }

  private async authorizedRepositories(sessionId: string, installationId?: number, refresh = false) {
    const { connection, token } = await this.requireToken(sessionId);
    const id = installationId ?? connection.installationId;
    if (!id) throw new GitHubValidationError("Select a GitHub App installation before browsing repositories.");
    if (connection.installationId !== null && connection.installationId !== id) {
      throw new GitHubPermissionError("That installation is not the verified installation for this DNAFix session.");
    }
    const installation = await this.integration.verifyInstallation(token, id);
    const key = `${sessionId}:${id}`;
    const cached = this.repositoryCache.get(key);
    if (!refresh && cached && Date.now() - cached.fetchedAt < REPOSITORY_CACHE_MS) {
      return { connection, token, installation, repositories: cached.repositories, cached: true, fetchedAt: cached.fetchedAt };
    }
    const repositories = await this.integration.listInstallationRepositories(token, id);
    const fetchedAt = Date.now();
    this.repositoryCache.set(key, { fetchedAt, repositories });
    return { connection, token, installation, repositories, cached: false, fetchedAt };
  }

  async searchRepositories(
    sessionId: string,
    input: { search?: string; owner?: string; visibility?: "all" | "public" | "private"; page: number; perPage: number; refresh?: boolean },
  ): Promise<GitHubRepositoryPage> {
    const state = await this.authorizedRepositories(sessionId, undefined, input.refresh);
    const search = input.search?.trim().toLowerCase() ?? "";
    const owner = input.owner?.trim().toLowerCase() ?? "";
    const visibility = input.visibility ?? "all";
    const filtered = state.repositories
      .filter((r) => (!search ? true : r.fullName.toLowerCase().includes(search) || (r.description ?? "").toLowerCase().includes(search)))
      .filter((r) => (!owner ? true : r.owner.toLowerCase() === owner))
      .filter((r) => (visibility === "all" ? true : visibility === "private" ? r.private : !r.private))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const page = Math.max(1, input.page);
    const perPage = Math.min(50, Math.max(1, input.perPage));
    const start = (page - 1) * perPage;
    const owners = [...new Map(state.repositories.map((r) => [r.owner.toLowerCase(), { login: r.owner, type: r.ownerType ?? "User", avatarUrl: r.ownerAvatarUrl }])).values()];
    return {
      repositories: filtered.slice(start, start + perPage),
      owners,
      page,
      perPage,
      totalCount: filtered.length,
      hasNext: start + perPage < filtered.length,
      installation: { id: state.installation.id, accountLogin: state.installation.accountLogin },
      fetchedAt: new Date(state.fetchedAt).toISOString(),
      cached: state.cached,
    };
  }

  private async repositoryAccess(sessionId: string, owner: string, repo: string) {
    const state = await this.authorizedRepositories(sessionId);
    const repository = state.repositories.find((r) => r.fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    if (!repository) {
      throw new GitHubPermissionError("This repository is not included in the selected GitHub App installation or your GitHub account cannot access it.");
    }
    const token = await this.integration.repositoryToken(state.installation.id, repository.id);
    return { ...state, repository, repositoryToken: token };
  }

  async selectRepository(sessionId: string, reference: string): Promise<{ repository: GitHubRepositorySummary; record: RepositoryRecord }> {
    const { owner, repo } = parseRepositoryReference(reference);
    const state = await this.authorizedRepositories(sessionId, undefined, true);
    const repository = state.repositories.find((r) => r.fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    if (!repository) {
      throw new GitHubPermissionError("This repository is not available through the selected installation. Install the App on it or choose another repository.");
    }
    const metadata = await this.integration.getRepository(await this.integration.repositoryToken(state.installation.id, repository.id), owner, repo);
    const id = `gh_${owner}_${repo}`.replaceAll(/[^a-zA-Z0-9-_]/g, "-");
    const existing = await this.store.getRepository(id);
    const record: RepositoryRecord = {
      id,
      localPath: existing?.localPath ?? null,
      githubOwner: owner,
      githubRepo: repo,
      defaultBranch: metadata.defaultBranch,
      lastAnalyzedCommitSha: existing?.lastAnalyzedCommitSha ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      githubInstallationId: state.installation.id,
    };
    await this.store.saveRepository(record);
    return { repository: metadata, record };
  }

  async listIssues(
    sessionId: string,
    owner: string,
    repo: string,
    filters: { state: "open" | "closed" | "all"; query?: string; page: number; perPage: number },
  ): Promise<GitHubIssuePage & { repositoryFullName: string }> {
    const access = await this.repositoryAccess(sessionId, owner, repo);
    const page = await this.integration.listIssues({
      token: access.repositoryToken,
      owner,
      repo,
      state: filters.state,
      page: filters.page,
      perPage: filters.perPage,
      query: filters.query,
    });
    return { ...page, repositoryFullName: access.repository.fullName };
  }

  async getIssue(sessionId: string, owner: string, repo: string, issueNumber: number, refresh: boolean): Promise<GitHubIssueDetailResult & { installationId: number }> {
    const access = await this.repositoryAccess(sessionId, owner, repo);
    const result = await this.integration.getIssueDetail({
      token: access.repositoryToken,
      owner,
      repo,
      issueNumber,
      refresh,
    });
    return { ...result, installationId: access.installation.id };
  }

  /** Re-verify GitHub provenance before accepting a run request. Never trusts browser fields. */
  async validateRunProvenance(
    sessionId: string,
    input: { githubOwner?: string; githubRepo?: string; issueNumber?: number; issueUrl?: string; githubInstallationId?: number },
  ): Promise<GitHubProvenance> {
    let owner = input.githubOwner;
    let repo = input.githubRepo;
    let issueNumber = input.issueNumber ?? null;
    if (input.issueUrl) {
      const parsed = parseIssueReference(input.issueUrl);
      if (owner && owner.toLowerCase() !== parsed.owner.toLowerCase()) throw new GitHubValidationError("The issue URL does not match the selected repository owner.");
      if (repo && repo.toLowerCase() !== parsed.repo.toLowerCase()) throw new GitHubValidationError("The issue URL does not match the selected repository.");
      owner = parsed.owner;
      repo = parsed.repo;
      if (issueNumber !== null && issueNumber !== parsed.issueNumber) throw new GitHubValidationError("The issue number does not match the issue URL.");
      issueNumber = parsed.issueNumber;
    }
    if (!owner || !repo) throw new GitHubValidationError("GitHub provenance requires githubOwner and githubRepo.");
    const access = await this.repositoryAccess(sessionId, owner, repo);
    if (input.githubInstallationId && input.githubInstallationId !== access.installation.id) {
      throw new GitHubPermissionError("The requested GitHub installation is not the verified installation for this session.");
    }
    let issueUrl: string | null = null;
    if (issueNumber !== null) {
      const detail = await this.integration.getIssueDetail({ token: access.repositoryToken, owner, repo, issueNumber });
      issueUrl = detail.issue.htmlUrl;
      issueNumber = detail.issue.number;
    }
    return { installationId: access.installation.id, issueUrl, issueNumber, repositoryFullName: access.repository.fullName };
  }

  async disconnect(sessionId: string): Promise<{ disconnected: true; userAuthorization: string; installationToken: string }> {
    const connection = await this.getConnection(sessionId);
    this.repositoryCache.clear();
    if (!connection) return { disconnected: true, userAuthorization: "not-connected", installationToken: "not-connected" };
    let userAuthorization = "revoked";
    let installationToken = "skipped";
    try {
      const accessToken = this.decrypt(connection, "access", connection.accessTokenCiphertext);
      await this.integration.revokeUserAuthorization(accessToken);
    } catch {
      userAuthorization = "revocation-failed";
    }
    if (connection.installationId) {
      try {
        const token = await this.integration.installationToken(connection.installationId);
        await this.integration.revokeInstallationToken(token);
        installationToken = "revoked";
      } catch {
        installationToken = "revocation-failed";
      }
    }
    await this.store.deleteGitHubConnection(sessionId);
    return { disconnected: true, userAuthorization, installationToken };
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

export interface GitHubRouteOptions {
  manager: GitHubConnectionManager;
  integration: GitHubIntegrationService;
}

function redirectUrl(webBaseUrl: string, path: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, webBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url.toString();
}

function pageParam(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function queryState(value: unknown): "open" | "closed" | "all" {
  return value === "closed" || value === "all" ? value : "open";
}

const ConnectBody = z.object({ returnTo: z.string().max(300).optional() }).default({});
const InstallationBody = z.object({ installationId: z.number().int().positive() });
const RepositoryBody = z.object({ repository: z.string().min(1).max(300) });

export function registerGitHubRoutes(app: FastifyInstance, options: GitHubRouteOptions): void {
  const { manager, integration } = options;
  const base = "/api/v1/integrations/github";

  app.get(`${base}/status`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    return manager.status(sessionId);
  });

  app.post(`${base}/connect`, async (req, reply) => {
    if (!integration.configured) return reply.code(503).send({ error: `GitHub App is not configured. Missing: ${integration.missingConfiguration.join(", ")}.`, code: "not_configured", missing: integration.missingConfiguration });
    const body = ConnectBody.parse(req.body ?? {});
    const sessionId = ensureSession(req, reply);
    return { authorizeUrl: integration.createAuthorizeUrl(sessionId, body.returnTo ?? "/new"), expiresInSeconds: 600 };
  });

  app.get(`${base}/callback`, async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const sessionId = readGitHubSessionId(req);
    if (!sessionId) return reply.redirect(redirectUrl(integration.webBaseUrl, "/new", { github: "error", github_code: "invalid_session" }));
    let returnTo = "/new";
    try {
      const state = integration.consumeState(query.state, sessionId, "oauth");
      returnTo = state.returnTo ?? "/new";
      if (query.error) {
        return reply.redirect(redirectUrl(integration.webBaseUrl, returnTo, { github: "denied", github_message: query.error_description ?? query.error }));
      }
      if (!query.code) throw new GitHubValidationError("GitHub did not return an authorization code.");
      const tokens = await integration.exchangeCode(query.code);
      const requestedInstallation = query.installation_id ? Number(query.installation_id) : null;
      await manager.completeAuthorization(sessionId, tokens, Number.isSafeInteger(requestedInstallation) ? requestedInstallation : null);
      return reply.redirect(redirectUrl(integration.webBaseUrl, returnTo, { github: "connected" }));
    } catch (err) {
      return reply.redirect(
        redirectUrl(integration.webBaseUrl, returnTo, {
          github: "error",
          github_code: err instanceof GitHubError ? err.code : "connection_failed",
          github_message: err instanceof Error ? err.message : "GitHub connection failed.",
        }),
      );
    }
  });

  app.get(`${base}/setup`, async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const sessionId = readGitHubSessionId(req);
    if (!sessionId) return reply.redirect(redirectUrl(integration.webBaseUrl, "/new", { github: "error", github_code: "invalid_session" }));
    if (query.setup_action === "request") {
      return reply.redirect(redirectUrl(integration.webBaseUrl, "/new", { github: "pending", github_message: "An organization owner must approve the GitHub App installation." }));
    }
    try {
      integration.consumeState(query.state, sessionId, "install");
      const installationId = Number(query.installation_id);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new GitHubValidationError("GitHub did not return a valid installation ID.");
      await manager.selectInstallation(sessionId, installationId);
      return reply.redirect(redirectUrl(integration.webBaseUrl, "/new", { github: "installed" }));
    } catch (err) {
      return reply.redirect(
        redirectUrl(integration.webBaseUrl, "/new", {
          github: "error",
          github_code: err instanceof GitHubError ? err.code : "installation_failed",
          github_message: err instanceof Error ? err.message : "GitHub installation failed.",
        }),
      );
    }
  });

  app.post(`${base}/installations/start`, async (req, reply) => {
    if (!integration.configured) return reply.code(503).send({ error: "GitHub App is not configured.", code: "not_configured", missing: integration.missingConfiguration });
    const sessionId = ensureSession(req, reply);
    return { installUrl: integration.createInstallUrl(sessionId) };
  });

  app.get(`${base}/installations`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    return manager.listInstallations(sessionId);
  });

  app.post(`${base}/installations/select`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    const body = InstallationBody.parse(req.body);
    const installation = await manager.selectInstallation(sessionId, body.installationId);
    return { installation };
  });

  app.get(`${base}/repositories`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    const query = req.query as Record<string, string | undefined>;
    const visibility = query.visibility === "public" || query.visibility === "private" ? query.visibility : "all";
    return manager.searchRepositories(sessionId, {
      search: query.search,
      owner: query.owner,
      visibility,
      page: pageParam(query.page, 1, 1000),
      perPage: pageParam(query.perPage, 20, 50),
      refresh: query.refresh === "true",
    });
  });

  app.post(`${base}/repositories/select`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    const body = RepositoryBody.parse(req.body);
    return manager.selectRepository(sessionId, body.repository);
  });

  app.get(`${base}/repositories/:owner/:repo/issues`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    const { owner, repo } = req.params as { owner: string; repo: string };
    const query = req.query as Record<string, string | undefined>;
    return manager.listIssues(sessionId, owner, repo, {
      state: queryState(query.state),
      query: query.q,
      page: pageParam(query.page, 1, 1000),
      perPage: pageParam(query.perPage, 20, 50),
    });
  });

  app.get(`${base}/repositories/:owner/:repo/issues/:number`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    const { owner, repo, number } = req.params as { owner: string; repo: string; number: string };
    const issueNumber = Number(number);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return reply.code(400).send({ error: "Issue number must be a positive integer.", code: "invalid_request" });
    const query = req.query as Record<string, string | undefined>;
    return manager.getIssue(sessionId, owner, repo, issueNumber, query.refresh === "true");
  });

  app.post(`${base}/refresh`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    const refreshed = await manager.forceRefresh(sessionId);
    return {
      refreshed: true,
      tokenExpiresAt: refreshed.accessTokenExpiresAt,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
      status: await manager.status(sessionId),
    };
  });

  app.post(`${base}/disconnect`, async (req, reply) => {
    const sessionId = ensureSession(req, reply);
    return manager.disconnect(sessionId);
  });
}
