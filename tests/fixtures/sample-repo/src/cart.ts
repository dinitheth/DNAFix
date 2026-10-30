import { applyDiscount } from "./discount.ts";

export interface CartItem {
  name: string;
  price: number;
  percentOff: number;
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + applyDiscount(item.price, item.percentOff), 0);
}
