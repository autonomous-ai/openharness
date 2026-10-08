/** Lightweight inventory, independent of the active tab's conversation/voice roster. */
export const PLAYER_PAGE_SIZE = 6
export const PLAYER_STATES = ['working', 'question', 'finished', 'failed', 'paused', 'idle', 'offline'] as const
export type PlayerStatus = typeof PLAYER_STATES[number]
export interface PlayerSession {
  id: string; machineId: string; name: string; engine: string
  status: PlayerStatus; lastActivityAt: number | null
}

/** Byte bounds match the MCU, including multibyte names. Never split UTF-8. */
export function playerLabel(value: unknown, bytes: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ')
  let result = ''
  for (const char of text) {
    if (Buffer.byteLength(result + char) > bytes) break
    result += char
  }
  return result
}

export function playerSessions(value: unknown): PlayerSession[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  return value.flatMap(row => {
    if (!row || typeof row !== 'object') return []
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id || Buffer.byteLength(r.id) >= 48 ||
        typeof r.machineId !== 'string' || !r.machineId || Buffer.byteLength(r.machineId) >= 48 || seen.has(r.id)) return []
    seen.add(r.id)
    return [{ id: r.id, machineId: r.machineId, name: playerLabel(r.name, 95), engine: playerLabel(r.engine, 15),
      status: PLAYER_STATES.includes(r.status as PlayerStatus) ? r.status as PlayerStatus : 'idle',
      lastActivityAt: typeof r.lastActivityAt === 'number' && Number.isSafeInteger(r.lastActivityAt) && r.lastActivityAt > 0 ? r.lastActivityAt : null }]
  })
}

export function playerPage(sessions: PlayerSession[], offset: number, now = Date.now()) {
  // The desktop supplies its New Tab order. A page never sorts independently.
  const start = Math.max(0, Math.min(offset, Math.max(0, sessions.length - PLAYER_PAGE_SIZE)))
  return { offset: start, total: sessions.length, rows: sessions.slice(start, start + PLAYER_PAGE_SIZE).map(row => ({
    id: row.id, machineId: row.machineId, name: row.name, engine: row.engine, status: row.status,
    ageSeconds: row.lastActivityAt === null ? -1 : Math.min(315_360_000, Math.max(0, Math.floor((now - row.lastActivityAt) / 1000))),
  })) }
}
