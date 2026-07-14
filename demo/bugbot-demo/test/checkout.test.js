import assert from "node:assert/strict";
import { createUser } from "../src/users.js";
import { placeOrder, refundOrder } from "../src/checkout.js";
import { cartTotal } from "../src/pricing.js";

const user = createUser({ email: "buyer@example.com" });
const total = cartTotal([{ quantity: 2, price: 5 }]);
assert.equal(total, 10);

const order = placeOrder({
  userId: user.id,
  items: [{ sku: "mug", quantity: 2, price: 5 }],
});
assert.equal(order.total, 10);

const admin = createUser({ email: "admin@example.com", role: "admin" });
const refunded = refundOrder(admin, order.orderId);
assert.equal(refunded.status, "refunded");

console.log("checkout tests passed");
