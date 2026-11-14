import { describe, expect, it } from 'vitest'
import { HarnessSource } from './harness.js'
import { capsLetters } from './types.js'

const ROWS = [
  { id: 'l1', name: 'api', engine: 'claude', machineId: 'mine', sessionId: 's1' },
  { id: 'r1', name: 'remote', engine: 'claude', machineId: 'other' },
  { id: 'sh', name: 'zsh', engine: 'terminal', machineId: 'mine' },
  { id: 'l2', name: 'web', engine: 'codex', machineId: 'mine' },
]

describe('HarnessSource', () => {
  it("HarnessSource lists only this machine's agents", () => {
    const src = new HarnessSource(() => 1_000)
    src.update(ROWS, 'mine', new Map([['l1', 500], ['r1', 900]]))
    expect(src.list()).toEqual([
      { id: 'l1', name: 'api', engine: 'claude', sessionId: 's1', host: 'harness', state: 'idle', since: 500, lastActivityAt: 500, unseenDone: false },
      { id: 'l2', name: 'web', engine: 'codex', host: 'harness', state: 'idle', since: 0, lastActivityAt: 0, unseenDone: false },
    ])
    expect(capsLetters(src.capabilities())).toBe('sva')
  })

  it('takes each agent\'s state from the cards it is told', () => {
    let now = 1_000
    const src = new HarnessSource(() => now)
    src.update(ROWS, 'mine', new Map())
    const state = (id: string) => src.list().find((a) => a.id === id)
    src.noteCard('l1', 'processing')
    expect(state('l1')).toMatchObject({ state: 'working', since: 1_000, lastActivityAt: 1_000 })
    now = 2_000
    src.noteCard('l1', 'processing')
    expect(state('l1')).toMatchObject({ state: 'working', since: 1_000 })
    src.noteCard('l1', 'question')
    expect(state('l1')).toMatchObject({ state: 'needs-you', since: 2_000 })
    src.noteCard('l1', 'question.close')
    expect(state('l1')).toMatchObject({ state: 'working' })
    src.noteCard('l1', 'done')
    expect(state('l1')).toMatchObject({ state: 'done', unseenDone: true })
    src.noteCard('l1', 'processing')
    expect(state('l1')).toMatchObject({ state: 'working', unseenDone: false })
    src.noteCard('l2', 'error')
    expect(state('l2')).toMatchObject({ state: 'error' })
  })

  it('markSeen clears a done agent\'s unseenDone, and leaves one with no card as it was', () => {
    const src = new HarnessSource(() => 1_000)
    src.update(ROWS, 'mine', new Map())
    src.noteCard('l1', 'done')
    src.markSeen('l1')
    src.markSeen('l1')
    src.markSeen('l2')
    expect(src.list().find((a) => a.id === 'l1')).toMatchObject({ state: 'done', unseenDone: false })
    expect(src.list().find((a) => a.id === 'l2')).toMatchObject({ state: 'idle', unseenDone: false })
  })

  it('forgets the state of an agent that left', () => {
    const src = new HarnessSource(() => 1_000)
    src.update(ROWS, 'mine', new Map())
    src.noteCard('l2', 'done')
    src.update(ROWS.filter((r) => r.id !== 'l2'), 'mine', new Map())
    src.update(ROWS, 'mine', new Map())
    expect(src.list().find((a) => a.id === 'l2')).toMatchObject({ state: 'idle', unseenDone: false })
  })
})
