# Implementation Status

Updated: 2026-10-31 (stabilization review). This document is the single status record for DNAFix. Entries are marked **VERIFIED** (executed with recorded evidence), **IMPLEMENTED–UNTESTED** (code exists, not executed against the real service), or **BLOCKED** (external dependency outstanding). Where an early entry was superseded (for example, the model smoke test was initially blocked before a key was supplied and later verified live), only the final reconciled state is stated.

## Environment

- DNAFix pins Node `>=22.23.2 <23` (`.nvmrc`, `engines`) and pnpm 9.15.4, matching Project DNA. The host machine also has Node 24; all DNAFix verification below ran under a portable Node 22.23.2 runtime.
- Local machine has no Docker (user choice) and limited disk; remote execution is designed around AWS (below).
- AWS: authenticated via `aws login` (project 121728644078, `AccountFullAccessRole`, selected Region ap-southeast-2; FREE plan, $180 credits to 2027-04-30). Agent Toolkit installed; AWS MCP configured for OpenCode with `AWS_MCP_PROXY_PROFILES=dnafix-dev`; AWS MCP tools load in a fresh OpenCode session.

## Stage status

| Stage | Status |
|---|---|
| 1. Architecture foundation | **VERIFIED** — monorepo, contracts, domain, persistence port, Fastify API, React web; gates in the verification section. |
| 2. Project DNA integration | **VERIFIED** — bridge over the real `IProjectDNAService`; bridge test passes against a checkout @ c8454b9 (fixture analysed at the exact commit; `getImpact()` surfaced the real dependent). Analysis is recomputed for the impact stage (snapshot reuse is a known optimization, not yet implemented). |
| 3. Muse Wonder integration | **VERIFIED LIVE** — `pnpm model:smoke` exit 0 for `muse-wonder-1.0` (Responses API) and for `muse-spark-1.3`; complete live run `run_335bd754-004` reached `COMPLETED` through both human gates. (The smoke test was blocked until the user supplied `MODEL_API_KEY`; there is no remaining "untested model" state.) |
| 4. Execution engine | **VERIFIED (host mode)** for worktrees, scope-enforced patches, deletion allowlist, argv policy. Docker runner **IMPLEMENTED–UNTESTED** (no local Docker). |
| 5. Verification and repair | **VERIFIED** — baseline vs final checks with recorded exit codes, diff-vs-impact, verifier review, max-2 repair loop, repair-deletion guard with audit evidence. |
| 6. GitHub delivery | **IMPLEMENTED–UNTESTED** against the real GitHub API (no GitHub App credentials configured). Adapter is contract-tested with mocked fetch (JWT, webhook HMAC, draft-only payload; no merge method exists). Approval gates enforced. Verified runs without GitHub complete as local patch delivery with `pullRequestUrl: null`. |
| 7. Multi-agent | **VERIFIED at unit/integration level** — max-2 parallel disjoint-scope tasks, validated worktree reuse/reset, overlap detection, ordered integration. |
| 8. Final validation | **VERIFIED** — see the gate results below (re-run at every stabilization pass). |

## Verification results (latest full run)

- `pnpm -r --if-present typecheck` → **exit 0** (all workspace projects).
- `pnpm lint` → **exit 0**.
- `pnpm -r --if-present build` → **exit 0** (web production bundle; api/worker builds).
- `pnpm vitest run` → **46 passed, 1 skipped, 0 failed**. The skipped test is the env-gated real Project DNA bridge test, which passes when `PROJECT_DNA_PATH` is set (8.7s, verified separately). Coverage includes: domain rules, command policy/env scrubbing, budget reservation + dynamic caps + incomplete-response usage, GitHub contract, git worktree lifecycle incl. validated reuse/reset, CodeBuild provider (fake CLI), offline end-to-end pipeline, and the repair-deletion guard integration test.
- Live model evidence: Wonder smoke 21,873 total tokens (first call; planning prompts were subsequently capped) and Spark smoke 4,558 on the identical prompt; live run `run_335bd754-004` (patch, tests exit 0, verifier approve, COMPLETED).
- Repository: pushed to https://github.com/dinitheth/DNAFix (`main`: `6a7a3ba` codebase, `cd7d41a` accepted eval-v1.2 artifacts).

