import { z } from "zod";

/** Repository-relative POSIX path: no absolute paths, no traversal. */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p), "path must be repository-relative")
  .refine((p) => !p.split("/").includes(".."), "path must not contain '..'")
  .refine((p) => !p.includes("\\"), "path must use '/' separators");
export type RepoPath = z.infer<typeof RepoPathSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const IssueAnalysisSchema = z.object({
  summary: z.string().min(1),
  problemDescription: z.string().min(1),
  expectedBehavior: z.string().min(1),
  requirements: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  ambiguities: z.array(z.string()),
  assumptions: z.array(z.string()),
  riskLevel: RiskLevelSchema,
});
export type IssueAnalysis = z.infer<typeof IssueAnalysisSchema>;

export const AffectedPathSchema = z.object({
  path: RepoPathSchema,
  source: z.enum(["project-dna", "model-hypothesis", "diff"]),
  reason: z.string().min(1),
  evidence: z.string().nullable().default(null),
});
export type AffectedPath = z.infer<typeof AffectedPathSchema>;

export const ImplementationTaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/),
  title: z.string().min(1),
  description: z.string().min(1),
  expectedOutcome: z.string().min(1),
  fileScope: z.array(RepoPathSchema).min(1),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  testExpectations: z.array(z.string()).default([]),
  retryLimit: z.number().int().min(0).max(3).default(1),
  /**
   * Exact repository paths this task is explicitly approved to delete.
   * Human plan approval covers this list. Anything not listed may not be
   * deleted (deny-by-default deletion policy).
   */
  approvedDeletions: z.array(RepoPathSchema).optional(),
});
export type ImplementationTask = z.infer<typeof ImplementationTaskSchema>;

export const ValidationStepSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["test", "typecheck", "lint", "format"]),
  description: z.string().min(1),
});
export type ValidationStep = z.infer<typeof ValidationStepSchema>;

export const ImplementationPlanSchema = z.object({
  baseCommitSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  repositorySnapshotId: z.string().min(1),
  steps: z.array(z.object({ id: z.string().min(1), description: z.string().min(1) })).min(1),
  tasks: z.array(ImplementationTaskSchema).min(1).max(8),
  validationPlan: z.array(ValidationStepSchema).default([]),
  predictedAffectedPaths: z.array(AffectedPathSchema).default([]),
  unresolvedQuestions: z.array(z.string()).default([]),
  requiresHumanClarification: z.boolean().default(false),
});
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;

export const PlanGenerationOutputSchema = z.object({
  analysis: IssueAnalysisSchema,
  plan: ImplementationPlanSchema,
  nominatedTargets: z.array(RepoPathSchema).default([]),
});
export type PlanGenerationOutput = z.infer<typeof PlanGenerationOutputSchema>;

export const FilePatchOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), path: RepoPathSchema, content: z.string().max(200_000) }),
  z.object({
    type: z.literal("replace"),
    path: RepoPathSchema,
    search: z.string().min(1).max(50_000),
    replace: z.string().max(50_000),
  }),
  z.object({ type: z.literal("delete"), path: RepoPathSchema }),
]);
export type FilePatchOperation = z.infer<typeof FilePatchOperationSchema>;

export const PatchGenerationOutputSchema = z.object({
  summary: z.string().min(1),
  operations: z.array(FilePatchOperationSchema).min(1).max(50),
});
export type PatchGenerationOutput = z.infer<typeof PatchGenerationOutputSchema>;

export const VerifierReviewSchema = z.object({
  summary: z.string().min(1),
  verdict: z.enum(["approve", "request-changes", "uncertain"]),
  criteria: z.array(
    z.object({
      criterion: z.string().min(1),
      status: z.enum(["satisfied", "not-satisfied", "uncertain"]),
      evidence: z.string().min(1),
    }),
  ),
  unintendedChanges: z.array(z.string()).default([]),
  missingTests: z.array(z.string()).default([]),
});
export type VerifierReview = z.infer<typeof VerifierReviewSchema>;

