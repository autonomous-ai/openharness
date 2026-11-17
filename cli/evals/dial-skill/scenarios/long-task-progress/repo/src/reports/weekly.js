import { day, money } from '../legacy/format.js'

const DAY_MS = 24 * 60 * 60 * 1000

// Weeks start on Monday, as the finance calendar does.
function monday(date) {
  return new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS)
}

export function weeklyReport(entries) {
  const totals = new Map()
  for (const entry of entries) {
    const key = day(monday(entry.date))
    totals.set(key, (totals.get(key) ?? 0) + entry.cents)
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, cents]) => `week of ${week}  ${money(cents)}`)
}
