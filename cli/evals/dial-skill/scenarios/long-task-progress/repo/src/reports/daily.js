import { day, money } from '../legacy/format.js'

// One line per day with entries: the date and the net amount.
export function dailyReport(entries) {
  const totals = new Map()
  for (const entry of entries) {
    const key = day(entry.date)
    totals.set(key, (totals.get(key) ?? 0) + entry.cents)
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, cents]) => `${date}  ${money(cents)}`)
}
