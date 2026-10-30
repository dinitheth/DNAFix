import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPercentageDiscount } from "../src/pricing/discount.ts";
import { shippingFee } from "../src/pricing/shipping.ts";
import { calculateTax } from "../src/pricing/tax.ts";

test("discount is a percentage of the subtotal", () => {
  assert.equal(applyPercentageDiscount(200, 10), 20);
  assert.equal(applyPercentageDiscount(50, 100), 50);
});

test("tax is 10% of the taxable amount", () => {
  assert.equal(calculateTax(100), 10);
  assert.equal(calculateTax(94.5), 9.45);
});

test("shipping is free at or above 100, otherwise 9.95", () => {
  assert.equal(shippingFee(100), 0);
  assert.equal(shippingFee(99.99), 9.95);
});
