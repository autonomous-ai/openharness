import { money } from '../legacy/format.js'

const SALES_TAX = 0.0825

// Tax is owed on what was invoiced less what was refunded.
export function taxesReport(entries) {
  const taxable = entries
    .filter((entry) => entry.kind === 'invoice' || entry.kind === 'refund')
    .reduce((sum, entry) => sum + entry.cents, 0)
  return `Sales tax at 8.25% of ${money(taxable)}: ${money(Math.round(taxable * SALES_TAX))}`
}
