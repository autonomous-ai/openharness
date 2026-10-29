import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { ScreenReading } from '../../engines/facets/screen.js'
import { AutonomousDeviceInput } from '../../core/deviceInput.js'
import { inlineSubmission } from '../../testing/inlineSubmission.js'
import { createSuperTabTerminal } from './terminal.js'

const session = { agentId: 'h1', engine: 'claude' } as RegisteredSession
const reading = (messageHold: ScreenReading['messageHold']) => ({ messageHold } as ScreenReading)

function setup(over: { captured?: string | null; reading?: ScreenReading | null; typed?: boolean; keyed?: (key: string) => boolean } = {}) {
  const writes: string[] = [], lockedFor: string[] = []
  const deps = {
    resolve: vi.fn((id: string) => id === 'h1' ? session : undefined),
    capture: vi.fn(async () => over.captured === null ? { state: 'failed' as const, reason: 'pane gone' } : { state: 'succeeded' as const, value: over.captured ?? 'Allow? \u001b[1m1. Yes\u001b[0m' }),
    read: vi.fn(async () => over.reading === undefined ? reading('permission_open') : over.reading),
    type: vi.fn(async (_id: string, text: string) => { writes.push(`text:${text}`); return over.typed ?? true }),
    key: vi.fn(async (_id: string, key: string) => { writes.push(`key:${key}`); return over.keyed?.(key) ?? true }),
    locked: <T>(id: string, write: () => Promise<T>) => { lockedFor.push(id); return write() },
  }
  return { deps, writes, lockedFor, terminal: createSuperTabTerminal(deps) }
}

describe('a Lead reading and typing into a Swarm member\'s terminal', () => {
  it('reads the visible screen as plain text, with what the screen reader says it waits on', async () => {
    const { deps, terminal } = setup()
    expect(await terminal.screen('h1', 0)).toEqual({ ok: true, text: 'Allow? 1. Yes', hold: 'permission_open' })
    expect(deps.capture).toHaveBeenCalledWith(session, { mode: 'visible', ansi: false })
    expect(deps.read).toHaveBeenCalledWith(session, 'Allow? 1. Yes')
  })

  it('adds scrollback on request, never more than 200 lines', async () => {
    const { deps, terminal } = setup({ reading: null })
    expect(await terminal.screen('h1', 50)).toEqual({ ok: true, text: 'Allow? 1. Yes', hold: null })
    expect(deps.capture).toHaveBeenLastCalledWith(session, { mode: 'recent_unwrapped', historyLines: 50, ansi: false })
    await terminal.screen('h1', 5_000)
    expect(deps.capture).toHaveBeenLastCalledWith(session, { mode: 'recent_unwrapped', historyLines: 200, ansi: false })
  })

  it('says plainly when the agent or its screen is not there', async () => {
    expect(await setup().terminal.screen('gone', 0)).toEqual({ ok: false, error: 'The agent is not running on this machine.' })
    expect(await setup({ captured: null }).terminal.screen('h1', 0)).toEqual({ ok: false, error: 'Could not read the terminal: pane gone' })
  })

  it('types the text, then each key in order, under the pane\'s write lock', async () => {
    const { lockedFor, writes, terminal } = setup()
    expect(await terminal.input('h1', 'yes', ['Down', 'Enter'])).toEqual({ ok: true })
    expect(writes).toEqual(['text:yes', 'key:Down', 'key:Enter'])
    expect(lockedFor).toEqual(['h1'])
    writes.length = 0
    expect(await terminal.input('h1', '', ['1'])).toEqual({ ok: true })
    expect(writes).toEqual(['key:1'])
  })

  it('stops at the first write the terminal refuses, and refuses an agent that is not here or nothing to type', async () => {
    const refused = setup({ keyed: key => key !== 'Up' })
    expect(await refused.terminal.input('h1', 'a', ['Up', 'Enter'])).toEqual({ ok: false, error: 'The terminal did not take the key Up.' })
    expect(refused.writes).toEqual(['text:a', 'key:Up'])
    const untyped = setup({ typed: false })
    expect(await untyped.terminal.input('h1', 'a', ['Enter'])).toEqual({ ok: false, error: 'The terminal did not take the text.' })
    expect(untyped.writes).toEqual(['text:a'])
    expect(await setup().terminal.input('gone', 'a', [])).toEqual({ ok: false, error: 'The agent is not running on this machine.' })
    expect(await setup().terminal.input('h1', '', [])).toEqual({ ok: false, error: 'Nothing to type.' })
  })
})

