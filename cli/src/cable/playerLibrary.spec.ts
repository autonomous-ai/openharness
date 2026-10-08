import { describe, expect, it } from 'vitest'
import { playerLabel, playerPage, playerSessions } from './playerLibrary.js'

describe('Player library pages', () => {
  it('reaches every session beyond the active tab and the MCU roster size', () => {
    const rows = playerSessions(Array.from({ length: 107 }, (_, i) => ({ id: `a${i}`, machineId: `m${i % 4}`,
      name: `Session ${i}`, engine: i % 2 ? 'claude' : 'codex', status: i % 3 ? 'paused' : 'working', lastActivityAt: 100_000 })))!
    const ids = new Set<string>()
    for (let offset = 0; offset < 107; offset += 6) {
      const page = playerPage(rows, offset, 220_000)
      expect(page.rows).toHaveLength(6)
      expect(page.total).toBe(107)
      for (const row of page.rows) { ids.add(row.id); expect(row.ageSeconds).toBe(120) }
    }
    expect(ids.size).toBe(107)
    expect(playerPage(rows, 999).offset).toBe(101)
    expect(playerPage([], 20)).toEqual({ offset: 0, total: 0, rows: [] })
  })
  it('bounds names by bytes, rejects unsafe identities and preserves unknown times', () => {
    expect(Buffer.byteLength(playerLabel('生'.repeat(100), 95))).toBe(93)
    const rows = playerSessions([{ id: 'a', machineId: 'm', name: '生'.repeat(100), status: 'paused' },
      { id: 'a', machineId: 'other' }, { id: 'x'.repeat(48), machineId: 'm' }, { id: 'b' }])!
    expect(rows).toHaveLength(1)
    expect(playerPage(rows, 0).rows[0]).toMatchObject({ status: 'paused', ageSeconds: -1 })
    expect(playerSessions(null)).toBeUndefined()
  })
})
