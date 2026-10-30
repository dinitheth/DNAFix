import type { Order } from "../domain/order.ts";

/** In-memory order store. */
export class OrderRepository {
  private readonly orders = new Map<string, Order>();

  save(order: Order): Order {
    this.orders.set(order.id, order);
    return order;
  }

  getById(id: string): Order | null {
    return this.orders.get(id) ?? null;
  }

  count(): number {
    return this.orders.size;
  }
}