## Evaluation status (Milestone 2)

| Pilot | State |
|---|---|
| eval-v1 (`RESULTS.md`) | **INVALID** — DNA arm blocked by a pruned Project DNA workspace install (environment failure, since repaired and re-verified). Baseline failed; its repair loop deleted a core file, producing the deletion guard. |
| eval-v1.1 (`RESULTS-V1.1.md`) | **INCONCLUSIVE** — identical plans; both arms failed at the second task for distinct engineering reasons (dirty retry worktree; 8,192-token output cap). Fixes implemented and tested. |
| eval-v1.2 (`RESULTS-V1.2.md`) | **COMPLETED and ACCEPTED by the maintainer** as a recorded pilot outcome: DNA-aware COMPLETED (5/5 acceptance, 1 file changed, 33,934 tokens, $0.55) vs baseline BLOCKED (0/5, 2 repairs, 80,231 tokens, $1.29), same base commit, blind-reviewed. **n=1: exploratory only, no statistical claim.** No further experiment is running or will start without explicit approval. |

## Failures, flaky observations, and unverified integrations (kept separate from passes)

- **Flaky (non-reproducing)**: one early full-suite run reported 2 failures with truncated output that did not reproduce on re-run; one later run had a single failure under resource contention with a running pilot. All stabilization gate runs since are fully green. These are recorded, not hidden.
- **BLOCKED — CodeBuild execution**: project `dnafix-build`, bucket, log group and role are provisioned in ap-southeast-2 (approved), but all CodeBuild concurrency quotas are 0 on the FREE plan. Quota-increase request `4aee81ce64f447d9ad02c752d923a689` remains **pending/case opened** with AWS. No plan upgrade has been made and none will be made without approval; no additional resources will be provisioned.
- **IMPLEMENTED–UNTESTED**: Docker sandbox execution (no local Docker), Temporal execution (no server run; in-process durable engine is the verified default, ADR-0004), GitHub draft-PR creation against the real API, PostgreSQL store adapter (schema + migration provided; JSON file store is the current runtime), AWS MCP tools inside an agent session (configured; load in a fresh session).

## Limitations (preserved explicitly)

- **Host sandbox is not OS-level isolation.** It is acceptable only for the DNAFix-authored benchmark/fixture code. Arbitrary external repositories or untrusted build scripts must not be executed on the host; they require CodeBuild (quota pending) or properly restricted containers.
- **Real GitHub PR creation is unverified** — no credentials configured; verified runs deliver a local patch instead, recorded as such.
- **Temporal production execution is unverified** — workflow/activity code exists and typechecks; the exercised engine is the in-process durable engine.
- Single-user bearer-token API auth; no multi-user OAuth yet.
- Evaluation evidence is n=1 per pilot; results must not be quoted as statistical proof.
- Model usage/cost figures are estimates from API `usage` fields at published Standard-mode rates.

## Defects found by testing and fixed (historical record)

OpenAI SDK parse-helper typing (transport rewritten to typed fetch + local Zod validation, SDK removed); root workspace resolution for tests/scripts (vitest aliases + root tsconfig paths); Windows `.cmd` shim spawning in the host runner; CRLF-vs-LF patch anchors on Windows checkouts; fixture `node --test` directory form on Windows; JWT test decoding bug; eval TAP parser matching `# Subtest:` comment lines (fixed parser + deterministic re-scoring of saved patches); repair loop deleting core files (deny-by-default deletion allowlist); dirty retry worktrees (validated reuse + base reset); 8,192-token cap starving patch generation (raised to 16,384 with explicit incomplete-response accounting).
