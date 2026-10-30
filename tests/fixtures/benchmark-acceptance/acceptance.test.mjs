// BENCHMARK ACCEPTANCE TESTS — scoring only. Never shown to either agent condition.
// Copied into a scoring worktree after the agent patch is applied, then executed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrderHandler } from "../src/api/order-handler.ts";
import { OrderService } from "../src/services/order-service.ts";

test("A1: WELCOME10 applies 10% before tax; free shipping evaluated after discount (>=100)", () => {
  const service = new OrderService();
  const order = service.createOrder({ customerId: "c1", items: [{ sku: "a", unitPrice: 120, quantity: 1 }], promoCode: "WELCOME10" });
  assert.equal(order.subtotal, 120);
  assert.equal(order.discountAmount, 12);
  assert.equal(order.tax, 10.8);
  assert.equal(order.shipping, 0);
  assert.equal(order.total, 118.8);
});

test("A2: discounted subtotal below 100 pays shipping (threshold is post-discount)", () => {
  const service = new OrderService();
  const order = service.createOrder({ customerId: "c1", items: [{ sku: "a", unitPrice: 105, quantity: 1 }], promoCode: "WELCOME10" });
  assert.equal(order.discountAmount, 10.5);
  assert.equal(order.tax, 9.45);
  assert.equal(order.shipping, 9.95);
  assert.equal(order.total, 113.9);
});

test("A3: unknown promo code is rejected and no order is stored", () => {
  const handler = createOrderHandler();
  const res = handler({ customerId: "c1", items: [{ sku: "a", unitPrice: 10, quantity: 1 }], promoCode: "NOPE" });
  assert.equal(res.status, 400);
});

test("A4: STUDENT5 applies 5% and stored order matches response totals", () => {
  const service = new OrderService();
  const order = service.createOrder({ customerId: "c1", items: [{ sku: "a", unitPrice: 40, quantity: 2 }], promoCode: "student5" });
  assert.equal(order.discountAmount, 4);
  assert.equal(order.total, service.getOrder(order.id)?.total);
});

test("A5: promo code does not change orders without a promo code (regression)", () => {
  const service = new OrderService();
  const order = service.createOrder({ customerId: "c1", items: [{ sku: "a", unitPrice: 50, quantity: 1 }] });
  assert.equal(order.discountAmount, 0);
  assert.equal(order.total, 64.95);
});
