# Replication Design — locked 2026-10-31 (maintainer-reviewed)

Status: **DESIGN ONLY. No replication run is authorized or started.** Execution requires explicit maintainer approval.

## Harness version decision (maintainer-approved 2026-10-31)

Replication runs under the current hardened implementation as **`replication-v1.3`** — the eval-v1.2 results are **not** an exact implementation replay and must not be presented as one. The v1.2 code is not rolled back. Differences between the code that executed eval-v1.2 and replication-v1.3 (coding prompts, acceptance tests, issue text, model IDs and budget constants are **unchanged**):

| Area | eval-v1.2 execution | replication-v1.3 |
| --- | --- | --- |
| Budget enforcement | static per-request cap (8192→16384), post-response metering | `BudgetedModelProvider`: pre-request reservation + dynamic output caps + post-response checks |
| Worktree reuse | catch-fallback reuse + reset | validated reuse (`createOrReuseWorktree`: registration/branch/HEAD checks), unexpected git errors propagate |
| Deletion policy | deny-by-default exact-path allowlist | unchanged |
| Failure recording | free-text error only | structured `failureClass` / `recoveryStatus` / ordered `failureEvents` |
| Reviewer evidence | diff only (`checks: []`) | anonymized review packets: repo context + executed checks + A1–A5 results |
| Provenance | base commit SHA only | + DNAFix Git SHA & dirty flag, Project DNA Git SHA, benchmark tree hash, randomization seed |

Readiness must be re-audited against these eight areas before any pair is authorized.

## Interpretation locked for eval-v1.2

> The experiment demonstrates that the DNA-aware pipeline produced a substantially better result on this task. It does **not** yet prove that Project DNA caused the improvement.

The baseline's catastrophic failure (literal `replace` inserted in place of an import) may reflect model execution variability, patch-generation failure, or a tooling problem. Causal attribution requires establishing which, through repetition under frozen conditions. **The baseline `replace` failure is retained in the results permanently. It will not be repaired manually, re-run selectively, or excluded after the fact.**

## Locked conditions (identical to eval-v1.2 unless a change is separately approved)

1. **Frozen coding conditions**: same prepared benchmark repository and base-commit procedure, same issue text, same prompts, same model for every role (`muse-wonder-1.0`, Responses transport, no reasoning override), same tools and patch contract, same permissions, same budgets (12 calls / 250,000 tokens / $3 per arm / 16,384 max output tokens per request with pre-request reservation), same hidden acceptance suite (A1–A5), same frozen ground truth (`BENCHMARK_REFERENCE.md`). No tuning between arms or between pairs.
2. **Reviewer evidence improved (reviewer-only change)**: the blind reviewer receives the base repository context (relevant source files), the diff, the executed test results, and the per-criterion acceptance results — instead of the diff alone as in v1–v1.2. The condition mapping stays sealed until all reviews for a pair are submitted. Deterministic test results remain authoritative over AI review.
3. **Explicit failure taxonomy** — the underlying failure and the recovery outcome are recorded as separate fields and must never be conflated:
   - `failure_class` — the original technical failure. Recorded for **every arm that encountered a failure, including arms that later completed successfully**; `null` only when no failure occurred:
     - `invalid-patch-generation` (model produced unparseable/corrupt patch content; eval-v1.2 baseline's `replace` import is the canonical example)
     - `patch-application-error` (anchor/scope/containment rejection)
     - `compilation-or-load-failure` (changed code cannot be imported/parsed)
     - `test-failure` (acceptance or regression suite executed and failed)
     - `infrastructure-blocked` (environment/integration failure before or outside model control; eval-v1 DNA arm)
     - `budget-exceeded` (call/token/monetary ceiling)
     - `model-empty-response` (no usable structured output, incl. `status: incomplete`)
   - `recovery_status` — what happened after that failure: `not-needed` (no failure, or no repair triggered), `recovered` (a repair attempt restored a passing state), or `exhausted` (bounded repair attempts were used without recovery). `exhausted` is a recovery outcome, **not** a root-cause failure class; there is no `repair-exhausted` failure class.
   - `repair_attempts` — the number of repair attempts actually made (integer, bounded by the frozen repair limit).

   Recording rule (the three fields are always present in every run record):

   | Situation | `failure_class` | `recovery_status` |
   | --- | --- | --- |
   | No failure occurred | `null` | `not-needed` |
   | Failure successfully repaired (arm may complete) | Original failure category | `recovered` |
   | Failure not recovered | Original failure category | `exhausted` |

   A successful arm that needed repair therefore still records its original `failure_class` with `recovery_status: recovered`; completion never erases the failure from the structured record.

   Worked example (preserved permanently): the eval-v1.2 baseline is classified as `failure_class: invalid-patch-generation`, `recovery_status: exhausted`, `repair_attempts: 2`. Its corrupt import is the failure; the two unsuccessful repairs are the recovery outcome. Neither field may be reported as a substitute for the other.
   "Agent failed" is not an acceptable category.
4. **Randomization and isolation**: execution order randomized per pair and recorded; separate worktrees, data directories, stores and conversation state per arm; the prepared repository is read-only shared input; no arm can observe the other's artifacts. Model ID, transport, pricing table and all configuration values are written into every run record (`EvaluationRunRecordSchema`).
5. **Narrow conclusions**: 3–5 replicated pairs on this benchmark measure **repeatability on this benchmark only**. Generalization requires the separate, previously unseen multi-module issue (step 2 of the maintainer's sequence), which will get its own frozen reference before any run. No quantitative performance claim before both stages complete.

## Preservation

eval-v1.2 artifacts (`docs/evaluation/runs/pilot-2026-10-30T22-17-51-113Z/`, `RESULTS-V1.2.md`, accepted at commit `cd7d41a`) are preserved exactly as they stand. Future pilots write to new run directories and new results documents; historical results are never overwritten or edited.

## Cost guardrail for the replication stage (to be confirmed at approval time)

Per-pair observed cost in eval-v1.2: baseline $1.2889 + DNA-aware $0.5525 ≈ **$1.84 per pair** at published Wonder rates. Five pairs ≈ $9.20 expected, bounded by the per-arm $3 ceilings (worst case $30). Meta Model API usage is billed separately from AWS credits.
