# ADR-0005: Execution security — validated patches, argv allowlist, Docker-first sandbox

Status: Accepted (2026-10-31)

## Decision
- The model never gets a shell. It returns Zod-validated file-patch operations applied by trusted code inside the task's worktree and declared file scope only.
- Commands run as argv arrays (`shell:false`) against an allowlist with scrubbed environment, timeouts and output caps.
- `SANDBOX_MODE=docker` (default for test execution) uses `--network none --cap-drop ALL --security-opt no-new-privileges --read-only`, non-root, worktree-only mount, no Docker socket, no host credentials. Unavailable Docker = step fails closed.
- `SANDBOX_MODE=host` is an explicit development opt-in and is recorded as reduced isolation in every verification report it touches.
- GitHub push/PR operations stay in the trusted control plane; coding containers receive no tokens.

## Consequences
Prompt injection in repo/issue text cannot become host command execution through any product path; the residual risk of host mode is visible in evidence, not hidden.
