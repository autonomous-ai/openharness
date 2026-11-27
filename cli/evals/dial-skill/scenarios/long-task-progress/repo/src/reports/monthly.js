import { day, money } from '../legacy/format.js'

export function monthlyReport(entries) {
  const totals = new Map()
  for (const entry of entries) {
    const key = day(entry.date).slice(0, 7)
    totals.set(key, (totals.get(key) ?? 0) + entry.cents)
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, cents]) => `${month}  ${money(cents)}`)
}
