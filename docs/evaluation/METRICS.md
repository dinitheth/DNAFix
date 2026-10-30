# Metrics Definitions (eval-v1)

All metrics are computed from recorded evidence (run records, diffs, test executions). Missing measurements are recorded as `null`/"unavailable", never estimated silently.

## Correctness
- `acceptance`: per-criterion pass/fail (A1–A5) from executing the hidden acceptance suite against the arm's patch in a fresh scoring worktree.
- `regression`: existing suite pass/fail + exit codes in the same scoring run.
- `newFailures`: tests that passed on the base commit but fail with the patch.

## Repository understanding (from the arm's plan + audit)
- `nominatedTargets`: files the planner asked to inspect/impact-check.
- `plannedScope`: union of task file scopes.
- `relevantModulesIdentified`: intersection of planned scope with ground-truth relevant modules.
- `unsupportedClaims`: reviewer-flagged claims in plan/patch summaries with no repository evidence (blind review rubric item).

## Change scope
- `changedFiles`, `relevantChanged` (changed ∩ acceptable), `unrelatedChanged` (changed − acceptable), `missingRequired` (required − changed).
- `precision = |changed ∩ acceptable| / |changed|`, `recall = coveredRequired / |required|` with `recallDetail` explaining the alternative-implementation rule (see BENCHMARK_REFERENCE.md).

## Verification quality
- Baseline vs final check results, verifier verdict, repair attempts, whether acceptance-relevant tests were executed by the pipeline itself (vs only in scoring).

## Efficiency
- Model calls, input/output/total tokens (summed from API `usage` per call; unavailable fields marked), estimated cost at the recorded pricing table, wall-clock duration, tool/patch operations, failed patch attempts (from task records), repair attempts.

## Comparison rules
- A smaller diff is not inherently better; correctness gates scope judgments.
- One matched pair supports observations, not statistical claims. Language in RESULTS.md must say "this pilot suggests / does not resolve", never "proves", unless replicated.
