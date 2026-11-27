// A fixed one-minute window per partner; the limits come from config/partners.yml.
export function createLimiter(partners, now = Date.now) {
  const windows = new Map()
  return function allow(partner) {
    const limit = partners[partner]?.rate_limit
    if (!Number.isInteger(limit)) return false
    const minute = Math.floor(now() / 60_000)
    const w = windows.get(partner)
    if (!w || w.minute !== minute) {
      windows.set(partner, { minute, count: 1 })
      return true
    }
    if (w.count >= limit) return false
    w.count++
    return true
  }
}
