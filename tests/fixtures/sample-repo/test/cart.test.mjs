import assert from "node:assert/strict";
import { test } from "node:test";
// The test imports the TypeScript sources directly via Node's built-in type stripping.
import { applyDiscount } from "../src/discount.ts";
import { cartTotal } from "../src/cart.ts";

test("applyDiscount subtracts a percentage of the price", () => {
  assert.equal(applyDiscount(200, 10), 180);
  assert.equal(applyDiscount(50, 100), 0);
});

test("cartTotal sums discounted items", () => {
  assert.equal(cartTotal([{ name: "a", price: 200, percentOff: 10 }]), 180);
});
