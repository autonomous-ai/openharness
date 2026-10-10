/**
 * Your messages per day as a calendar grid: one column per week, Monday at the top, each day tinted
 * with the agent you talked to most that day and shaded by how much.
 */

const DAY = 86_400_000

/** `YYYY-MM-DD` in local time. */
export function dayKey(at) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * The grid for the `weeks` weeks ending with the one containing `now`: `columns[week][weekday]` is
 * `{ day, total, agents: { engine: n }, top, level }`, or null for days after today. `level` is 0..4,
 * cut at the quartiles of the active days so a light month and a heavy one both show their shape.
 */
export function buildGrid(activity, { now = Date.now(), weeks = 53 } = {}) {
  const byDay = new Map()
  for (const row of activity ?? []) {
    const entry = byDay.get(row.day) ?? { total: 0, agents: {} }
    entry.total += row.asks
    entry.agents[row.engine] = (entry.agents[row.engine] ?? 0) + row.asks
    byDay.set(row.day, entry)
  }
  const totals = [...byDay.values()].map((entry) => entry.total).filter((n) => n > 0).sort((a, b) => a - b)
  const quantile = (q) => totals.length ? totals[Math.min(totals.length - 1, Math.floor(q * totals.length))] : 0
  const cuts = [quantile(0.25), quantile(0.5), quantile(0.8)]
  const top = totals.at(-1) ?? 0
  // The busiest day is always the darkest, even when it is also the 80th percentile of a short history.
  const level = (n) => (n <= 0 ? 0 : n >= top ? 4 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4)

  const today = new Date(now)
  today.setHours(12, 0, 0, 0)
  const weekday = (today.getDay() + 6) % 7 // Monday = 0
  const start = today.getTime() - (weekday + (weeks - 1) * 7) * DAY
  const columns = []
  let max = { day: null, total: 0 }
  for (let week = 0; week < weeks; week++) {
    const column = []
    for (let d = 0; d < 7; d++) {
      const at = start + (week * 7 + d) * DAY
      if (at > today.getTime() + DAY / 2) { column.push(null); continue }
      const day = dayKey(at)
      const entry = byDay.get(day) ?? { total: 0, agents: {} }
      const top = Object.entries(entry.agents).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      if (entry.total > max.total) max = { day, total: entry.total }
      column.push({ day, at, total: entry.total, agents: entry.agents, top, level: level(entry.total) })
    }
    columns.push(column)
  }
  const active = [...byDay.entries()].filter(([, entry]) => entry.total > 0)
  return { columns, max, activeDays: active.length, streak: streak(byDay, now) }
}

/** Consecutive days with at least one message, ending today or yesterday. */
export function streak(byDay, now = Date.now()) {
  // Step by calendar day from noon, not by 24 hours: across a daylight-saving change a 24-hour step
  // from just after midnight skips a day, and one from late evening lands on the same day twice.
  const day = new Date(now)
  day.setHours(12, 0, 0, 0)
  let count = 0
  if (!(byDay.get(dayKey(day.getTime()))?.total > 0)) day.setDate(day.getDate() - 1)
  while (byDay.get(dayKey(day.getTime()))?.total > 0) { count++; day.setDate(day.getDate() - 1) }
  return count
}
