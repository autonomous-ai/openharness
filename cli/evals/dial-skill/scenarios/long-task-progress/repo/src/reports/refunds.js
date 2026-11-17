import { money, pct } from '../legacy/format.js'

// Refunds are negative amounts; the rate compares them with what was invoiced.
export function refundsReport(entries) {
  const refunds = entries.filter((entry) => entry.kind === 'refund')
  const refunded = refunds.reduce((sum, entry) => sum + entry.cents, 0)
  const invoiced = entries.filter((entry) => entry.kind === 'invoice').reduce((sum, entry) => sum + entry.cents, 0)
  const noun = refunds.length === 1 ? 'refund' : 'refunds'
  return `${refunds.length} ${noun}, ${money(refunded)}, ${pct(-refunded / invoiced)} of invoiced`
}
