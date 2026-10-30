# Pilot Results — eval-v1.1 (pilot-2026-10-30T22-04-58-288Z)

## Verdict up front

**Inconclusive for the hypothesis — again — but for informative reasons.** Both arms now executed with the model (the v1 environment failure is gone), both produced identical plans, both completed task T1, and both then failed at task T2 (`src/services/order-service.ts`) for *different* reasons. Neither produced an integrated patch, so the headline comparison (patch correctness on the full issue) cannot be scored. One genuine, blind-reviewed difference did appear at task level (below). A single matched pilot cannot establish statistical significance in any case.

Randomized order: dna-aware first, baseline second. Sealed mappings were opened only after blind reviews: integrated Patch A = dna-aware, B = baseline (both empty); task-patch A = dna-aware T1, B = baseline T1.

## Comparison table

| Metric | Baseline | DNA-aware |
| --- | --- | --- |
| Acceptance criteria satisfied | 0/5 meaningful (A5 trivially passes: no integrated patch) | 0/5 meaningful (same) |
| Relevant files identified (planning) | `order-validator.ts` + `order-service.ts` (exact ground truth) | `order-validator.ts` + `order-service.ts` (exact ground truth) |
| Unrelated files modified | 0 unrelated; T1 patch **deleted** `order-validator.ts` | 0; T1 patch was a clean +4/−1 change |
| Regression tests passed | scoring suite passes trivially (empty integrated patch) | same |
| Repair attempts | 0 (blocked before verification) | 0 |
| Input tokens | (see record) total 21,253 | total 12,119 |
| Output tokens | (see record) | (see record) |
| Execution time | 228 s | 218 s |
| Estimated cost | $0.3507 | $0.1792 |
| Independent review | Integrated patch (empty): request-changes. Task patch B (its T1): **request-changes** (file deletion) | Integrated patch (empty): request-changes. Task patch A (its T1): **uncertain** (correct partial step, full issue unproven) |

Token/cost comparison is **stage-partial**: both arms stopped at T2, DNA-aware after fewer calls. It must not be read as "DNA is cheaper per completed task" — neither task completed.

## Measured facts

1. **Identical conditions**: both records carry base commit `639252b68e2f91b4bd64a642c9e35ca6951a4386` (same prepared repo as v1), identical issue, `muse-wonder-1.0` for all roles, caps 12 calls/250k tokens/$3/8192-per-request. Baseline purity held (git-inspection snapshot, Project DNA never invoked). DNA-aware provenance is real: snapshot `2375d040…@v1`, `complete: true`, no warnings; commit binding enforced by the adapter.
2. **Two-stage DNA snapshots**: the run record retains only the final (impact-stage) snapshot; the planning-stage snapshot ID was not persisted separately (in-memory audit is lost at process exit). Both bridge invocations analyse the same worktree commit with a fresh service, so both report version 1 — consistent, but this pilot cannot *prove* stage-to-stage consistency from its own artifacts. Harness amendment recorded: persist both snapshot IDs in the run record.
3. **Plans were identical in scope** (validator → service), so on this benchmark, planning did not differentiate the conditions.
4. **T1 divergence (blind-reviewed)**: DNA-aware's T1 imports `lookupPromoPercent` from the registry and adds exactly the unknown-code rejection (+4/−1). Baseline's T1 commit nets to **deleting `src/validation/order-validator.ts`** while claiming to add validation. (This pair ran under the pre-hardening deletion policy — boolean, default-permit. The deny-by-default allowlist now in `main` would have rejected baseline's T1 delete outright, since no deletions were plan-approved.)
5. **T2 failures differ**:
   - Baseline: the model's patch tried to delete `src/services/order-service.ts` (a delete-then-rewrite pattern); the retry then failed with `delete: file not found` because **task retries reuse the dirty worktree** instead of resetting to the base commit. New product finding, recorded below.
   - DNA-aware: `Muse Wonder returned no text output for dnafix_patch` on both attempts — with `max_output_tokens: 8192`, reasoning + structured output can exhaust the cap and yield an incomplete response with no `output_text`. The v1.1 per-request cap, introduced to bound cost overshoot, is too tight for Wonder patch generation on this task size. New harness/product finding.
6. **Budgets**: neither arm approached the ceilings (max $0.35 of $3). No overshoot. The post-launch pre-request reservation amendment did not apply to this pair (it was added after launch, deliberately not injected).
7. **Isolation/blinding**: separate data roots/worktrees/stores; anonymization scrub passed for both patch sets; mapping sealed until reviews were submitted; deterministic scoring (empty integrated patches) agrees with the blind reviewer on the integrated outcome.

## Reviewer judgments (not measurements)

- Blind AI review (Muse Spark): integrated patches both `request-changes` (empty). Task patches: A (DNA-aware) `uncertain` — a correct, minimal partial implementation; B (baseline) `request-changes` — file deletion. Consistent with direct diff inspection.
- Engineering judgment: the T1 difference is the first observed instance consistent with the hypothesis (DNA evidence → more surgical change), but it is one task in one arm of one pilot, confounded by model nondeterminism. It is a lead, not evidence of a general advantage.

## Product/harness findings (independent of the hypothesis)

1. **Retry worktrees are not reset**: a failed task attempt leaves the worktree dirty; retries must recreate or hard-reset the worktree to the pinned base commit. (Would have changed baseline's T2 outcome.)
2. **8192 output cap too small for Wonder patch calls**: raise per-request cap for patch generation (e.g., 16384) or use a separate, larger patch budget; record `status: incomplete` responses explicitly instead of the generic "no text output".
3. **Persist both DNA snapshot IDs** (planning + impact) in evaluation run records.
4. The deny-by-default deletion allowlist (already implemented and tested) directly addresses the baseline T1/T2 deletion pattern observed here in *both* pilots.

## Limitations

All of `docs/evaluation/LIMITATIONS.md`, plus: n=1; both arms incomplete, so full-issue correctness, scope precision/recall and repair behavior remain unmeasured; token comparison is stage-partial; this pair ran under the since-replaced deletion policy.

## Conclusions

- Hypothesis: **still unresolved**. Planning parity, one favorable task-level signal for DNA-aware, no completed implementations to compare.
- Recommended next step (requires explicit approval; nothing has been started): fix findings 1–3, then run **one** fresh matched pair (eval-v1.2) on the same frozen benchmark. Estimated cost from this pilot's data: under $1 in model usage for both arms.
