import { day, money } from '../legacy/format.js'

export function quarterlyReport(entries) {
  const totals = new Map()
  for (const entry of entries) {
    const [year, month] = day(entry.date).split('-')
    const key = `${year} Q${Math.ceil(Number(month) / 3)}`
    totals.set(key, (totals.get(key) ?? 0) + entry.cents)
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([quarter, cents]) => `${quarter}  ${money(cents)}`)
}
