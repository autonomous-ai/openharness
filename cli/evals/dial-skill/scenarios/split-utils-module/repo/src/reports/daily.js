import {
  formatCents,
  formatDate,
  sumCents,
} from '../utils.js'

export function dailySummary(day, orders) {
  const total = sumCents(orders.map((order) => order.paidCents))
  return `${formatDate(day)}: ${orders.length} orders, ${formatCents(total)}`
}
