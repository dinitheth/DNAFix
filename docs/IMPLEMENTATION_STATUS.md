# Implementation Status

Updated: 2026-10-31. This file is updated after each verification run; entries marked
UNTESTED have working implementations but were not executed in this environment.

## Environment constraints discovered

- Host Node is v24.13.0; Project DNA requires Node >=22.23.2 <23. A portable Node 22.23.2 runtime is used for all Project DNA work. DNAFix pins the same runtime (`.nvmrc`, `engines`).
- Docker CLI exists but the daemon is not running → Docker sandbox, PostgreSQL and Temporal via compose are UNTESTED here.
- No `MODEL_API_KEY` → real Muse Wonder calls UNTESTED (`pnpm model:smoke` is the gated smoke test).
- No GitHub App credentials → GitHub issue/PR flows UNTESTED against the real API (adapter covered by mocked-fetch contract tests).

## Stage status

| Stage | Status |
|---|---|
| 1. Architecture foundation | Implemented; verification results appended below after test run. |
| 2. Project DNA integration | Bridge implemented against the real `IProjectDNAService`; real-analysis test is env-gated (`PROJECT_DNA_PATH`). Result recorded below. |
| 3. Muse Wonder integration | **VERIFIED LIVE 2026-10-31**: `pnpm model:smoke` exit 0 against `https://api.meta.ai/v1/responses` (`muse-wonder-1.0`), and a complete API-driven run (`run_335bd754-004`) went planning → human plan approval → coding-agent patch (`price * (1 - percentOff / 100)`) → tests passed (exit 0) → verifier `approve` → human PR approval → `COMPLETED` with local patch delivery (GitHub unconfigured, `pullRequestUrl: null`, honestly recorded). |
| 4. Execution engine | Worktrees, scope-enforced patches, argv command policy, host + Docker runners implemented. Docker mode UNTESTED (daemon down); host mode exercised by tests. |
| 5. Verification and repair | Test discovery, baseline vs post-change runs, diff-vs-impact comparison, max-2 repair loop, verifier review implemented. |
| 6. GitHub delivery | GitHub App JWT adapter, webhook HMAC, draft-PR-only creation implemented; approval gate enforced in API + pipeline. Real API UNTESTED. |
| 7. Multi-agent | Max-2 parallel tasks with disjoint scopes, separate worktrees, overlap detection, ordered integration implemented; parallel logic unit-tested, pipeline sequential-integration path integration-tested. |
| 8. Final validation | See command results below. |

## Known limitations

- Single-user API auth is an optional bearer token (`DNAFIX_SESSION_TOKEN`); multi-user OAuth/GitHub login is future work.
- Local persistence defaults to a JSON file store; the PostgreSQL Drizzle schema + migration are provided (`pnpm db:migrate`) but the Postgres store adapter is not yet wired.
- Temporal workflow/activities are implemented; the default local engine is the in-process durable engine (ADR-0004). Temporal execution UNTESTED (no server).
- Project DNA bridge re-runs analysis for the impact pass (correctness over speed).
- Evaluation harness (`scripts/evaluate.ts`) requires a real model key; no comparison results are claimed.

## Verification results

Run 2026-10-31 under portable Node 22.23.2 + pnpm 9.15.4:

