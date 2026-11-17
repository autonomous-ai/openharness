import { day, money } from '../legacy/format.js'

export function yearlyReport(entries) {
  const totals = new Map()
  for (const entry of entries) {
    const key = day(entry.date).slice(0, 4)
    totals.set(key, (totals.get(key) ?? 0) + entry.cents)
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, cents]) => `${year}  ${money(cents)}`)
}
