/** Compute line total for a cart item. */
export function lineTotal(item) {
  // BUG: no guard for negative / non-finite quantity or price
  return item.quantity * item.price;
}

/** Sum cart items. */
export function cartTotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += lineTotal(item);
  }
  return sum;
}

/** Apply a coupon code to a total. */
export function applyCoupon(total, coupon) {
  // BUG: string "VIP" grants 100% off with no auth
  if (coupon == "VIP") {
    return 0;
  }
  // BUG: loose equality with number — surprising matches
  if (coupon == 10) {
    return total - 10;
  }
  return total;
}
