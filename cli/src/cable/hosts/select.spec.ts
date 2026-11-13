import { describe, expect, it } from 'vitest'
import { selectForDial } from './select.js'
import type { HostAgent } from './types.js'

function agent(id: string, over: Partial<HostAgent> = {}): HostAgent {
  return {
    id,
    engine: 'claude',
    name: id,
    host: 'terminal',
    state: 'idle',
    since: 0,
    lastActivityAt: 0,
    unseenDone: false,
    ...over,
  }
}

const ids = (rows: HostAgent[]) => rows.map((a) => a.id)

describe('selectForDial', () => {
  it('orders needs-you, working, unseen done, then by lastActivityAt desc', () => {
    const rows = selectForDial([
      agent('idle-new', { lastActivityAt: 90 }),
      agent('done-seen', { state: 'done', lastActivityAt: 80 }),
      agent('done-unseen', { state: 'done', unseenDone: true, lastActivityAt: 1 }),
      agent('working', { state: 'working', lastActivityAt: 2 }),
      agent('needs', { state: 'needs-you', lastActivityAt: 3 }),
      agent('error', { state: 'error', lastActivityAt: 70 }),
    ]).rows
    expect(ids(rows)).toEqual(['needs', 'working', 'done-unseen', 'idle-new', 'done-seen', 'error'])
  })

  it('ties inside a group go most recent first', () => {
    const rows = selectForDial([
      agent('a', { state: 'working', lastActivityAt: 1 }),
      agent('b', { state: 'working', lastActivityAt: 3 }),
      agent('c', { state: 'working', lastActivityAt: 2 }),
    ]).rows
    expect(ids(rows)).toEqual(['b', 'c', 'a'])
  })

  it('keeps input order when everything is equal', () => {
    const rows = selectForDial([agent('a'), agent('b'), agent('c')]).rows
    expect(ids(rows)).toEqual(['a', 'b', 'c'])
  })

  it('returns at most 10 rows and total of all', () => {
    const many = Array.from({ length: 25 }, (_, i) => agent(`a${i}`, { lastActivityAt: i }))
    const r = selectForDial(many)
    expect(r.rows).toHaveLength(10)
    expect(r.total).toBe(25)
    expect(r.rows[0].id).toBe('a24')
  })

  it('handles empty lists and max 0', () => {
    expect(selectForDial([])).toEqual({ rows: [], total: 0 })
    expect(selectForDial([agent('a')], 0)).toEqual({ rows: [], total: 1 })
  })

  it('does not mutate its input', () => {
    const input = [agent('a', { lastActivityAt: 1 }), agent('b', { lastActivityAt: 2 })]
    selectForDial(input)
    expect(ids(input)).toEqual(['a', 'b'])
  })
})
