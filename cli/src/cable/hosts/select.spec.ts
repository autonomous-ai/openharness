// Which agents the dial shows with no window, and in what order: the ones that need the person first.
import { describe, expect, it } from 'vitest'

import { selectForDial } from './select.js'
import type { HostAgent } from './types.js'

function agent(id: string, state: HostAgent['state'], lastActivityAt: number, unseenDone = false): HostAgent {
  return { id, engine: 'claude', name: id, host: 'terminal', state, since: 0, lastActivityAt, unseenDone }
}

describe('selectForDial', () => {
  it('orders needs-you, working, unseen done, then by lastActivityAt desc', () => {
    const agents = [
      agent('idle-new', 'idle', 900),
      agent('done-seen', 'done', 800),
      agent('error', 'error', 700),
      agent('done-unseen', 'done', 100, true),
      agent('working', 'working', 50),
      agent('needs-you', 'needs-you', 10),
      agent('idle-old', 'idle', 5),
    ]
    expect(selectForDial(agents).rows.map((a) => a.id)).toEqual([
      'needs-you', 'working', 'done-unseen', 'idle-new', 'done-seen', 'error', 'idle-old',
    ])
  })

  it('ties inside a group go most recent first', () => {
    const agents = [
      agent('ask-old', 'needs-you', 1),
      agent('run-old', 'working', 1),
      agent('ask-new', 'needs-you', 3),
      agent('run-new', 'working', 2),
      agent('done-old', 'done', 1, true),
      agent('done-new', 'done', 2, true),
    ]
    expect(selectForDial(agents).rows.map((a) => a.id)).toEqual([
      'ask-new', 'ask-old', 'run-new', 'run-old', 'done-new', 'done-old',
    ])
  })

  it('returns at most 10 rows and total of all', () => {
    const agents = Array.from({ length: 60 }, (_, i) => agent(`a${i}`, 'idle', i))
    const picked = selectForDial(agents)
    expect(picked.total).toBe(60)
    expect(picked.rows.map((a) => a.id)).toEqual(['a59', 'a58', 'a57', 'a56', 'a55', 'a54', 'a53', 'a52', 'a51', 'a50'])
    expect(selectForDial(agents, 3).rows).toHaveLength(3)
    expect(selectForDial([])).toEqual({ rows: [], total: 0 })
  })

  it('leaves the caller\'s list in its order', () => {
    const agents = [agent('a', 'idle', 1), agent('b', 'needs-you', 2)]
    selectForDial(agents)
    expect(agents.map((a) => a.id)).toEqual(['a', 'b'])
  })
})
