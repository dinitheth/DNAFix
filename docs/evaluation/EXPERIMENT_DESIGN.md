# Experiment Design — Does Project DNA intelligence improve Muse Wonder's engineering outcomes?

Version: eval-v1 (frozen 2026-10-31, before pilot results)

## Hypothesis
Providing Muse Wonder with Project DNA's deterministic repository intelligence (architecture, dependency impact, critical components, risks) improves repository understanding, change-scope accuracy and verification outcomes versus Muse Wonder acting as an ordinary repository-aware coding agent, at comparable token/execution budgets.

A negative or inconclusive result is a valid result.

## Audit of the previous harness (what `scripts/evaluate.mts` did before this milestone)
1. **Baseline leaked Project DNA data**: `NoImpactIntelligence` internally ran the real Project DNA analysis and only stripped `targets/criticalComponents/risks`. The planning prompt still received Project DNA's architecture summary, layers, patterns, languages, repository identity and file inventory. Not a valid baseline.
2. **Models were not identical across arms**: it used `createDefaultDeps()`, which (after the user's cost decision) mixes Muse Wonder (lead) with Muse Spark (sub-agents). For this experiment both arms use `muse-wonder-1.0` for every role.
3. **No token/cost recording**: only duration and coarse outcomes; `lastUsage` was never aggregated.
4. **No ground truth**: expected files were hardcoded to the old trivial discount task (`src/discount.ts`); no precision/recall, no acceptance tests.
5. **No isolation/blinding/schema**: arms shared the default file store; results were console JSON, not validated run records; fixed order (baseline first); no budget caps.
6. What it did correctly and is reused: sequential execution, the real `Pipeline`/`RunService`, approval-gate flow, real test execution, and the rule "no key → explicit blocker, no fabricated results".

## Conditions
- **A — Baseline**: issue + repository file inventory from `git ls-files` + file excerpts selected from that inventory + repo test/build info. **No** Project DNA invocation at all (the adapter is never constructed; a git-inspection stub implements the same port with architecture/critical/risks/targets empty and a warning stating no DNA analysis was performed).
- **B — DNA-aware**: identical, plus the real Project DNA report (architecture, critical components, risks, `getImpact()` results for model-nominated targets, completeness/truncation warnings verbatim).

## Controls (identical for both arms, recorded in each run record)
Same prepared benchmark repo + base commit SHA; same issue text; same model (`muse-wonder-1.0`, Responses transport, no reasoning-effort override); same pipeline, tools, patch contract and file-scope enforcement; max repair attempts = 2; HostCommandRunner sandbox (Docker daemon unavailable; CodeBuild concurrency quota = 0, checked once 2026-10-31, case CASE_OPENED — not polled again); separate MemoryStores, separate data roots and worktrees; sequential execution; **order randomized** by coin flip and recorded. Human approval gates are auto-approved by the harness after recording (the gate is part of the product flow, identical for both arms, and noted as a limitation).

## Budgets (hard stops, enforced by a metering wrapper)
Max 12 model calls/arm; max 250,000 total tokens/arm; pipeline timeout via existing bounds. Breach → arm recorded as `BLOCKED (budget)` with usage so far.

## Pricing
Muse Wonder Standard mode (dev.meta.ai/docs/pricing-rate-limits, checked 2026-10-31): input $4.00/1M, output $20.00/1M, cached input $0.20/1M. Costs are estimated from recorded usage at these rates; cached-token splits are marked unavailable when the API does not expose them. Meta usage is **not** covered by AWS credits.

## Scoring
Frozen benchmark reference: `docs/evaluation/BENCHMARK_REFERENCE.md` (written before the pilot). Deterministic scoring: apply each arm's diff to a fresh scoring worktree, copy in the hidden acceptance suite (`tests/fixtures/benchmark-acceptance/acceptance.test.mjs`, never shown to either agent), run the full suite + acceptance suite with recorded exit codes. Precision/recall computed against the acceptable scope (legitimate alternatives allowed — see reference). Independent review is blind: patches are exported as Patch A / Patch B with the condition mapping sealed in a separate file not given to the reviewer; an AI reviewer (Muse Spark, different model from both arms' executor... both arms execute on Wonder; reviewer is Spark) supplies a supplementary rubric assessment. Deterministic tests remain the authority.

## Artifacts
`docs/evaluation/runs/<experiment-id>/` — `baseline.json`, `dna-aware.json` (validated by `EvaluationRunRecordSchema` in `@dnafix/contracts`), `patch-A.diff`, `patch-B.diff`, `review-mapping.json` (sealed), `review.json`, `summary.json`. Historical results are never overwritten (each pilot gets a new experiment id).
