import { formatCents, formatDate, sumCents } from '../utils.js'

export function invoiceLines(order) {
  const total = sumCents(order.items.map((item) => item.cents * item.quantity))
  return [
    `Invoice ${order.id} (${formatDate(order.placedAt)})`,
    ...order.items.map((item) => `${item.quantity} x ${item.name}: ${formatCents(item.cents * item.quantity)}`),
    `Total: ${formatCents(total)}`,
  ]
}