/** Normalized Project DNA evidence. Deterministic facts only; model hypotheses live in the plan. */
export const ImpactTargetReportSchema = z.object({
  targetPath: RepoPathSchema,
  directImpacted: z.array(z.string()),
  transitiveImpacted: z.array(z.string()),
  evidenceReasons: z.array(z.string()),
  truncations: z.array(z.string()),
});
export type ImpactTargetReport = z.infer<typeof ImpactTargetReportSchema>;

export const RepositoryIntelligenceReportSchema = z.object({
  repositoryId: z.string().min(1),
  baseCommitSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  analysisVersion: z.number().int().nonnegative().nullable(),
  analyzedAt: z.string().min(1),
  architecture: z.object({
    layers: z.array(z.string()),
    patterns: z.array(z.string()),
    summary: z.string(),
  }),
  criticalComponents: z.array(z.object({ name: z.string(), path: z.string().nullable(), reason: z.string() })),
  risks: z.array(z.object({ title: z.string(), severity: z.string(), path: z.string().nullable() })),
  languages: z.array(z.string()),
  files: z.array(RepoPathSchema),
  targets: z.array(ImpactTargetReportSchema),
  workingTree: z
    .object({
      changedPaths: z.array(z.string()),
      impactedEntityIds: z.array(z.string()),
      unresolvedPaths: z.array(z.string()),
      complete: z.boolean(),
      warnings: z.array(z.string()),
    })
    .nullable()
    .default(null),
  complete: z.boolean(),
  warnings: z.array(z.string()),
});
export type RepositoryIntelligenceReport = z.infer<typeof RepositoryIntelligenceReportSchema>;

export const WORKFLOW_STATES = [
  "QUEUED",
  "REPOSITORY_PREPARATION",
  "BASELINE_VERIFICATION",
  "PROJECT_DNA_ANALYSIS",
  "IMPACT_ANALYSIS",
  "ISSUE_PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "NEEDS_CLARIFICATION",
  "AGENT_EXECUTION",
  "TASK_INTEGRATION",
  "FINAL_VERIFICATION",
  "AWAITING_PR_APPROVAL",
  "PULL_REQUEST_CREATION",
  "COMPLETED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;
export const WorkflowStateSchema = z.enum(WORKFLOW_STATES);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const CommandResultSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
  stdoutSummary: z.string().max(8_000),
  stderrSummary: z.string().max(8_000),
  sandboxMode: z.enum(["docker", "host", "codebuild"]),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const VerificationCheckSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["test", "typecheck", "lint", "format"]),
  status: z.enum(["passed", "failed", "skipped", "not-executed", "blocked", "pre-existing-failure"]),
  result: CommandResultSchema.nullable(),
  notes: z.string().default(""),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

/**
 * An explicit human decision to accept a check that failed before DNAFix
 * changed anything. Required evidence, because a pre-existing failure must
 * never be silently counted as a pass.
 */
export const VerificationWaiverSchema = z.object({
  checkId: z.string().min(1),
  reason: z.string().min(20),
  evidence: z.string().min(20),
  waivedBy: z.string().min(1),
  waivedAt: z.string().min(1),
});
export type VerificationWaiver = z.infer<typeof VerificationWaiverSchema>;

