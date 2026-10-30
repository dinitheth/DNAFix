import { round2 } from "./money.ts";

export const FREE_SHIPPING_THRESHOLD = 100;
export const STANDARD_SHIPPING_FEE = 9.95;

/** Free shipping at or above the threshold, based on the amount passed in. */
export function shippingFee(amount: number): number {
  return amount >= FREE_SHIPPING_THRESHOLD ? 0 : round2(STANDARD_SHIPPING_FEE);
}
