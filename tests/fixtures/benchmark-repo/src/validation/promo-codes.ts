/**
 * Promo code registry: code -> percentage off.
 * This module is the single source of truth for valid promo codes.
 */
export const PROMO_CODES: Readonly<Record<string, number>> = {
  WELCOME10: 10,
  STUDENT5: 5,
};

/** Returns the percentage off for a code, or null when the code is unknown. */
export function lookupPromoPercent(code: string): number | null {
  return PROMO_CODES[code.toUpperCase()] ?? null;
}
