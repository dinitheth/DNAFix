# ADR-0002: Project DNA integration via out-of-process bridge

Status: Accepted (2026-10-31)

## Context
Project DNA publishes TypeScript source (`exports: ./src/index.ts`), pins Node >=22.23.2 <23 with engine-strict, uses pnpm workspace internals and a native sqlite module, and is a VS Code-extension-oriented monorepo. Adding it as a DNAFix workspace member would couple both repos' toolchains and force dependency changes in Project DNA, which the brief forbids.

## Decision
`ProjectDNAAdapter` spawns a bridge script (run with tsx under Node 22) that imports the public `IProjectDNAService` from a checkout supplied via `PROJECT_DNA_PATH`, constructs it exactly as Project DNA's own `apps/vscode-extension/src/container.ts` does, and returns Zod-validated JSON bound to the analysed commit SHA. DNAFix never reimplements graph construction or impact analysis, and never modifies Project DNA.

## Consequences
Independent maintainability for both repos; integration failure is explicit (`BLOCKED`) rather than simulated. Cost: analysis latency of a process spawn per run, acceptable for issue-to-PR workflows.
