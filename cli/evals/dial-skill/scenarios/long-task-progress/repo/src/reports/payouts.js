import { day, money } from '../legacy/format.js'

export function payoutsReport(entries) {
  const payouts = entries.filter((entry) => entry.kind === 'payout')
  const total = payouts.reduce((sum, entry) => sum + entry.cents, 0)
  const last = payouts.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), payouts[0].date)
  const noun = payouts.length === 1 ? 'payout' : 'payouts'
  return `${payouts.length} ${noun}, ${money(total)}, last on ${day(last)}`
}
