import type { CreateOrderInput } from "../domain/order.ts";
import { OrderService } from "../services/order-service.ts";
import { OrderValidationError } from "../validation/order-validator.ts";

export interface HandlerResponse {
  status: number;
  body: unknown;
}

/** HTTP boundary for order creation. Returns 201 with the stored order on success. */
export function createOrderHandler(service = new OrderService()) {
  return (requestBody: unknown): HandlerResponse => {
    try {
      const order = service.createOrder(requestBody as CreateOrderInput);
      return { status: 201, body: order };
    } catch (err) {
      if (err instanceof OrderValidationError) {
        return { status: 400, body: { error: err.code, message: err.message } };
      }
      throw err;
    }
  };
}
