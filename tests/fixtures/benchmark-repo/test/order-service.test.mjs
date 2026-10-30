import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderService } from "../src/services/order-service.ts";

test("order without promo: subtotal + tax + shipping", () => {
  const service = new OrderService();
  const order = service.createOrder({ customerId: "c1", items: [{ sku: "a", unitPrice: 50, quantity: 1 }] });
  assert.equal(order.subtotal, 50);
  assert.equal(order.discountAmount, 0);
  assert.equal(order.tax, 5);
  assert.equal(order.shipping, 9.95);
  assert.equal(order.total, 64.95);
  assert.equal(service.getOrder(order.id)?.total, 64.95);
});

test("order without promo over threshold gets free shipping", () => {
  const service = new OrderService();
  const order = service.createOrder({ customerId: "c1", items: [{ sku: "a", unitPrice: 120, quantity: 1 }] });
  assert.equal(order.shipping, 0);
  assert.equal(order.total, 132);
});
