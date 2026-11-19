import { money, pct } from '../legacy/format.js'

// The three customers with the most revenue (invoices less refunds), with their share of it.
export function customersReport(entries) {
  const revenue = new Map()
  for (const entry of entries) {
    if (entry.kind !== 'invoice' && entry.kind !== 'refund') continue
    revenue.set(entry.customer, (revenue.get(entry.customer) ?? 0) + entry.cents)
  }
  const total = [...revenue.values()].reduce((sum, cents) => sum + cents, 0)
  return [...revenue]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([customer, cents]) => `${customer}  ${money(cents)}  (${pct(cents / total)})`)
}