- `pnpm -r --if-present typecheck` → **exit 0** (all 15 workspace projects, incl. the fetch-based model provider with no unsafe casts).
- `pnpm vitest run` → **30 passed, 1 skipped, 0 failed** (9 files). Includes: domain state machine/scope/plan rules (9), command policy + host runner (4), GitHub webhook/JWT/draft-PR contract (3), model provider incl. mocked-fetch Meta transport, request-shape and schema-rejection tests (6), Project DNA adapter misconfiguration (1), git worktree lifecycle (2), CodeBuild provider with fake CLI (3), and the full offline pipeline integration test (fixture baseline test genuinely fails pre-fix, passes post-fix with exit code recorded; approval gates exercised; local-patch completion with `pullRequestUrl: null` because GitHub is unconfigured).
- Real Project DNA bridge test with `PROJECT_DNA_PATH` set to a checkout @ c8454b9: **passed in 8.7s** — the bridge analysed the fixture repo at the exact base commit and `getImpact()` for `src/discount.ts` surfaced `src/cart.ts` as impacted, matching the real import graph.
- `pnpm -r --if-present build` → **exit 0** (web production bundle built; api/worker typecheck builds pass).
- `pnpm model:smoke` → initially blocked (no key); **later verified live** for both `muse-wonder-1.0` and `muse-spark-1.3` once the user supplied `MODEL_API_KEY`, plus a complete live pipeline run — see stage 3 above.
- AWS: **authenticated** (`aws login`, account/project 121728644078, `AccountFullAccessRole`, selected Region ap-southeast-2; FREE plan, $180 credits to 2027-04-30). Agent Toolkit installed (24 skills, catalog verified); OpenCode MCP entry carries `AWS_MCP_PROXY_PROFILES=dnafix-dev` (as `environment`); starter rules in `AGENTS.md`. AWS MCP tools load in the next OpenCode session (per AWS guide), not this one. **Provisioned** (approved proposal): S3 bucket `dnafix-artifacts-121728644078` (private, encrypted, 14-day lifecycle), log group `/aws/codebuild/dnafix-build` (14-day retention), role `dnafix-codebuild-role`, CodeBuild project `dnafix-build` (small, 20-min cap, concurrency 1, no privileged mode). **Remote job execution is currently blocked**: all CodeBuild concurrency quotas are 0 on this FREE-plan project (`AccountLimitExceededException`); a quota increase to 1 (Linux/Small, request `4aee81ce64f447d9ad02c752d923a689`) is PENDING with AWS and may require upgrading the project to the paid plan in AWS Settings — a user decision. First remote job will be re-run as soon as the quota lands.
- Model cost note: the first smoke call returned 21,531 output tokens (the model enumerated acceptance-criteria paraphrases). Planning prompts now cap requirements/criteria/steps/tasks; the subsequent live run produced 2 acceptance criteria and 1 task.
- Role-based model split (user decision 2026-10-31): lead planner = Muse Wonder; coding + verification sub-agents = Muse Spark (`MUSE_SPARK_MODEL`, default `muse-spark-1.3`). Spark verified live on the same smoke (exit 0, 4,558 total tokens vs Wonder's 21,873 on the identical prompt). Typecheck exit 0; full suite 30 passed on re-run (one earlier run had 2 failures that did not reproduce and whose output was truncated — recorded as flaky, not hidden).
- Milestone 2 evaluation: pilot eval-v1 INVALID (DNA arm blocked by a pruned Project DNA workspace install; repaired and re-verified), pilot eval-v1.1 inconclusive (both arms failed at the second task for distinct engineering reasons) — see `docs/evaluation/RESULTS.md` and `RESULTS-V1.1.md`. An eval-v1.2 pair was launched under the user's earlier approval and is running untouched; its results are held for user review and are not treated as accepted. No further experiment will start without explicit approval.
- Hardening after eval findings: deny-by-default exact-path deletion allowlist sourced from plan-approved `approvedDeletions` (tested incl. audit + never-committed repair deletions); validated worktree reuse (`createOrReuseWorktree` — managed path, registration, branch/ownership, HEAD checks; unexpected git errors propagate; reset restricted to managed worktrees); `BudgetedModelProvider` with pre-request reservation, dynamic per-request output caps from remaining budget, $3 + 250k ceilings, and usage retained from incomplete responses (`incomplete_details.reason` surfaced).

## Remaining limitations

- Host-sandbox execution is acceptable only for the DNAFix-authored benchmark fixture; arbitrary external repositories await OS-level isolation (CodeBuild quota still 0 / case opened; Docker unavailable locally by user choice).
- Evaluation evidence remains n=1 per pilot; no statistical claims.
- Temporal and GitHub draft-PR paths remain untested against real services (no Temporal server run; no GitHub App credentials configured).

Defects found by tests and fixed during this run: OpenAI SDK parse-helper typing (transport rewritten), root workspace resolution for tests/scripts (vitest aliases + root tsconfig paths), Windows `.cmd` shim spawning in the host runner, CRLF-vs-LF patch anchors on Windows checkouts, fixture `node --test` directory form on Windows, a JWT test decoding bug.
