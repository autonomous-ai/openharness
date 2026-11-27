import { setTimeout as sleep } from 'node:timers/promises'

// Stands in for loading the archived month-end close, as slow as the real archive.
await sleep(1500)

const at = (date) => new Date(`${date}T12:00:00Z`)

export const smallLedger = [
  { date: at('2025-01-06'), kind: 'invoice', customer: 'Ada', cents: 12000 },
  { date: at('2025-01-06'), kind: 'invoice', customer: 'Grace', cents: 4550 },
  { date: at('2025-01-07'), kind: 'refund', customer: 'Grace', cents: -1550 },
  { date: at('2025-02-14'), kind: 'invoice', customer: 'Linus', cents: 9999 },
  { date: at('2025-04-01'), kind: 'payout', customer: 'Acme', cents: -20000 },
  { date: at('2025-04-02'), kind: 'invoice', customer: 'Ada', cents: 30001 },
]

const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_START = Date.UTC(2025, 0, 1)

// A year of entries, the size of a real month-end close; seeded, so every run sees the same ledger.
export function yearOfLedger(count = 200_000) {
  let seed = 20250101
  const next = (below) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return Math.floor((seed / 2147483648) * below)
  }
  const entries = []
  for (let i = 0; i < count; i++) {
    const date = new Date(YEAR_START + next(365) * DAY_MS + next(DAY_MS))
    const customer = `customer-${next(50)}`
    const roll = next(100)
    if (roll < 85) entries.push({ date, kind: 'invoice', customer, cents: 500 + next(49_500) })
    else if (roll < 95) entries.push({ date, kind: 'refund', customer, cents: -(100 + next(4_900)) })
    else entries.push({ date, kind: 'payout', customer: 'Acme', cents: -(10_000 + next(90_000)) })
  }
  return entries
}
