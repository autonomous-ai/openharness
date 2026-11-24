import { describe, expect, it, vi } from 'vitest'
import { firstOuter, type OuterLookup } from './outer.js'
import type { Nest } from './types.js'

type Answer = ReturnType<OuterLookup>

/** A lookup that records its calls and answers what the test sets. */
function lookup(answer: () => Answer): OuterLookup & { calls: [Readonly<Record<string, string>>, number][] } {
  const calls: [Readonly<Record<string, string>>, number][] = []
  return Object.assign(
    (hints: Readonly<Record<string, string>>, pid: number) => {
      calls.push([hints, pid])
      return answer()
    },
    { calls },
  )
}

const hints = { TMUX_PANE: '%3' }

describe('the first lookup that finds an app', () => {
  it('the first\'s answer when it names an app, and the second is not asked', async () => {
    const first = lookup(() => Promise.resolve({ app: 'terminal-app', tty: '/dev/ttys004' }))
    const second = lookup(() => Promise.resolve({ app: 'ghostty' }))
    expect(await firstOuter(first, second)(hints, 42)).toEqual({ app: 'terminal-app', tty: '/dev/ttys004' })
    expect(first.calls).toEqual([[hints, 42]])
    expect(second.calls).toEqual([])
  })

  it('the second\'s answer when the first\'s names none', async () => {
    let settle: (place: { app?: string; tty?: string }) => void = () => {}
    const first = lookup(() => new Promise((resolve) => { settle = resolve }))
    const second = lookup(() => Promise.resolve({ app: 'ghostty' }))
    const answer = firstOuter(first, second)(hints, 42)
    await Promise.resolve()
    expect(second.calls).toEqual([])
    settle({})
    expect(await answer).toEqual({ app: 'ghostty' })
    expect(second.calls).toEqual([[hints, 42]])
  })

  it('{} when the first answered none and the second is not nested', async () => {
    const first = lookup(() => Promise.resolve({}))
    const second = lookup(() => undefined)
    expect(await firstOuter(first, second)(hints, 42)).toEqual({})
    expect(second.calls).toEqual([[hints, 42]])
  })

  it('a first answer with a client\'s process and no app is kept when the second names none', async () => {
    const first = lookup(() => Promise.resolve({ pid: 7 }))
    const second = lookup(() => Promise.resolve({}))
    expect(await firstOuter(first, second)(hints, 42)).toEqual({ pid: 7 })
  })

  it('the second\'s answer when it names an app', async () => {
    const first = lookup(() => Promise.resolve({ pid: 7 }))
    const second = lookup(() => Promise.resolve({ app: 'wezterm', pid: 9 }))
    expect(await firstOuter(first, second)(hints, 42)).toEqual({ app: 'wezterm', pid: 9 })
  })

  it('the second not nested: the first\'s', async () => {
    const first = lookup(() => Promise.resolve({ pid: 7 }))
    const second = lookup(() => undefined)
    expect(await firstOuter(first, second)(hints, 42)).toEqual({ pid: 7 })
  })

  it('the second\'s answer when the first is not nested', async () => {
    const first = lookup(() => undefined)
    const second = lookup(() => Promise.resolve({ app: 'iterm' }))
    expect(await firstOuter(first, second)(hints, 42)).toEqual({ app: 'iterm' })
    expect(second.calls).toEqual([[hints, 42]])
  })

  it('undefined at once when neither is nested', () => {
    expect(firstOuter(lookup(() => undefined), lookup(() => undefined))(hints, 42)).toBeUndefined()
  })

  it('the answer says the multiplexer that made the agent\'s terminal: the first lookup\'s, else the second\'s', async () => {
    type Place = NonNullable<Awaited<Answer>>
    const of = (first: Place, second: Place) =>
      firstOuter(lookup(() => Promise.resolve(first)), lookup(() => Promise.resolve(second)))(hints, 42)
    // tmux inside a herdr pane: herdr's server made no terminal of the caller's, tmux's did.
    expect(await of({}, { app: 'iterm', tty: '/dev/ttys002', pid: 4300, nest: 'tmux' })).toEqual({ app: 'iterm', tty: '/dev/ttys002', pid: 4300, nest: 'tmux' })
    // Detached: no client, still tmux's pane.
    expect(await of({}, { nest: 'tmux' })).toEqual({ nest: 'tmux' })
    // herdr inside the person's tmux: herdr's client is in no app, its process alone.
    expect(await of({ pid: 4400, nest: 'herdr' }, {})).toEqual({ pid: 4400, nest: 'herdr' })
    // Zellij's answer carries none.
    expect(await of({}, { app: 'ghostty' })).toEqual({ app: 'ghostty' })
  })

  // A herdr pane in iTerm2 stayed on iTerm2's page while herdr's client steps ran (Mac eval IH4, 2026-11-24).
  it('the multiplexer is told as its lookup reads it made the agent\'s terminal: the first\'s, else the second\'s', async () => {
    type Place = NonNullable<Awaited<Answer>>
    /** A lookup that tells [nest] at once, then answers [place]. */
    const telling = (nest: Nest | undefined, place: Place): OuterLookup => (_hints, _pid, made) => {
      if (nest) made?.(nest)
      return Promise.resolve(place)
    }
    const told = async (first: OuterLookup, second: OuterLookup) => {
      const made = vi.fn()
      await firstOuter(first, second)(hints, 42, made)
      return made.mock.calls
    }
    // herdr inside the person's tmux, its client in no app: herdr's alone, the second is not told.
    expect(await told(telling('herdr', { nest: 'herdr' }), telling('tmux', { app: 'iterm', nest: 'tmux' }))).toEqual([['herdr']])
    // tmux inside a herdr pane: herdr's server made no terminal of the caller's, tmux's did.
    expect(await told(telling(undefined, {}), telling('tmux', { nest: 'tmux' }))).toEqual([['tmux']])
    // The first not nested.
    expect(await told(() => undefined, telling('tmux', { nest: 'tmux' }))).toEqual([['tmux']])
  })
})
