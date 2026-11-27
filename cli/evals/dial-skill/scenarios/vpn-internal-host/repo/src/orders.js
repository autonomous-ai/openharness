export function orderTotal(order) {
  const subtotal = order.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0)
  const discount = Math.round(subtotal * (order.discountPercent ?? 0) / 100)
  return subtotal - discount + (order.shippingCents ?? 0)
}
