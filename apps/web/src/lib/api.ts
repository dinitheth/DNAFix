const API = "/api/v1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly missing: string[] = [],
    readonly retryAt: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    let code: string | null = null;
    let missing: string[] = [];
    try {
      const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; missing?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
      else if (Array.isArray(parsed.error)) message = parsed.error.map((issue) => (typeof issue === "object" && issue && "message" in issue ? String((issue as { message: unknown }).message) : String(issue))).join("; ");
      else message = JSON.stringify(parsed.error ?? parsed);
      code = typeof parsed.code === "string" ? parsed.code : null;
      missing = Array.isArray(parsed.missing) ? parsed.missing.filter((value): value is string => typeof value === "string") : [];
    } catch {
      /* keep raw text */
    }
    throw new ApiError(`${res.status}: ${message}`, res.status, code, missing, res.headers.get("retry-after"));
  }
  return (await res.json()) as T;
}

export interface RepositoryRecord {
  id: string;
  localPath: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string | null;
  lastAnalyzedCommitSha: string | null;
  githubInstallationId?: number | null;
}

export interface ConfigStatus {
  model: { provider: string; modelId: string; subAgentModelId: string; configured: boolean; transport: string; baseUrl: string };
  projectDna: { configured: boolean; path: string | null };
  github: {
    configured: boolean;
    appConfigured?: boolean;
    userIntegrationConfigured?: boolean;
    missing?: string[];
    slug?: string | null;
  };
  sandboxMode: string;
  execution: { provider: string; remoteConfigured: boolean; project: string | null; bucket: string | null; region: string };
  workflowEngine: string;
  temporalAddress: string | null;
  store?: { kind: "sqlite" | "file"; location: string };
}

export interface VerificationCheckView {
  kind: string;
  status: string;
  result: { argv: string[]; exitCode: number | null; sandboxMode?: string } | null;
}

export interface Run {
  id: string;
  repositoryId: string;
  repositoryPath: string;
  issueTitle: string;
  issueBody: string;
  issueNumber: number | null;
  issueUrl?: string | null;
  githubInstallationId?: number | null;
  state: string;
  modelProvider: string;
  workflowEngine: string;
  baseCommitSha: string | null;
  repositorySnapshotId: string | null;
  changedPaths: string[];
  diff: string;
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
  error: string | null;
  repairAttempts: number;
  createdAt: string;
  updatedAt: string;
  analysis: { summary: string; requirements: string[]; acceptanceCriteria: string[]; ambiguities: string[]; assumptions: string[]; riskLevel: string } | null;
  plan: {
    tasks: Array<{ id: string; title: string; description: string; fileScope: string[]; dependsOn: string[]; acceptanceCriteria: string[]; testExpectations: string[] }>;
    predictedAffectedPaths: Array<{ path: string; source: string; reason: string; evidence?: string | null }>;
    unresolvedQuestions: string[];
    requiresHumanClarification: boolean;
  } | null;
  intelligence: {
    repositoryId: string;
    analysisVersion: number | null;
    architecture: { summary: string; layers: string[]; patterns: string[] };
    criticalComponents: Array<{ name: string; path: string | null; reason: string }>;
    risks: Array<{ title: string; severity: string; path: string | null }>;
    languages: string[];
    complete: boolean;
    warnings: string[];
    targets: Array<{ targetPath: string; directImpacted: string[]; transitiveImpacted: string[]; evidenceReasons: string[]; truncations: string[] }>;
  } | null;
  tasks: Array<{ taskId: string; status: string; worktreePath: string | null; branch: string | null; changedPaths: string[]; commitSha: string | null; patchSummary: string | null; attempts: number; error: string | null }>;
  verificationChecks: VerificationCheckView[] | null;
  baselineChecks: VerificationCheckView[];
  verifierReview: { verdict: string; summary: string; criteria: Array<{ criterion: string; status: string; evidence: string }>; unintendedChanges: string[]; missingTests: string[] } | null;
  remoteExecutions?: Array<{
    phase: string;
    provider: string;
    buildId: string | null;
    status: string;
    sourceSha256: string | null;
    containmentStatus?: string | null;
    lifecycleState?: string | null;
    deleteNotBefore?: string | null;
    logsReference: string | null;
  }>;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  result: string;
  evidence: string | null;
  createdAt: string;
}

/* ------------------------- GitHub integration ------------------------- */