export const CreateRunRequestSchema = z.object({
  repositoryPath: z.string().min(1).optional(),
  githubOwner: z.string().min(1).optional(),
  githubRepo: z.string().min(1).optional(),
  issueTitle: z.string().min(1).max(500),
  issueBody: z.string().min(1).max(50_000),
  issueNumber: z.number().int().positive().optional(),
  baseRef: z.string().min(1).max(200).optional(),
  /** Verified GitHub App installation selected by the backend, never trusted from the browser without validation. */
  githubInstallationId: z.number().int().positive().optional(),
  /** Canonical GitHub issue URL retained as provenance for imported issues. */
  issueUrl: z.string().url().max(500).optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/** Machine-readable record for one evaluation arm (Milestone 2 experiment). */
export const EvaluationRunRecordSchema = z.object({
  experimentId: z.string().min(1),
  experimentVersion: z.string().min(1),
  condition: z.enum(["baseline", "dna-aware"]),
  executionOrder: z.number().int().min(1),
  runId: z.string().min(1),
  repository: z.object({
    fixture: z.string().min(1),
    baseCommitSha: z.string().regex(/^[0-9a-f]{7,64}$/i),
    treeHash: z.string().default(""),
    preparedAt: z.string().min(1),
  }),
  randomizationSeed: z.number().int().default(0),
  provenance: z
    .object({
      dnafixGitSha: z.string().nullable().default(null),
      dnafixDirty: z.boolean().default(false),
      projectDnaGitSha: z.string().nullable().default(null),
    })
    .default({}),
  issue: z.object({ title: z.string(), body: z.string() }),
  configuration: z.object({
    modelId: z.string(),
    subAgentModelId: z.string(),
    transport: z.string(),
    reasoningEffort: z.string().nullable(),
    maxRepairAttempts: z.number().int(),
    maxModelCalls: z.number().int(),
    maxTotalTokens: z.number().int(),
    maxCostUsd: z.number().nonnegative().default(0),
    maxOutputTokensPerRequest: z.number().int().nonnegative().default(0),
    sandboxMode: z.string(),
    workflowEngine: z.string(),
    intelligenceProvider: z.string(),
  }),
  intelligenceSnapshot: z
    .object({
      repositoryId: z.string().nullable(),
      analysisVersion: z.number().int().nullable(),
      snapshotId: z.string().nullable(),
      planningSnapshotId: z.string().nullable().default(null),
      impactSnapshotId: z.string().nullable().default(null),
      baseCommitSha: z.string().nullable().default(null),
      complete: z.boolean().nullable(),
      warnings: z.array(z.string()),
    })
    .nullable(),
  outcome: z.object({
    finalState: z.string(),
    error: z.string().nullable(),
    durationMs: z.number().nonnegative(),
    changedFiles: z.array(z.string()),
    diffPath: z.string().nullable(),
    repairAttempts: z.number().int(),
    tasks: z.array(
      z.object({
        taskId: z.string(),
        status: z.string(),
        changedPaths: z.array(z.string()),
        attempts: z.number().int(),
        patchSummary: z.string().nullable(),
        error: z.string().nullable(),
      }),
    ),
    plannedScope: z.array(z.string()),
    nominatedTargets: z.array(z.string()),
    baselineChecks: z.array(z.object({ kind: z.string(), status: z.string(), exitCode: z.number().nullable() })),
    verificationChecks: z.array(z.object({ kind: z.string(), status: z.string(), exitCode: z.number().nullable() })),
    verifierVerdict: z.string().nullable(),
    verifierReview: VerifierReviewSchema.nullable().default(null),
    failureClass: z
      .enum(["invalid-patch-generation", "patch-application-error", "compilation-or-load-failure", "test-failure", "infrastructure-blocked", "budget-exceeded", "model-empty-response"])
      .nullable()
      .default(null),
    recoveryStatus: z.enum(["not-needed", "recovered", "exhausted"]).default("not-needed"),
    failureEvents: z
      .array(z.object({ stage: z.string(), failureClass: z.string(), detail: z.string(), attempt: z.number().int() }))
      .default([]),
  }),
  usage: z.object({
    modelCalls: z.number().int(),
    calls: z.array(
      z.object({
        method: z.string(),
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        totalTokens: z.number().nullable(),
      }),
    ),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    totalTokens: z.number().int().nullable(),
    budgetExceeded: z.boolean(),
    pricing: z.object({ currency: z.literal("USD"), inputPerMillion: z.number(), outputPerMillion: z.number(), source: z.string() }),
    estimatedCostUsd: z.number().nullable(),
  }),
  scoring: z.object({
    acceptance: z.array(z.object({ id: z.string(), passed: z.boolean(), evidence: z.string() })),
    regressionPassed: z.boolean().nullable(),
    regressionExitCode: z.number().nullable(),
    acceptanceExitCode: z.number().nullable(),
    precision: z.number().nullable(),
    recall: z.number().nullable(),
    recallDetail: z.string(),
    relevantChanged: z.array(z.string()),
    unrelatedChanged: z.array(z.string()),
    missingRequired: z.array(z.string()),
  }),
  createdAt: z.string().min(1),
});
export type EvaluationRunRecord = z.infer<typeof EvaluationRunRecordSchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().nullable(),
  repositoryId: z.string().nullable(),
  actor: z.enum(["user", "lead-planner", "coding-agent", "verification-agent", "mcp-orchestrator", "system"]),
  action: z.string().min(1),
  result: z.enum(["ok", "error", "info"]),
  evidence: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/* ------------------------------------------------------------------ */
/* MCP connectors                                                       */
/* ------------------------------------------------------------------ */

/**
 * Connection states are deliberately explicit. `connected` is only ever
 * reported after a real MCP initialize handshake; it is never derived from
 * Docker CLI presence or a profile selection.
 */
export const MCP_CONNECTION_STATES = [
  "not-configured",
  "not-detected",
  "not-connected",
  "connecting",
  "connected",
  "disabled",
  "authentication-required",
  "connection-error",
] as const;
export const McpConnectionStateSchema = z.enum(MCP_CONNECTION_STATES);
export type McpConnectionState = z.infer<typeof McpConnectionStateSchema>;

export const McpAgentRoleSchema = z.enum(["coding-agent", "verification-agent"]);
export type McpAgentRole = z.infer<typeof McpAgentRoleSchema>;

export const McpPermissionLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type McpPermissionLevel = z.infer<typeof McpPermissionLevelSchema>;

export const McpRiskSchema = z.enum(["low", "medium", "high"]);
export type McpRisk = z.infer<typeof McpRiskSchema>;

export const McpProfileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "profile id must be alphanumeric with '.', '_' or '-'");

export const McpProfileSchema = z.object({
  id: McpProfileIdSchema,
  name: z.string(),
  description: z.string().nullable().default(null),
  serverNames: z.array(z.string()).default([]),
});
export type McpProfile = z.infer<typeof McpProfileSchema>;

export const McpParameterSummarySchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  description: z.string().nullable().default(null),
});
export type McpParameterSummary = z.infer<typeof McpParameterSummarySchema>;

