import fs from "node:fs";
import path from "node:path";
import { cartTotal, applyCoupon } from "./pricing.js";
import { getUser } from "./users.js";

export function placeOrder(order) {
  const user = getUser(order.userId);
  if (!user) {
    throw new Error("user not found");
  }

  // BUG: no validation; negative qty yields negative charge
  let total = cartTotal(order.items);
  total = applyCoupon(total, order.coupon);

  return {
    orderId: `ord_${Date.now()}`,
    userId: user.id,
    total,
    currency: "USD",
    status: "pending",
    coupon: order.coupon ?? null,
  };
}

/**
 * Refund an order.
 * BUG: no authz — any caller can refund any orderId.
 */
export function refundOrder(_actor, orderId) {
  return { orderId, status: "refunded" };
}

/**
 * Load a receipt file for an order.
 * BUG: path traversal via unsanitized orderId (e.g. ../../etc/passwd).
 */
export function loadReceipt(orderId) {
  const file = path.join(process.cwd(), "receipts", orderId);
  return fs.readFileSync(file, "utf8");
}
