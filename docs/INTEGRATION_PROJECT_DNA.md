# Project DNA Integration

## What was inspected

Project DNA @ `c8454b909cb74e900d74d8fee07dc538450b01b2` (2026-10-31 clone):

- `IProjectDNAService` (`packages/dna-core/src/interfaces/project-dna-service.interface.ts`) composes analyzer/query/evolution/events sub-interfaces plus `IProjectDNAImpact.getImpact()` and `IProjectDNAWorkingTreeImpact.getWorkingTreeImpact()`. DNAFix depends only on these public interfaces — it does not import engine internals.
- Composition pattern copied from `apps/vscode-extension/src/container.ts:48-127`: `ProjectDNAService` is constructed from `DNAOrchestrator` + engine packages + `SqliteStorage`.
- Packages publish TypeScript source (`exports: ./src/index.ts`), require Node `>=22.23.2 <23` with `engine-strict=true`, pnpm 9.15.4. `@project-dna/storage` needs the better-sqlite3 native module.
- Impact results are Zod schemas with explicit bounds and truncation records; working-tree impact reports `complete`, `truncations`, `unresolvedPaths` and before/after analysis versions. DNAFix surfaces all of these verbatim and never upgrades an incomplete result to a "complete blast radius" claim.

## Integration boundary (ADR-0002)

Project DNA is **not** a DNAFix workspace dependency and is never modified. `ProjectDNAAdapter` spawns a bridge process:

```
node --import tsx packages/repository-intelligence/bridge/project-dna-bridge.ts
  --root <worktree> --targets <paths...> --changed <paths...>
```

- Env: `PROJECT_DNA_PATH` = absolute path to a Project DNA checkout with dependencies installed (`pnpm install` under Node 22).
- The bridge resolves `@project-dna/*` from that checkout's `node_modules`/workspace via a generated tsconfig `paths` mapping, constructs the service exactly as the VS Code container does, runs `analyze()`, `getArchitecture()`, `getCriticalComponents()`, `getRisks()`, `getImpact({kind:'file',path})` per resolved target, and `getWorkingTreeImpact()` for changed paths, then prints one JSON document to stdout.
- DNAFix validates bridge output with Zod (`packages/repository-intelligence/src/bridge-schema.ts`) and binds it to the run's `baseCommitSha` (verified with `git rev-parse HEAD` in the analysed worktree before accepting results). Version mismatch → run is `BLOCKED`, results are not reused.
- If `PROJECT_DNA_PATH` is unset or the bridge fails, the run is `BLOCKED` with the exact error. There is no fallback fake analysis.

## Setup

```bash
# sibling checkout, kept independent
git clone https://github.com/dinitheth/Project-DNA ../Project-DNA
cd ../Project-DNA && nvm use 22.23.2 && corepack pnpm install
# DNAFix .env
PROJECT_DNA_PATH=C:\path\to\Project-DNA
```

## Verification status

See IMPLEMENTATION_STATUS.md for the actual bridge test result in this environment.
