import { rateFor } from './tax.js'

export function invoiceTotals(order, region, date) {
  const rate = rateFor(region, new Date(date).getUTCFullYear())
  const net = order.lines.reduce((sum, line) => {
    const gross = line.unitCents * line.quantity
    return sum + gross - Math.round(gross * (line.discountPercent ?? 0) / 100)
  }, 0)
  const tax = Math.round(net * rate)
  return { net, tax, total: net + tax }
}