export const McpToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .partial()
  .passthrough();
export type McpToolAnnotations = z.infer<typeof McpToolAnnotationsSchema>;

export const McpDiscoveredToolSchema = z.object({
  serverName: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Stable, sanitized name exposed to the model. The exact MCP name is preserved above. */
  modelName: z.string().regex(/^[A-Za-z0-9_.-]+$/).max(64),
  inputSchema: z.record(z.string(), z.unknown()),
  parameterSummary: z.array(McpParameterSummarySchema).default([]),
  annotations: McpToolAnnotationsSchema.nullable().default(null),
  permissionLevel: McpPermissionLevelSchema,
  /** True only when the explicit reviewed policy classified this tool. */
  reviewed: z.boolean(),
  schemaValid: z.boolean(),
});
export type McpDiscoveredTool = z.infer<typeof McpDiscoveredToolSchema>;

export const McpInventorySchema = z.object({
  gateway: z.object({
    name: z.string(),
    version: z.string(),
    instructions: z.string().nullable().default(null),
    capabilities: z.record(z.string(), z.unknown()).default({}),
  }),
  tools: z.array(McpDiscoveredToolSchema),
  resources: z.array(z.object({ uri: z.string(), name: z.string(), description: z.string().nullable().default(null) })).default([]),
  prompts: z.array(z.object({ name: z.string(), description: z.string().nullable().default(null) })).default([]),
  /** Server names reported by the selected Docker profile, when Docker CLI inspection succeeded. */
  profileServers: z.array(z.string()).default([]),
  fetchedAt: z.string().min(1),
  fingerprint: z.string().min(1),
  warnings: z.array(z.string()).default([]),
});
export type McpInventory = z.infer<typeof McpInventorySchema>;

