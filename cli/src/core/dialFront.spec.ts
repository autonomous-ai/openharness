import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDialFront, FRONT_APPS } from './dialFront.js'

// The devices' app ids (cable/hosts/hostDetect.ts, with `claude`), written out so a change to the set is seen here.
const APPS = ['harness', 'orca', 'herdr', 'rex', 'zellij', 'kitty', 'wezterm', 'iterm', 'terminal-app', 'ghostty',
  'vscode', 'cursor', 'warp', 'terminal', 'claude']

describe('createDialFront', () => {
  afterEach(() => { vi.useRealTimers() })

  it('forwards a known app and none', () => {
    expect([...FRONT_APPS].sort()).toEqual([...APPS, 'none'].sort())
    for (const app of [...APPS, 'none']) {
      const forward = vi.fn(() => true)
      createDialFront({ forward, now: () => 0 }).connection()({ app })
      expect(forward.mock.calls).toEqual([[app]])
    }
  })

  it.each([
    ['a non-object', 'ghostty'],
    ['null', null],
    ['an array', ['ghostty']],
    ['no app', {}],
    ['a number', { app: 7 }],
    ['an empty app', { app: '' }],
    ['a name, not an id', { app: 'Ghostty' }],
    ['a raw bundle id', { app: 'com.mitchellh.ghostty' }],
    ['the old word other', { app: 'other' }],
    ['the unknown app\'s display name', { app: 'Other' }],
    ['a name every object has', { app: 'constructor' }],
    ['a 5000-character string', { app: 'x'.repeat(5000) }],
  ])('refuses %s', (_name, payload) => {
    const forward = vi.fn(() => true)
    createDialFront({ forward, now: () => 0 }).connection()(payload)
    expect(forward).not.toHaveBeenCalled()
  })

  it("the 11th frame within a second is dropped; another connection's is kept", () => {
    const forward = vi.fn(() => true)
    const front = createDialFront({ forward, now: () => 1000 })
    const gate = front.connection()
    for (let i = 0; i < 11; i += 1) gate({ app: 'ghostty' })
    expect(forward).toHaveBeenCalledTimes(10)
    front.connection()({ app: 'vscode' })
    expect(forward).toHaveBeenCalledTimes(11)
    expect(forward).toHaveBeenLastCalledWith('vscode')
  })

  it('a second later ten more pass', () => {
    let clock = 0
    const forward = vi.fn(() => true)
    const gate = createDialFront({ forward, now: () => clock }).connection()
    for (let i = 0; i < 11; i += 1) gate({ app: 'ghostty' })
    // The bucket refills as time passes, a frame every tenth of a second, not all at once.
    clock += 100
    gate({ app: 'ghostty' })
    gate({ app: 'ghostty' })
    expect(forward).toHaveBeenCalledTimes(11)
    clock += 1000
    for (let i = 0; i < 11; i += 1) gate({ app: 'vscode' })
    expect(forward).toHaveBeenCalledTimes(21)
  })

  it('a clock set back refills nothing', () => {
    let clock = 10_000
    const forward = vi.fn(() => true)
    const gate = createDialFront({ forward, now: () => clock }).connection()
    for (let i = 0; i < 10; i += 1) gate({ app: 'ghostty' })
    clock = 0
    gate({ app: 'ghostty' })
    expect(forward).toHaveBeenCalledTimes(10)
    clock += 1000
    for (let i = 0; i < 11; i += 1) gate({ app: 'ghostty' })
    expect(forward).toHaveBeenCalledTimes(20)
  })

  it('forward false is dropped, not an error', () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const gate = createDialFront({ forward: () => false, now: () => 0, log }).connection()
    expect(() => gate({ app: 'ghostty' })).not.toThrow()
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls).toEqual([['[devices] dial front in the last minute: 0 refused, 1 dropped']])
  })

  it("the minute's line has counts and nothing of what was sent", () => {
    vi.useFakeTimers()
    const log = vi.fn()
    let devices = true
    let clock = 0
    const gate = createDialFront({ forward: () => devices, now: () => clock, log }).connection()
    gate({ app: 'com.mitchellh.ghostty' })
    gate('Safari')
    for (let i = 0; i < 11; i += 1) gate({ app: 'ghostty' })
    devices = false
    clock += 1000
    gate({ app: 'vscode' })
    expect(log).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls).toEqual([['[devices] dial front in the last minute: 2 refused, 2 dropped']])
    vi.advanceTimersByTime(120_000)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ghostty|safari|vscode|VS Code/i)
  })

  it('keeps nothing', () => {
    const forward = vi.fn(() => true)
    const front = createDialFront({ forward, now: () => 0 })
    const gate = front.connection()
    gate({ app: 'ghostty', path: '/secret/work' })
    // Only the app id goes on, never the frame it came in.
    expect(forward.mock.calls).toEqual([['ghostty']])
    expect(Object.keys(front)).toEqual(['connection'])
    expect(Object.keys(gate)).toEqual([])
    expect(JSON.stringify(front)).not.toMatch(/ghostty/)
  })
})
