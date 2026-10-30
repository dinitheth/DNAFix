# Pilot Results — eval-v1.2 (pilot-2026-10-30T22-17-51-113Z)

Status: **ACCEPTED by the maintainer (2026-10-31)** as the recorded outcome of this pilot, with the n=1 limitations stated below.
This is the first pilot in which both arms executed fully against the model. It is one matched pair (n=1): exploratory evidence, incapable of establishing statistical significance regardless of outcome.

Randomized order: dna-aware first, baseline second. Sealed mapping (opened after blind review): Patch A = baseline, Patch B = dna-aware.

## Comparison table

| Metric | Baseline | DNA-aware |
| --- | --- | --- |
| Final state | BLOCKED (verification failed after 2 repair attempts) | **COMPLETED** |
| Acceptance criteria satisfied (hidden suite, deterministic) | **0/5** | **5/5** |
| Regression tests passed (scoring run) | No | Yes |
| Relevant files identified (planning) | validator + service + test files (3 tasks) | service only (1 task) |
| Files actually changed | `order-service.ts`, `order-validator.ts`, 2 test files | `order-service.ts` only |
| Unrelated files modified | 0 (all within acceptable scope; precision 1.0) | 0 (precision 1.0) |
| Missing required changes | discount/tax/shipping logic absent or broken (recall 0.5) | none (recall 1.0) |
| Repair attempts | 2 (exhausted) | 0 |
| Model calls | 9 | 4 |
| Input tokens | 19,734 | 7,889 |
| Output tokens | 60,497 | 26,045 |
| Total tokens | 80,231 | 33,934 (−58%) |
| Execution time | 666 s | 230 s (−65%) |
| Estimated cost (Wonder $4/$20 per 1M) | $1.2889 | $0.5525 (−57%) |
| Budget compliance | within caps (no overshoot) | within caps |
| Pipeline verifier verdict | request-changes | approve |
| Independent blind review (Spark) | Patch A: **request-changes** — broken service import, no discount/tax/shipping logic | Patch B: **uncertain** — directionally correct; reviewer had no execution evidence (deterministic 5/5 is authoritative) |

## Measured facts

1. **Identical conditions verified**: both records carry base commit `430832e921198b4974957a06c238017b7ce981ba`, identical issue/config (`muse-wonder-1.0` all roles, caps 12 calls / 250k tokens / $3 / 16384 per request), deny-by-default deletion policy active. Baseline purity held (Project DNA never invoked; git-inspection snapshot recorded). DNA-aware provenance is real: planning snapshot `0d6c1e0a…@v1`, `complete: true`, no warnings, commit-bound. Impact-stage snapshot is `null`: the DNA-aware plan used a single task and nominated no separate impact targets, so no second analysis ran — the two-snapshot consistency question is moot for this run (single analysis, reused by construction of the flow).
2. **DNA-aware execution**: one task changed only `src/services/order-service.ts`, implementing promo lookup, discount-before-tax, shipping-on-discounted-subtotal, and unknown-code rejection inside the service (a ground-truth-acceptable location). Pipeline tests passed, verifier approved, zero repairs. Acceptance suite: A1–A5 all pass in an independent scoring worktree; regression suite passes.
3. **Baseline execution**: three tasks (validator, service, plus an added test-writing task), changed validator + service + two test files, verifier `request-changes`, two repair attempts exhausted → `BLOCKED`. Acceptance 0/5 and regression failures in scoring. One baseline task summary contains an unsupported claim ("Architectural Evidence: The Cache layer is bypassed by colluding formatters") — the benchmark repository has no cache layer or formatters; recorded as an unsupported-claim data point. The blind reviewer independently found a broken `OrderService` import (literal `replace` text) in the baseline diff.
4. **Efficiency**: DNA-aware used 58% fewer tokens, 57% lower estimated cost, 65% less wall-clock, fewer than half the model calls — while completing. This is a stage-complete comparison (both arms ran to their terminal state), but still n=1.
5. **Budgets**: neither arm approached the ceilings; no overshoot; `budgetExceeded: false` in both records. The pair ran under the static per-request cap (16384); the pre-request reservation/dynamic-cap provider (added after launch) did not apply to this pair.
6. **Isolation/blinding**: separate data roots/stores/worktrees; anonymization scrub passed; mapping sealed until the blind review was submitted; deterministic results and blind review agree on the winner of this pair.

## Reviewer judgments (not measurements)

- Blind AI review (Muse Spark): baseline `request-changes`, DNA-aware `uncertain` (correct direction, no execution evidence supplied to the reviewer). Supplementary only.
- Engineering judgment: this pilot is *consistent with* the hypothesis — DNA evidence coincided with a more surgical plan (1 file vs 4), first-attempt correctness, and materially lower usage. Confounders: model nondeterminism dominates at n=1; the baseline's failures (corrupted import, hallucinated summary) may be variance rather than information-driven; the benchmark remains small and grep-discoverable.

## Limitations

Everything in `docs/evaluation/LIMITATIONS.md`, plus: n=1 (no statistical significance); one benchmark, one issue; baseline quality may reflect sampling variance; DNA-aware impact stage unused (no nominated targets), so this pilot tests planning-stage DNA evidence more than impact-graph traversal; host sandbox (trusted fixture only).

## Conclusions (observations, not proof)

- For this single matched pair, the DNA-aware condition produced a correct, minimal, first-attempt implementation at roughly half the token cost and time, while the baseline failed to produce a working patch. That is the first completed-pair observation in DNAFix's favor.
- It does **not** establish that Project DNA generally improves Muse Wonder. Replication (repeated pairs, more tasks, ideally a larger real repository) is required before any such claim.
- Recommended next step (requires explicit approval): repeat the matched pair 3–5 times on this benchmark to gauge variance, then a second, larger benchmark, before drawing conclusions.
