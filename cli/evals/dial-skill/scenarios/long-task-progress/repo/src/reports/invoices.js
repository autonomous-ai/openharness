import { day, money } from '../legacy/format.js'

export function invoicesReport(entries) {
  const invoices = entries.filter((entry) => entry.kind === 'invoice')
  const total = invoices.reduce((sum, entry) => sum + entry.cents, 0)
  const last = invoices.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), invoices[0].date)
  return `${invoices.length} invoices, ${money(total)}, last on ${day(last)}`
}
