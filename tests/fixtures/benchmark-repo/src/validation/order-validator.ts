import type { CreateOrderInput } from "../domain/order.ts";

export class OrderValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "OrderValidationError";
    this.code = code;
  }
}

/** Validates the structural shape of a create-order request. */
export function validateCreateOrderInput(input: CreateOrderInput): void {
  if (!input.customerId || typeof input.customerId !== "string") {
    throw new OrderValidationError("customerId is required", "MISSING_CUSTOMER");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new OrderValidationError("items must be a non-empty array", "EMPTY_ITEMS");
  }
  for (const item of input.items) {
    if (!item.sku || typeof item.unitPrice !== "number" || item.unitPrice < 0 || !Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new OrderValidationError(`invalid item: ${JSON.stringify(item)}`, "INVALID_ITEM");
    }
  }
  if (input.promoCode !== undefined && typeof input.promoCode !== "string") {
    throw new OrderValidationError("promoCode must be a string", "INVALID_PROMO");
  }
}
