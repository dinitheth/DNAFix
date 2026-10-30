import { round2 } from "./money.ts";

export const TAX_RATE = 0.1;

/** Sales tax on a taxable amount (10%). */
export function calculateTax(taxableAmount: number): number {
  return round2(taxableAmount * TAX_RATE);
}
