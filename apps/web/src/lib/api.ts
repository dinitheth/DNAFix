const API = "/api/v1";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      message = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error ?? parsed);
    } catch {
      /* keep raw text */
    }
    throw new Error(`${res.status}: ${message}`);
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
}

export interface ConfigStatus {
  model: { provider: string; modelId: string; subAgentModelId: string; configured: boolean; transport: string; baseUrl: string };
  projectDna: { configured: boolean; path: string | null };
  github: { configured: boolean };
  sandboxMode: string;
  execution: { provider: string; remoteConfigured: boolean; project: string | null; bucket: string | null; region: string };
  workflowEngine: string;
  temporalAddress: string | null;
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
