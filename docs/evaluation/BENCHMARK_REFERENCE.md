# Benchmark Reference — FROZEN before pilot execution (2026-10-31)

Do not modify this file to fit results. Changes require a new experiment version.

## Repository
`tests/fixtures/benchmark-repo` ("orderflow-benchmark"), a clearly labelled synthetic TypeScript fixture created for this evaluation. It is **not** a real external GitHub project, and no real external issue is claimed. Modules:

- `src/pricing/money.ts`, `discount.ts`, `tax.ts`, `shipping.ts` — pure pricing rules (each unit-tested).
- `src/validation/promo-codes.ts` — promo registry (`WELCOME10`=10%, `STUDENT5`=5%), single source of truth.
- `src/validation/order-validator.ts` — structural validation, throws `OrderValidationError` with codes.
- `src/domain/order.ts` — Order/CreateOrderInput types (Order already carries `discountAmount`).
- `src/repositories/order-repository.ts` — in-memory store.
- `src/services/order-service.ts` — order creation; currently accepts and stores `promoCode` but never applies it (the defect).
- `src/api/order-handler.ts` — HTTP boundary; maps `OrderValidationError` → 400.

Existing suite (must pass before and after): `test/pricing.test.mjs`, `test/order-service.test.mjs`, `test/order-handler.test.mjs` via `npm test`.

## Issue (identical text given to both conditions)
Title: "Promo codes are accepted but silently ignored"
Body: see `docs/evaluation/ISSUE.md` (exact text, also embedded in the harness).

## Expected behavior / acceptance criteria (scored by hidden acceptance suite A1–A5)
1. Valid promo code applies its percentage discount to the subtotal, before tax.
2. Tax is calculated on the discounted subtotal.
3. The free-shipping threshold ($100) is evaluated on the discounted subtotal.
4. Unknown promo codes are rejected (service throws a validation error; handler returns 400) and no order is stored.
5. Promo codes are case-insensitive (registry behavior).
6. Orders without a promo code behave exactly as before (existing tests unchanged and passing).
7. The stored order equals the returned order (totals consistent, `discountAmount` populated).

## Ground-truth relevant modules
- **Core (required)**: `src/services/order-service.ts` — discount/tax/shipping order of operations lives here.
- **Expected (one of)**: promo validation in `src/validation/order-validator.ts` using `src/validation/promo-codes.ts`, **or** equivalently in the service using the same registry. Both are legitimate.
- **Boundary (expected if rejection is implemented at validation layer)**: `src/api/order-handler.ts` already maps `OrderValidationError`→400, so it may legitimately remain unchanged.
- **Must not need changes**: `src/pricing/*` (rules already correct), `src/repositories/*`, `src/domain/order.ts` (fields already exist).

## Acceptable changed-file scope (for precision/recall)
Acceptable: `src/services/order-service.ts`, `src/validation/order-validator.ts`, `src/validation/promo-codes.ts`, `src/api/order-handler.ts`, any `test/*.test.mjs` additions/modifications.
Relevant (subset expected in a complete solution): at minimum `src/services/order-service.ts` plus a validation path for unknown codes (validator, service, or handler).
Unrelated: `src/pricing/*`, `src/repositories/*`, `src/domain/*`, `package.json` (unless a test script change is justified in the patch).

Scoring notes: recall is computed against {`src/services/order-service.ts`} ∪ {at least one of validator/service/handler implementing rejection} — recorded as `recallDetail` so alternative implementations are judged fairly. A patch that passes all acceptance tests but touches an "unrelated" file is flagged for the blind reviewer, not auto-failed.

## Known limitations of this benchmark
Single synthetic repo (~11 source files); the promo registry is discoverable by grep, which a strong baseline may find without DNA help — that is intentional (a fair baseline must not be handicapped), and it means this pilot tests whether DNA evidence changes behavior on a task where ordinary retrieval can also succeed. One matched pair = exploratory, not statistical.
