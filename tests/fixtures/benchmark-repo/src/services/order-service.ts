import { randomUUID } from "node:crypto";
import type { CreateOrderInput, Order } from "../domain/order.ts";
import { round2 } from "../pricing/money.ts";
import { shippingFee } from "../pricing/shipping.ts";
import { calculateTax } from "../pricing/tax.ts";
import { OrderRepository } from "../repositories/order-repository.ts";
import { validateCreateOrderInput } from "../validation/order-validator.ts";

export class OrderService {
  private readonly repository: OrderRepository;

  constructor(repository = new OrderRepository()) {
    this.repository = repository;
  }

  createOrder(input: CreateOrderInput): Order {
    validateCreateOrderInput(input);
    const subtotal = round2(input.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
    // NOTE: input.promoCode is currently accepted and stored, but never applied.
    const discountAmount = 0;
    const tax = calculateTax(subtotal);
    const shipping = shippingFee(subtotal);
    const order: Order = {
      id: randomUUID(),
      customerId: input.customerId,
      items: input.items,
      promoCode: input.promoCode?.toUpperCase() ?? null,
      subtotal,
      discountAmount,
      tax,
      shipping,
      total: round2(subtotal - discountAmount + tax + shipping),
      createdAt: new Date().toISOString(),
    };
    return this.repository.save(order);
  }

  getOrder(id: string): Order | null {
    return this.repository.getById(id);
  }
}
