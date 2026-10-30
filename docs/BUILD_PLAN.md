# Build Plan

## Discovery findings (2026-10-31)

- Workspace was empty except the master build prompt. No existing DNAFix code, git repo, or lockfile.
- Host toolchain: Node v24.13.0, pnpm 10.33.2, git 2.52, Docker CLI present but daemon not running.
- Project DNA (github.com/dinitheth/Project-DNA @ c8454b9) inspected from a clean clone:
  - pnpm 9.15.4 monorepo, `engines.node >=22.23.2 <23`, `engine-strict=true`, `.node-version` 22.23.2.
  - Packages export TypeScript source (`"exports": "./src/index.ts"`); no published dist, no npm publication assumed.
  - Public service: `IProjectDNAService` composed of `IProjectDNAAnalyzer`, `IProjectDNAQuery`, `IProjectDNAEvolution`, `IProjectDNAEvents`, `IProjectDNAImpact.getImpact(target, options?, signal?)`, `IProjectDNAWorkingTreeImpact.getWorkingTreeImpact(options?, signal?)`, plus commit/PR impact sub-interfaces (`packages/dna-core/src/interfaces/project-dna-service.interface.ts:64-159` in the Project DNA checkout).
  - Composition root `apps/vscode-extension/src/container.ts` wires `ProjectDNAService` from `DNAOrchestrator`, engine packages and `SqliteStorage` (`@project-dna/storage`, better-sqlite3 native module).
  - Impact model is Zod-validated (`ImpactResultSchema`, bounded `maxDepth/maxEntities/maxEvidencePaths`, truncation reporting, `complete` flags on working-tree results).
- A portable Node 22.23.2 runtime was fetched to `%TEMP%\opencode\node22` for all Project DNA compatibility work. DNAFix pins the same runtime.
- Meta Model API docs (dev.meta.ai/docs/models, fetched 2026-10-31): `muse-wonder-1.0` is available on Model API (pay-as-you-go, Standard mode), supports Responses, Chat Completions and Messages endpoints, tool calling and structured output, 1,048,576-token context. Base URL `https://api.meta.ai/v1`, OpenAI SDK compatible. No `MODEL_API_KEY` is present in this environment, so a real model smoke test is blocked and recorded as such.
- Docker daemon unavailable → Docker sandbox and local Temporal/Postgres via compose cannot be executed here; both are implemented/documented and marked untested in IMPLEMENTATION_STATUS.md.

## Stages

1. Foundation: workspace, contracts, domain state machine, persistence port, Fastify API, React web. Exit: build + tests pass.
2. Project DNA integration: bridge process consuming a Project DNA checkout via its public service; snapshot bound to base commit SHA. Exit: real analysis of the fixture repo (requires Node 22 + Project DNA checkout; verified in this environment where possible).
3. Muse Wonder integration: `model-provider` package, Responses API, Zod-validated structured outputs, controlled patch tool contract. Exit: real plan when `MODEL_API_KEY` is set (blocked here, smoke test script provided); offline pipeline uses an explicitly-labelled scripted test double, never presented as Muse.
4. Execution: git worktree manager, command policy, host/docker sandbox runners, scope-enforced file patches.
5. Verification: test discovery, baseline + post-change runs, diff vs predicted impact, acceptance checks, max-2 repair loop, independent verifier review.
6. GitHub delivery: GitHub App JWT adapter, draft-PR creation only after explicit approval, webhook HMAC verification. Untested without credentials.
7. Multi-agent: up to 2 independent tasks, separate worktrees, overlap detection, ordered integration.
8. Validation: unit/contract/security/integration tests, production build, this plan's status doc.

## Non-goals for this build

- No auto-merge, no push to default branch, no fake counters or simulated agent activity in the product path.
- No Redis/Kafka/Kubernetes/vector DB.