export interface GitHubStatus {
  configured: boolean;
  missing: string[];
  appSlug: string | null;
  webBaseUrl: string;
  connected: boolean;
  account: { id: number; login: string; name: string | null; avatarUrl: string | null; htmlUrl: string } | null;
  installation: { id: number; accountLogin: string; accountType: string | null } | null;
  tokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  authorizationExpired: boolean;
  lastVerifiedAt: string | null;
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

export interface GitHubInstallationsResponse {
  installations: GitHubInstallation[];
  selectedInstallationId: number | null;
  account: { login: string };
}

export interface GitHubRepository {
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

export interface GitHubRepositoryPage {
  repositories: GitHubRepository[];
  owners: Array<{ login: string; type: string; avatarUrl: string | null }>;
  page: number;
  perPage: number;
  totalCount: number;
  hasNext: boolean;
  installation: { id: number; accountLogin: string };
  fetchedAt: string;
  cached: boolean;
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
  repositoryFullName: string;
}

export interface GitHubIssueDetailResponse {
  issue: GitHubIssueDetail;
  fetchedAt: string;
  validatedAt: string;
  cached: boolean;
  etag: string | null;
  installationId: number;
}

export interface GitHubConnectResponse {
  authorizeUrl: string;
  expiresInSeconds: number;
}

export interface GitHubSelectRepositoryResponse {
  repository: GitHubRepository;
  record: RepositoryRecord;
}

/* --------------------------- MCP connectors --------------------------- */

export type McpConnectionState =
  | "not-configured"
  | "not-detected"
  | "not-connected"
  | "connecting"
  | "connected"
  | "disabled"
  | "authentication-required"
  | "connection-error";

export type McpPermissionLevel = 1 | 2 | 3;
export type McpRisk = "low" | "medium" | "high";
export type McpAgentRole = "coding-agent" | "verification-agent";

export interface McpProfile {
  id: string;
  name: string;
  description: string | null;
  serverNames: string[];
}

export interface McpDetection {
  platform: string;
  hostLabel: string;
  supportedHost: boolean;
  cli: { available: boolean; path: string | null; version: string | null; error: string | null; wrapperOnly: boolean };
  desktop: { pluginAvailable: boolean; pluginVersion: string | null; running: boolean | null; statusDetail: string };
  toolkit: {
    available: boolean;
    version: string | null;
    enabled: boolean | null;
    featureDetail: string;
    gatewayAvailable: boolean;
    gatewayDetail: string;
  };
  profiles: McpProfile[] | null;
  profilesError: string | null;
  checkedAt: string;
  summary: string;
  nextAction: string | null;
}

export interface McpParameterSummary {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

export interface McpToolView {
  serverName: string;
  name: string;
  description: string;
  modelName: string;
  inputSchema: Record<string, unknown>;
  parameterSummary: McpParameterSummary[];
  permissionLevel: McpPermissionLevel;
  reviewed: boolean;
  schemaValid: boolean;
  enabled: boolean;
  allowedAgents: McpAgentRole[];
  reviewedLevel: McpPermissionLevel | null;
  risk: McpRisk;
  permissionLabel: string;
}

export interface McpServerView {
  name: string;
  description: string | null;
  enabled: boolean;
  allowedAgents: McpAgentRole[];
  toolCount: number;
  health: "reachable" | "no-tools-reported" | "not-connected";
}

export interface McpApproval {
  id: string;
  runId: string;
  connectionId: "docker-desktop-mcp";
  serverName: string;
  toolName: string;
  kind: "per-call" | "run-grant";
  permissionLevel: McpPermissionLevel;
  correlationId: string;
  argumentsRedacted: Record<string, unknown>;
  argumentsHash: string;
  summary: string;
  consequences: string;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface McpInvocation {
  id: string;
  correlationId: string;
  runId: string | null;
  connectionId: "docker-desktop-mcp";
  serverName: string;
  toolName: string;
  agent: McpAgentRole;
  modelId: string;
  permissionLevel: McpPermissionLevel;
  approvalId: string | null;
  approvalStatus: string;
  executed: boolean;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  success: boolean;
  argumentsRedacted: Record<string, unknown>;
  resultSummary: string | null;
  error: string | null;
}

export interface McpConnectorView {
  id: "docker-desktop-mcp";
  provider: "docker-desktop-mcp";
  state: McpConnectionState;
  enabled: boolean;
  reason: string;
  nextAction: string | null;
  profileId: string | null;
  selectedProfile: McpProfile | null;
  profiles: McpProfile[] | null;
  detection: McpDetection;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastHandshakeAt: string | null;
  gateway: { serverInfo: { name: string; version: string; description?: string }; capabilities: Record<string, unknown> } | null;
  servers: McpServerView[];
  tools: McpToolView[];
  resources: Array<{ uri: string; name: string; description: string | null }>;
  prompts: Array<{ name: string; description: string | null }>;
  serverCount: number;
  toolCount: number;
  enabledToolCount: number;
  inventory: { fetchedAt: string; fingerprint: string; warnings: string[] } | null;
  activity: McpInvocation[];
  approvals: McpApproval[];
  checkedAt: string;
}

export interface RunMcpView {
  approvals: McpApproval[];
  activity: McpInvocation[];
}
