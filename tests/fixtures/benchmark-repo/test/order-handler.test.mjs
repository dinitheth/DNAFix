import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrderHandler } from "../src/api/order-handler.ts";

test("handler returns 201 with the order on success", () => {
  const handler = createOrderHandler();
  const res = handler({ customerId: "c1", items: [{ sku: "a", unitPrice: 10, quantity: 2 }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.total, 31.95);
});

test("handler returns 400 for empty items", () => {
  const handler = createOrderHandler();
  const res = handler({ customerId: "c1", items: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "EMPTY_ITEMS");
});
