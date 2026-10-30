# Pilot Results — eval-v1 (pilot-2026-10-30T21-50-48-247Z)

## Verdict up front

**This pilot is INVALID as a test of the hypothesis, and the comparison below must not be read as evidence for or against Project DNA.** The DNA-aware arm never reached the model: it was blocked after 5.6 seconds by an environment failure in the Project DNA bridge (missing `graphology` workspace link in the local Project DNA inspection clone — the clone's `node_modules` links had been pruned; only the `.pnpm` store remained). The environment has since been repaired and the bridge test re-verified (passed). The baseline arm ran fully and failed on its own merits. A single matched pilot could not establish statistical significance even if both arms had completed; a failed arm makes it inconclusive by construction.

Randomized execution order was: **dna-aware first, baseline second**. Mapping (sealed until blind review completed): Patch A = baseline, Patch B = dna-aware.

## Comparison table (as requested)

| Metric | Baseline | DNA-aware |
| --- | --- | --- |
| Acceptance criteria satisfied | 0/5 (A1–A5 all fail, re-scored) | 0/5 (no patch produced; A5 passes trivially on empty patch — not a success) |
| Relevant files identified (planning) | Yes — planned scope was exactly `src/validation/order-validator.ts` + `src/services/order-service.ts` | unavailable (blocked before planning) |
| Unrelated files modified | 0 unrelated; **but the core file was deleted** (see facts) | none (no changes) |
| Regression tests passed | No (exit 1 in scoring) | Yes (empty patch; exit 0) |
| Repair attempts | 1 recorded (a second repair attempt threw) | 0 |
| Input tokens | 9,105 | 0 (no model calls) |
| Output tokens | 51,294 | 0 |
| Execution time | 406 s | 5.6 s (blocked) |
| Estimated cost | $1.0623 (at $4/$20 per 1M) | $0 |
| Independent review (blind, Muse Spark) | Patch A: **request-changes** — correctly identified the service-file deletion blind | Patch B: **request-changes** — correctly identified the empty patch blind |

## Measured facts

1. **Identical baseline**: both run records carry base commit `639252b68e2f91b4bd64a642c9e35ca6951a4386`, identical issue text, identical configuration blocks (`muse-wonder-1.0` for all roles, responses transport, no reasoning override, maxRepairAttempts 2, caps 12 calls / 250k tokens, host sandbox). Baseline isolation held: its intelligence snapshot is `benchmark-baseline@vunknown` with the recorded warning that no Project DNA analysis was performed; the Project DNA adapter was never constructed in that arm.
2. **DNA-aware arm**: final state `BLOCKED`, error `Project DNA bridge exited 1: Cannot find module 'graphology'` (require stack inside the Project DNA clone). Zero model calls, zero tokens, `intelligenceSnapshot: null`. **The two-stage analysis question does not arise**: neither the planning-stage nor the impact-stage analysis completed, so there are no snapshot IDs to compare for this arm. (In the earlier Milestone-1 live run, both stages produced `<repositoryId>@v1` against the same commit; snapshot reuse instead of recomputation remains a valid optimization recommendation, unimplemented.)
3. **Baseline arm**: 5 model calls (plan, 2 task patches, verifier review, 1+ repair patches), 60,399 total tokens, $1.0623 estimated, 406 s. Its *plan* was good: scope exactly the two ground-truth files. Execution failed:
   - Task patch summaries show one task produced "I'm not sure how to solve problem. I lack tools." as its summary.
   - The verifier returned `uncertain`; verification tests failed (exit 1).
   - During repair, a model patch **deleted `src/services/order-service.ts` wholesale**, and a second repair attempt then failed with `delete: file not found: src/validation/order-validator.ts`, ending the run as `FAILED`.
   - The final diff (Patch A) therefore deletes the core service file and leaves the validator referencing an undefined `isKnownPromoCode`.
4. **Deterministic re-scoring** (fresh worktrees, hidden acceptance suite, corrected TAP parser): baseline A1–A5 all fail, regression exit 1; DNA-aware (empty diff) A5 passes, regression exit 0. The original in-harness scoring had a parser bug (it matched `# Subtest:` comment lines); the saved patches were re-scored without re-running any arm, and both records + `summary.json` were updated with a correction note.
5. **Metric caveats measured**: `precision=1` and `recall=0.5` for the baseline are artifacts — they credit "changing" `order-service.ts` even though the change was a deletion. Scope metrics must be read with the diff, never alone.
6. **Blind review quality**: anonymization scrub passed (no run IDs/branch names/condition labels in either patch). The blind reviewer correctly diagnosed both patches (deletion in A, empty in B) without knowing conditions. Deterministic results agree with the reviewer; where they could conflict, tests remain authoritative.
7. **Budgets**: neither arm approached the caps (baseline: 5/12 calls, 60k/250k tokens). No budget overshoot occurred. Actual overshoot risk (a single response exceeding remaining budget) is recorded as a harness amendment for eval-v1.1: per-request `max_output_tokens` + reserved margin, plus an explicit monetary ceiling.
8. **Isolation**: each arm ran in its own temp data root with its own store and worktrees from the same read-only prepared repo. Host sandbox caveat applies: this is experimental isolation, not OS-level security isolation; the benchmark fixture is DNAFix-authored trusted code. No GitHub PR was created; nothing was pushed anywhere.

## Reviewer judgments (not measurements)

- Blind AI review (Muse Spark, supplementary): both patches `request-changes`, reasoning consistent with deterministic evidence (see `runs/pilot-2026-10-30T21-50-48-247Z/review.json`).
- Engineering judgment: the baseline's *planning* (without any DNA input) was accurate on this benchmark, which supports the design note in BENCHMARK_REFERENCE.md that this fixture is grep-discoverable and may not differentiate. Its *execution/repair* behavior was unsafe: the repair loop applied a wholesale file deletion inside the task scope. That is a DNAFix product-safety finding independent of the experiment: repair patches should not be allowed to delete existing non-test source files without human approval.

## Limitations

Everything in `docs/evaluation/LIMITATIONS.md`, plus pilot-specific: (a) DNA arm invalid due to environment, so no DNA observations exist; (b) n=1 even for the baseline observation; (c) the two-stage DNA snapshot consistency question is unanswered by this pilot; (d) re-scored base-commit SHAs differ from the recorded one because prepared-repo commits embed timestamps — fixture *content* was unchanged (tree-identical fixture, verified acceptance behavior 1-pass/4-fail pre-fix and 7/7 existing tests green).

## Conclusions

- The hypothesis — Project DNA evidence improves Muse Wonder's engineering outcomes — is **neither supported nor contradicted** by this pilot. It remains untested because the DNA-aware arm never executed.
- The pilot did produce one solid product finding: the baseline's repair loop can destroy the very files it is repairing. That should be fixed before further evaluation, because a destructive repair capability contaminates any future arm that triggers repairs.
- No additional experiment has been started. Recommended next step, subject to approval: (1) add the repair-deletion guard + harness amendments (monetary ceiling, per-request output caps); (2) re-run the full matched pair (both arms, fresh) on the same frozen benchmark/commit procedure; (3) only then interpret the comparison.