describe('typing keys only while the screen is still the one that was read', () => {
  const PROMPT = 'Update available · 0.165.0 → 99.0.0\n› 1. Update now\n  2. Skip\n  enter continue · esc skip'
  /** A pane whose screen the test changes, and a write lock the test can hold while "another writer" works. */
  function pane(first: string) {
    let screen = first, release = () => {}
    const writes: string[] = []
    const held = new Promise<void>(resolve => { release = resolve })
    const terminal = createSuperTabTerminal({
      resolve: id => id === 'h1' ? session : undefined,
      capture: async () => ({ state: 'succeeded' as const, value: screen }),
      read: async () => null,
      type: async (_id, text) => { writes.push(`text:${text}`); return true },
      key: async (_id, key) => { writes.push(`key:${key}`); return true },
      locked: async (_id, write) => { await held; return write() },
    })
    return { terminal, writes, show: (next: string) => { screen = next }, release: () => release() }
  }

  it('sends the keys once the screen, read again under the pane\'s write lock, is exactly the one given', async () => {
    const t = pane(PROMPT)
    const done = t.terminal.inputIfScreen('h1', ['Escape'], PROMPT)
    t.release()
    expect(await done).toEqual({ ok: true })
    expect(t.writes).toEqual(['key:Escape'])
  })

  it('sends nothing when another writer changed the screen while this write waited for the lock', async () => {
    const t = pane(PROMPT)
    const done = t.terminal.inputIfScreen('h1', ['Escape'], PROMPT)
    t.show('› Write tests')
    t.release()
    expect(await done).toEqual({ ok: false, error: 'The screen changed before the keys were sent; nothing was typed.' })
    expect(t.writes).toEqual([])
  })

  it('sends nothing for a screen that differs in the least, even by a trailing line', async () => {
    const t = pane(`${PROMPT}\n`)
    t.release()
    expect(await t.terminal.inputIfScreen('h1', ['Escape'], PROMPT)).toMatchObject({ ok: false })
    expect(t.writes).toEqual([])
  })

  it('says plainly when the agent or its screen is not there, or the terminal does not take a key, and types nothing for no keys', async () => {
    expect(await setup().terminal.inputIfScreen('gone', ['Escape'], 'x')).toEqual({ ok: false, error: 'The agent is not running on this machine.' })
    expect(await setup({ captured: null }).terminal.inputIfScreen('h1', ['Escape'], 'x')).toEqual({ ok: false, error: 'Could not read the terminal: pane gone' })
    const refused = setup({ captured: 'x', keyed: () => false })
    expect(await refused.terminal.inputIfScreen('h1', ['Escape'], 'x')).toEqual({ ok: false, error: 'The terminal did not take the key Escape.' })
    expect(await setup().terminal.inputIfScreen('h1', [], 'Allow? 1. Yes')).toEqual({ ok: false, error: 'Nothing to type.' })
  })
})

// In production the pane's lock is the device input's `legacyWrite`, which runs two ordinary writers at once: only the
// Swarm terminal's own mutex keeps the Lead's typed input and the host's conditional key from overlapping (review of 6c82a2cbd,
// reproduced with these real classes: the Lead's Esc cleared the prompt and the dismissal sent its Esc into the composer).
describe('the Lead\'s typed input and the host\'s conditional keys on one pane, under the real write guard', () => {
  const UPDATE = 'Update available\n› 1. Update now\n  2. Skip\n  enter continue · esc skip', COMPOSER = '› '
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

  /** A pane that shows the update prompt until its first Esc, whose writes wait on `gate`, as a slow terminal does. */
  function realPane() {
    let screen = UPDATE, open = () => {}
    const gate = new Promise<void>(resolve => { open = resolve })
    const landed: Array<{ key: string; on: string }> = []
    const device = new AutonomousDeviceInput({
      getSession: () => session, validateRuntime: async () => true, inject: async () => true, sendKey: async () => true,
      capture: async () => '› ', submission: inlineSubmission, acquireControl: () => () => {}, legacySubmit: vi.fn(), legacyCancel: () => false,
      onDelivery: vi.fn(), onInputStatus: vi.fn(),
    })
    const terminal = createSuperTabTerminal({
      resolve: id => id === 'h1' ? session : undefined,
      capture: async () => ({ state: 'succeeded' as const, value: screen }),
      read: async () => null,
      type: async () => true,
      key: async (_id, key) => { await gate; landed.push({ key, on: screen }); if (key === 'Escape') screen = COMPOSER; return true },
      locked: (id, write) => device.legacyWrite(id, write),
    })
    return { terminal, landed, open: () => open() }
  }

  it('sends the conditional Esc into the update prompt only: the Lead\'s Esc, started first, clears it and the dismissal sends nothing', async () => {
    const t = realPane()
    const lead = t.terminal.input('h1', '', ['Escape'])
    const dismissal = t.terminal.inputIfScreen('h1', ['Escape'], UPDATE)
    await flush()
    t.open()
    expect(await lead).toEqual({ ok: true })
    expect(await dismissal).toMatchObject({ ok: false })
    expect(t.landed).toEqual([{ key: 'Escape', on: UPDATE }])
  })

  it('runs the two strictly in turn when the dismissal comes first', async () => {
    const t = realPane()
    const dismissal = t.terminal.inputIfScreen('h1', ['Escape'], UPDATE)
    const lead = t.terminal.input('h1', '', ['Escape'])
    await flush()
    t.open()
    expect(await dismissal).toEqual({ ok: true })
    expect(await lead).toEqual({ ok: true })
    // Strictly in turn: the dismissal's Esc found the prompt; the Lead's own Esc came after, as the Lead asked.
    expect(t.landed).toEqual([{ key: 'Escape', on: UPDATE }, { key: 'Escape', on: COMPOSER }])
  })

  it('goes on with the next writer after one whose write threw, and after the agent has gone while it waited', async () => {
    let thrown = false, there = true
    const terminal = createSuperTabTerminal({
      resolve: id => id === 'h1' && there ? session : undefined,
      capture: async () => ({ state: 'succeeded' as const, value: UPDATE }),
      read: async () => null, type: async () => true,
      key: async () => { if (!thrown) { thrown = true; there = false; throw new Error('pane gone') } return true },
      locked: (_id, write) => write(),
    })
    const first = terminal.input('h1', '', ['Escape'])
    const second = terminal.inputIfScreen('h1', ['Escape'], UPDATE)
    await expect(first).rejects.toThrow('pane gone')
    expect(await second).toEqual({ ok: false, error: 'The agent is not running on this machine.' })
    there = true
    expect(await terminal.inputIfScreen('h1', ['Escape'], UPDATE)).toEqual({ ok: true })
  })
})
