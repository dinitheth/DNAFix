# Replication Design — locked 2026-10-31 (maintainer-reviewed)

Status: **DESIGN ONLY. No replication run is authorized or started.** Execution requires explicit maintainer approval.

## Interpretation locked for eval-v1.2

> The experiment demonstrates that the DNA-aware pipeline produced a substantially better result on this task. It does **not** yet prove that Project DNA caused the improvement.

The baseline's catastrophic failure (literal `replace` inserted in place of an import) may reflect model execution variability, patch-generation failure, or a tooling problem. Causal attribution requires establishing which, through repetition under frozen conditions. **The baseline `replace` failure is retained in the results permanently. It will not be repaired manually, re-run selectively, or excluded after the fact.**

## Locked conditions (identical to eval-v1.2 unless a change is separately approved)

1. **Frozen coding conditions**: same prepared benchmark repository and base-commit procedure, same issue text, same prompts, same model for every role (`muse-wonder-1.0`, Responses transport, no reasoning override), same tools and patch contract, same permissions, same budgets (12 calls / 250,000 tokens / $3 per arm / 16,384 max output tokens per request with pre-request reservation), same hidden acceptance suite (A1–A5), same frozen ground truth (`BENCHMARK_REFERENCE.md`). No tuning between arms or between pairs.
2. **Reviewer evidence improved (reviewer-only change)**: the blind reviewer receives the base repository context (relevant source files), the diff, the executed test results, and the per-criterion acceptance results — instead of the diff alone as in v1–v1.2. The condition mapping stays sealed until all reviews for a pair are submitted. Deterministic test results remain authoritative over AI review.
3. **Explicit failure taxonomy** — every arm records exactly one terminal failure class when it does not complete:
   - `invalid-patch-generation` (model produced unparseable/corrupt patch content; eval-v1.2 baseline's `replace` import is the canonical example)
   - `patch-application-error` (anchor/scope/containment rejection)
   - `compilation-or-load-failure` (changed code cannot be imported/parsed)
   - `test-failure` (acceptance or regression suite executed and failed)
   - `repair-exhausted` (bounded repair attempts used without recovery)
   - `infrastructure-blocked` (environment/integration failure before or outside model control; eval-v1 DNA arm)
   - `budget-exceeded` (call/token/monetary ceiling)
   - `model-empty-response` (no usable structured output, incl. `status: incomplete`)
   "Agent failed" is not an acceptable category.
4. **Randomization and isolation**: execution order randomized per pair and recorded; separate worktrees, data directories, stores and conversation state per arm; the prepared repository is read-only shared input; no arm can observe the other's artifacts. Model ID, transport, pricing table and all configuration values are written into every run record (`EvaluationRunRecordSchema`).
5. **Narrow conclusions**: 3–5 replicated pairs on this benchmark measure **repeatability on this benchmark only**. Generalization requires the separate, previously unseen multi-module issue (step 2 of the maintainer's sequence), which will get its own frozen reference before any run. No quantitative performance claim before both stages complete.

## Preservation

eval-v1.2 artifacts (`docs/evaluation/runs/pilot-2026-10-30T22-17-51-113Z/`, `RESULTS-V1.2.md`, accepted at commit `cd7d41a`) are preserved exactly as they stand. Future pilots write to new run directories and new results documents; historical results are never overwritten or edited.

## Cost guardrail for the replication stage (to be confirmed at approval time)

Per-pair observed cost in eval-v1.2: baseline $1.2889 + DNA-aware $0.5525 ≈ **$1.84 per pair** at published Wonder rates. Five pairs ≈ $9.20 expected, bounded by the per-arm $3 ceilings (worst case $30). Meta Model API usage is billed separately from AWS credits.
