import { describe, expect, it, vi } from 'vitest'
import { DesktopCompanion, parseCompanionState } from './companionState.js'

const egg = (revision = 1, window = 'desktop-a') => ({ v: 1, window,
  epoch: 1, revision, enabled: true, foreground: true, motion: true,
  phase: 'egg', egg: { kind: 'first', stage: 'p0' },
  feeling: { emotion: 'content', reason: 'settled', intensity: 1 },
})
const tim = (revision = 1) => ({ ...egg(revision), phase: 'creature',
  creature: { uid: 'tim-123', id: 'tim', seed: 123, name: 'Pip', version: '0.1', shiny: false },
})

describe('desktop companion authority', () => {
  it('starts at the actual egg, follows hatch and every growth stage', () => {
    const bridge = new DesktopCompanion(vi.fn())
    expect(bridge.snapshot().enabled).toBe(false)
    for (let stage = 0; stage <= 4; stage++) {
      expect(bridge.update('socket-a', { ...egg(stage + 1), egg: { kind: 'first', stage: `p${stage}` } })).toBe(true)
      expect(bridge.snapshot().egg?.stage).toBe(`p${stage}`)
    }
    let revision = 6
    for (const stage of ['rock', 'burst', 'tumble', 'open', 'hatchling']) {
      expect(bridge.update('socket-a', { ...tim(revision++), phase: 'hatching', egg: { kind: 'first', stage } })).toBe(true)
      expect(bridge.snapshot().phase).toBe('hatching')
    }
    for (const version of ['0.1', '1.0', '2.0']) {
      const state = tim(revision++)
      state.creature.version = version
      expect(bridge.update('socket-a', state)).toBe(true)
      expect(bridge.snapshot().creature).toMatchObject({ uid: 'tim-123', seed: 123, name: 'Pip', version })
    }
  })

  it('follows the chosen desktop window and never another window heartbeat', () => {
    const bridge = new DesktopCompanion(vi.fn())
    bridge.update('socket-a', egg())
    bridge.update('socket-b', { ...egg(1, 'desktop-b'), foreground: false })
    expect(bridge.snapshot().window).toBe('desktop-a')
    bridge.focus('desktop-b')
    bridge.update('socket-a', egg(2))
    expect(bridge.snapshot().window).toBe('desktop-b')
    bridge.disconnect('socket-a')
    expect(bridge.snapshot().enabled).toBe(true)
    bridge.disconnect('socket-b')
    expect(bridge.snapshot().enabled).toBe(false)
  })

  it('reconnects immediately and rejects late packets from the old socket', () => {
    const bridge = new DesktopCompanion(vi.fn())
    bridge.update('old', egg())
    expect(bridge.update('new', egg(2))).toBe(true)
    bridge.disconnect('old')
    expect(bridge.snapshot().enabled).toBe(true)
    expect(bridge.update('old', egg(3))).toBe(false)
    expect(bridge.update('new', egg(1))).toBe(false)
    expect(bridge.snapshot().revision).toBe(2)
  })

  it('turning off and changing accounts removes previous identity', () => {
    const bridge = new DesktopCompanion(vi.fn())
    bridge.update('socket', tim())
    bridge.update('socket', { ...egg(2), epoch: 2, enabled: false })
    expect(bridge.snapshot().creature).toBeUndefined()
    expect(bridge.snapshot().enabled).toBe(false)
    expect(bridge.update('socket', tim(3))).toBe(false)
    expect(bridge.update('socket', { ...egg(4), epoch: 2 })).toBe(true)
  })

  it('a retry or reconnect snapshot cannot extend a merge celebration', () => {
    let now = 1000
    const bridge = new DesktopCompanion(vi.fn(), () => now)
    const merged = { ...tim(), feeling: { emotion: 'excited', reason: 'merged',
      intensity: 3, reactionId: 'merge:repo/442', remainingMs: 9000 } }
    bridge.update('socket', merged)
    now += 5000
    bridge.update('socket', { ...merged, revision: 2 })
    expect(bridge.snapshot().feeling?.remainingMs).toBe(4000)
    now += 5000
    expect(bridge.snapshot().feeling?.remainingMs).toBe(0)
  })

  it('rejects malformed state and drops fields unrelated to presentation', () => {
    for (const bad of [null, [], {}, { ...egg(), v: 2 }, { ...egg(), phase: ['egg'] },
      { ...egg(), revision: -1 }, { ...egg(), epoch: Infinity },
      { ...tim(), creature: { ...tim().creature, seed: 0x100000000 } },
      { ...egg(), feeling: { emotion: 'excited', reason: 'terminal prose!', intensity: 1 } }]) {
      expect(parseCompanionState(bad)).toBeNull()
    }
    expect(parseCompanionState({ ...egg(), prompt: 'never to USB', token: 'secret' })).toEqual(egg())
  })
})
