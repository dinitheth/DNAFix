# Security

## Trust boundaries

- Repository content, issue text, test output and model output are untrusted input.
- Trusted control plane: API, worker orchestration, GitHub token handling, Project DNA bridge invocation. Secrets (`MODEL_API_KEY`, GitHub App private key, webhook secret, DB URL, session secret) are read from environment only, never logged, never sent to the model, never stored in the database or audit log.

## Controls implemented

- **Tool/patch contract**: the model can only return Zod-validated structured data and file-patch operations (`create`/`replace`/`delete` with exact-match anchors). It never receives shell access. Patch paths are normalized, must stay inside the assigned worktree and inside the task's declared file scope (`packages/domain/src/scope.ts`); `..`, absolute paths, drive letters and symlink escapes are rejected (`packages/git-engine/src/paths.ts`, tested).
- **Command policy**: execution uses argv arrays via `spawn` with `shell:false`. Only allowlisted executables (`node`, `pnpm`, `npm`, `npx`, `git` read-only subsets) with per-command argument validation; environment is scrubbed to an allowlist (no `MODEL_API_KEY`, no GitHub credentials, no host env passthrough). Timeouts and output caps enforced (`packages/execution`).
- **Sandbox**: preferred mode `SANDBOX_MODE=docker` runs `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --read-only` with only the worktree mounted and a non-root user. If Docker is unavailable the run fails closed. `SANDBOX_MODE=host` exists for local development only and is loudly recorded in the verification report as reduced isolation.
- **Worktrees**: deterministic names from validated run/task IDs; creation pinned to the recorded base commit; cleanup refuses to delete a worktree with an active task.
- **GitHub**: App authentication with short-lived installation tokens; webhook payloads verified with HMAC-SHA256 (`timingSafeEqual`) before parsing; PR creation requires a recorded human approval event and always creates a draft; branch names are generated, never model-supplied.
- **API**: every resource access checks repository ownership scope (`repositoryId` on the run/record); request bodies are Zod-validated; SSE streams are read-only.
- **Prompt injection**: issue/repository text is passed to the model as data inside a delimited evidence block; system instructions state repository instructions cannot override tool policy. Tool policy is enforced in code, not by the prompt.

## Cloud execution boundaries (honest scope of per-run IAM isolation)

Per-run IAM roles confine what extracted build credentials can do inside AWS (one run's S3 prefixes + its log group, revoked then deleted after each build). They are **not** operating-system or network isolation:

- A malicious build can read its own build environment, including the per-run role credentials, and can use the default CodeBuild network egress to contact external systems (including exfiltrating those scoped credentials, which remain usable until the post-build revocation takes effect).
- CodeBuild runs with privileged mode disabled and no DNAFix secrets in the build environment; dependency installation (`pnpm`/`npm`) currently requires public package-registry egress, so egress cannot simply be switched off without a dependency strategy (registry proxy/mirror or a VPC design with NAT and egress allowlisting — AWS-side work requiring maintainer approval, not yet implemented).
- Stronger isolation for arbitrary untrusted repositories additionally requires the Stage C live verification and, for production, the scoped control-plane identity in `docs/security/CONTROL_PLANE_POLICY.md` (proposal, not applied).

## Known limitations

- Single-user local deployment: session auth is a bearer `DNAFIX_SESSION_TOKEN` for the API in this build; multi-user OAuth is future work (recorded in IMPLEMENTATION_STATUS).
- Host sandbox mode provides process-level, not container, isolation.
- Docker sandbox and GitHub App flows are implemented but untested in this environment (daemon down, no credentials).