export const McpConnectionRecordSchema = z.object({
  id: z.literal("docker-desktop-mcp"),
  provider: z.literal("docker-desktop-mcp"),
  profileId: z.string().nullable(),
  enabled: z.boolean(),
  state: McpConnectionStateSchema,
  lastError: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  lastHandshakeAt: z.string().nullable(),
  inventory: McpInventorySchema.nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type McpConnectionRecord = z.infer<typeof McpConnectionRecordSchema>;

export const McpToolPermissionRecordSchema = z.object({
  connectionId: z.literal("docker-desktop-mcp"),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  enabled: z.boolean(),
  allowedAgents: z.array(McpAgentRoleSchema),
  /** Explicit human review override. Null means only the built-in reviewed policy applies. */
  reviewedLevel: McpPermissionLevelSchema.nullable(),
  reviewedAt: z.string().nullable(),
  updatedAt: z.string().min(1),
});
export type McpToolPermissionRecord = z.infer<typeof McpToolPermissionRecordSchema>;

export const McpServerPermissionRecordSchema = z.object({
  connectionId: z.literal("docker-desktop-mcp"),
  serverName: z.string().min(1),
  enabled: z.boolean(),
  allowedAgents: z.array(McpAgentRoleSchema),
  updatedAt: z.string().min(1),
});
export type McpServerPermissionRecord = z.infer<typeof McpServerPermissionRecordSchema>;

export const McpApprovalRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  connectionId: z.literal("docker-desktop-mcp"),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  kind: z.enum(["per-call", "run-grant"]),
  permissionLevel: McpPermissionLevelSchema,
  correlationId: z.string().min(1),
  argumentsRedacted: z.record(z.string(), z.unknown()),
  argumentsHash: z.string().min(1),
  summary: z.string().min(1),
  consequences: z.string().min(1),
  status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]),
  requestedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});
export type McpApprovalRecord = z.infer<typeof McpApprovalRecordSchema>;

export const McpRunGrantRecordSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  connectionId: z.literal("docker-desktop-mcp"),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  permissionLevel: McpPermissionLevelSchema,
  workspaceScope: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type McpRunGrantRecord = z.infer<typeof McpRunGrantRecordSchema>;

export const McpInvocationRecordSchema = z.object({
  id: z.string().min(1),
  correlationId: z.string().min(1),
  runId: z.string().nullable(),
  connectionId: z.literal("docker-desktop-mcp"),
  serverName: z.string().min(1),
  toolName: z.string().min(1),
  agent: McpAgentRoleSchema,
  modelId: z.string(),
  permissionLevel: McpPermissionLevelSchema,
  approvalId: z.string().nullable(),
  approvalStatus: z.string(),
  /** True only when the gateway call was actually attempted after all checks. */
  executed: z.boolean().default(false),
  startedAt: z.string().min(1),
  completedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  success: z.boolean(),
  argumentsRedacted: z.record(z.string(), z.unknown()),
  resultSummary: z.string().max(4_000).nullable(),
  error: z.string().max(2_000).nullable(),
});
export type McpInvocationRecord = z.infer<typeof McpInvocationRecordSchema>;

export const McpApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});
export type McpApprovalDecision = z.infer<typeof McpApprovalDecisionSchema>;

export const McpPermissionUpdateSchema = z.object({
  serverName: z.string().min(1),
  toolName: z.string().min(1).optional(),
  enabled: z.boolean(),
  allowedAgents: z.array(McpAgentRoleSchema).optional(),
  /** Present only when a human explicitly reviewed an otherwise-unclassified tool. */
  reviewedLevel: McpPermissionLevelSchema.optional(),
});
export type McpPermissionUpdate = z.infer<typeof McpPermissionUpdateSchema>;

export const McpProfileSelectionSchema = z.object({ profileId: McpProfileIdSchema });
