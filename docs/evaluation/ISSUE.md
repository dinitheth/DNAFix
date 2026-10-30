Title: Promo codes are accepted but silently ignored

Body:
Customers can submit a promoCode when creating an order (for example WELCOME10), and the API accepts and stores it, but the discount is never applied: discountAmount is always 0 and totals are unchanged.

Expected behavior:
- A valid promo code applies its percentage discount to the order subtotal, before tax. Valid codes and their percentages are defined in the promo code registry (src/validation/promo-codes.ts), which is the single source of truth.
- Tax is calculated on the discounted subtotal.
- The free-shipping threshold is evaluated on the discounted subtotal.
- Promo codes are case-insensitive.
- An unknown promo code is rejected as a validation error (the API returns 400) and no order is stored.
- Orders without a promo code behave exactly as they do today.

Acceptance criteria:
- applyDiscount behavior is observable through orders: e.g. a 120 order with WELCOME10 has discountAmount 12, tax 10.8, free shipping, total 118.8.
- A 105 order with WELCOME10 pays shipping because the discounted subtotal is below the free-shipping threshold.
- Unknown codes return HTTP 400 from the order handler.
- All existing tests continue to pass.
