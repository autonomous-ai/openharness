// A measure read from the log, as createTally's (lib/notifyTier.ts) is, kept per engine: one line an event, then the
// person's local day's running counts for every engine. Fixed words only, never a path, a session or a name.

import { localDay } from '../lib/notifyTier.js'

export function createEngineTally<E extends string, K extends string>(
  label: string, engines: readonly E[], kinds: readonly K[], log: (line: string) => void, now: () => number = Date.now,
): (engine: E, kind: K, reason?: string) => void {
  let day = ''
  let counts = new Map<string, number>()
  return (engine, kind, reason) => {
    log(`${label} · ${engine} · ${kind}${reason ? ` · ${reason}` : ''}`)
    const today = localDay(now())
    if (today !== day) { day = today; counts = new Map() }
    const key = `${engine} ${kind}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const engineCounts = engines.map((name) => [name, ...kinds.map((k) => `${k} ${counts.get(`${name} ${k}`) ?? 0}`)].join(' '))
    log(`${label} · day ${day} · ${engineCounts.join(' · ')}`)
  }
}
