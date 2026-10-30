import { round2 } from "./money.ts";

/** Percentage discount amount for a subtotal. applyPercentageDiscount(200, 10) === 20. */
export function applyPercentageDiscount(subtotal: number, percentOff: number): number {
  if (percentOff < 0 || percentOff > 100) throw new Error(`percentOff out of range: ${percentOff}`);
  return round2((subtotal * percentOff) / 100);
}
