import { daysBetween, formatCents } from '../utils.js'

const REFUND_WINDOW_DAYS = 30

export function refundQuote(order, today) {
  if (daysBetween(order.placedAt, today) > REFUND_WINDOW_DAYS) return 'Past the refund window'
  return `Refund ${formatCents(order.paidCents)}`
}
