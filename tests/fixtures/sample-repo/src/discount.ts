/**
 * Applies a percentage discount to a price.
 * applyDiscount(200, 10) should return 180 (10% off).
 */
export function applyDiscount(price: number, percentOff: number): number {
  // BUG: subtracts the percentage number as a flat currency amount.
  return price - percentOff;
}
