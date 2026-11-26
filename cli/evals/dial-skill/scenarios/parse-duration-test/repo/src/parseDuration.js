const UNIT_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
}

// jobs.json gives intervals and timeouts as text ('30s', '2h'), the scheduler counts in milliseconds.
export function parseDuration(text) {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(String(text).trim())
  if (!match) throw new Error(`invalid duration: ${text}`)
  return Number(match[1]) * UNIT_MS[match[2]]
}
