# Architecture

DNAFix is a modular monolith (ADR-0001) with separately runnable API, web and worker processes. Hexagonal ports/adapters: domain and application layers depend only on ports in `packages/contracts` and `packages/application`.

## Modules

| Package | Responsibility |
|---|---|
| `packages/contracts` | Zod schemas + inferred types for every external boundary (API, model output, patches, workflow, audit). |
| `packages/domain` | Pure logic: workflow state machine, plan/task validation, file-scope enforcement, overlap detection, acceptance evaluation. No I/O. |
| `packages/model-provider` | `ModelProvider` port; `MetaModelProvider` (Muse Wonder, Responses API); `ScriptedModelProvider` test double (tests/demo only, always labelled). |
| `packages/repository-intelligence` | `RepositoryIntelligence` port; `ProjectDNAAdapter` spawning the Project DNA bridge (ADR-0002). Never reimplements graph/impact logic. |
| `packages/git-engine` | Worktree lifecycle, diff collection, changed-path and overlap detection, ordered integration. |
| `packages/execution` | Command policy (argv allowlist, env scrub, timeouts, output caps), host runner (explicit dev opt-in), Docker runner (hardened flags). |
| `packages/verification` | Test discovery, baseline/post runs, diff-vs-impact comparison, verification report. |
| `packages/github` | GitHub App auth (RS256 JWT → installation token), user OAuth connection, repository/issue discovery with encryption and ETag caching, issue/PR REST adapter, webhook HMAC verification. |
| `packages/persistence` | `Store` port; JSON file store (dev default) and memory store (tests); Drizzle schema + SQL migration for PostgreSQL. |
| `packages/agent-orchestrator` | Lead-planner flow, coding-agent patch application under scope, verifier review, bounded repair loop. |
| `packages/application` | Use cases: CreateRun, ApprovePlan, ApprovePullRequest, CancelRun; the durable pipeline runner. |
| `apps/api` | Fastify REST + SSE, OpenAPI, authorization-by-repository checks on every resource. |
| `apps/web` | React + Vite + Tailwind dashboard reading real API state. |
| `apps/worker` | Pipeline processor; Temporal worker wiring when `TEMPORAL_ADDRESS` is set (ADR-0004). |

## Run lifecycle

`QUEUED → REPOSITORY_PREPARATION → BASELINE_VERIFICATION → PROJECT_DNA_ANALYSIS → IMPACT_ANALYSIS → ISSUE_PLANNING → AWAITING_PLAN_APPROVAL → AGENT_EXECUTION → TASK_INTEGRATION → FINAL_VERIFICATION → AWAITING_PR_APPROVAL → COMPLETED`, with `NEEDS_CLARIFICATION`, `BLOCKED`, `FAILED`, `CANCELLED`. Transitions are validated by `packages/domain/src/workflow.ts`; every transition writes an append-only audit event with actor, action, result and evidence reference.

## Evidence rule

A file is "affected" only with a repository path plus Project DNA or diff evidence; a test is "passed" only with a recorded command, exit code and output summary; a PR exists only with a real GitHub URL. Model hypotheses are stored separately from deterministic facts in the impact report (`source: "project-dna" | "model-hypothesis"`).

## Data flow (one run)

1. API creates a run (repository path or GitHub repo + issue text/number). A GitHub run may carry `issueUrl` and `githubInstallationId` provenance imported from the App; the API re-validates the installation, repository and issue before persisting it `QUEUED`.
2. Worker prepares a detached worktree at the pinned base commit, records baseline test results.
3. Project DNA bridge analyses that exact commit; snapshot stores repositoryId, analysisVersion, baseCommitSha, completeness/truncations.
4. Muse Wonder receives bounded evidence (architecture summary, impact results for model-nominated targets resolved against the real tree, relevant file excerpts) and returns a Zod-validated plan. Ambiguity → `NEEDS_CLARIFICATION`.
5. Human approves the plan (API). Coding tasks run in per-task worktrees (max 2 parallel, only when file scopes are disjoint); patches are validated operations, never shell strings.
6. Integration checks overlapping paths, integrates in dependency order, verifier compares actual diff vs predicted impact and re-runs tests. Failures enter the repair loop (max `MAX_REPAIR_ATTEMPTS`, default 2).
7. Human approves PR creation; GitHub adapter pushes branch `dnafix/run-<id>` and opens a **draft** PR. Never merges, never pushes to the default branch.
