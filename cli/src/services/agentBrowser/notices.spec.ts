import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnDelivery } from '../../core/api.js'
import { Notices, NOTICE_RETRY_MS, READY_LINE, STOPPED_LINE } from './notices.js'
import { defaultSettings } from './settings.js'
import { StateFile } from './stateFile.js'

const settings = defaultSettings({ timeZone: 'UTC', languages: 'en-US' })

/** The core's turns as the service sees them: what was typed, what was taken back, and what it hears. */
function fakeTurns() {
  const typed: Array<{ agentId: string; text: string; deliveryId: string }> = []
  const listeners = new Set<(event: TurnDelivery) => void>()
  let cancels = true
  const turns = {
    deliver: vi.fn((agentId: string, text: string, deliveryId: string) => { typed.push({ agentId, text, deliveryId }) }),
    cancelDelivery: vi.fn((_deliveryId: string) => cancels),
    onDelivery: vi.fn((listener: (event: TurnDelivery) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  }
  return {
    turns,
    typed,
    listeners,
    /** Whether the core can still take a delivery back. */
    cancels(can: boolean) { cancels = can },
    hear(deliveryId: string, state: TurnDelivery['state'], reason?: string) {
      for (const listener of [...listeners]) listener({ deliveryId, sessionId: deliveryId.split(':')[1]!, state, reason })
    },
    last() { return typed.at(-1)! },
  }
}

let dir: string
let path: string
let state: StateFile
let core: ReturnType<typeof fakeTurns>
let measure: ReturnType<typeof vi.fn<(name: string) => void>>
let log: ReturnType<typeof vi.fn<(line: string) => void>>
let notices: Notices

function make(): Notices {
  return new Notices({ state, turns: core.turns, measure, log })
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'agent-browser-notices-'))
  path = join(dir, 'agent-browser.json')
  state = new StateFile(path)
  state.update(s => { s.browsers.a1 = settings; s.browsers.a2 = settings })
  core = fakeTurns()
  measure = vi.fn<(name: string) => void>()
  log = vi.fn<(line: string) => void>()
  notices = make()
})
afterEach(() => {
  notices.close()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

const told = () => state.read().told ?? {}

describe('Notices', () => {
  it('the first ready types the ready line once, and the mark is set when it is written', () => {
    notices.ready('a1')
    expect(core.typed).toEqual([{ agentId: 'a1', text: READY_LINE, deliveryId: expect.stringMatching(/^agent-browser:a1:ready:[0-9a-f-]{36}$/) }])
    expect(told()).toEqual({})
    core.hear(core.last().deliveryId, 'queued')
    expect(told()).toEqual({})
    notices.ready('a1')
    expect(core.typed).toHaveLength(1)
    core.hear(core.last().deliveryId, 'delivered')
    expect(told()).toEqual({ a1: true })
    // Its turn starting after it was written changes nothing.
    core.hear(core.last().deliveryId, 'started')
    expect(core.typed).toHaveLength(1)
  })

  it('a started outcome sets the mark as well', () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'started')
    expect(told()).toEqual({ a1: true })
  })

  it('a second ready, a daemon restart (a new Notices on the same file) and a resume type nothing', () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'delivered')
    notices.ready('a1')
    notices.close()
    notices = make()
    notices.ready('a1')
    // A resume: the agent's end, then its browser ready again.
    notices.ended('a1')
    notices.ready('a1')
    expect(core.typed).toHaveLength(1)
    expect(core.turns.cancelDelivery).not.toHaveBeenCalled()
  })

  it('an entry with no mark is told once', () => {
    state.update(s => { s.told = { a2: true } })
    notices.ready('a2')
    notices.ready('a1')
    expect(core.typed.map(t => t.agentId)).toEqual(['a1'])
    core.hear(core.last().deliveryId, 'delivered')
    notices.ready('a1')
    expect(core.typed).toHaveLength(1)
    expect(told()).toEqual({ a1: true, a2: true })
  })

  it("the person's Stop types the stop line and clears the mark, and the next ready is told again", () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'delivered')
    notices.stopped('a1', false)
    expect(core.last()).toEqual({ agentId: 'a1', text: STOPPED_LINE, deliveryId: expect.stringMatching(/^agent-browser:a1:stopped:/) })
    expect(told()).toEqual({})
    core.hear(core.last().deliveryId, 'delivered')
    expect(told()).toEqual({})
    notices.ready('a1')
    expect(core.typed.map(t => t.text)).toEqual([READY_LINE, STOPPED_LINE, READY_LINE])
  })

  it('a command that said the stop line: nothing is typed', () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'delivered')
    notices.stopped('a1', true)
    expect(core.typed).toHaveLength(1)
    expect(told()).toEqual({})
  })

  it('a ready line still waiting is taken back and no stop line follows', () => {
    notices.ready('a1')
    const ready = core.last().deliveryId
    notices.stopped('a1', false)
    expect(core.turns.cancelDelivery).toHaveBeenCalledWith(ready)
    // A late word about it is not one the service still waits for.
    core.hear(ready, 'delivered')
    expect(core.typed).toHaveLength(1)
    expect(told()).toEqual({})
  })

  it('a ready line the core takes back later, in its own process, is followed by nothing', () => {
    core.cancels(false)
    notices.ready('a1')
    const ready = core.last().deliveryId
    notices.stopped('a1', false)
    core.hear(ready, 'rejected', 'cancelled')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(1)
    expect(told()).toEqual({})
  })

  it('a ready line that was already being written when Stop came is followed by the stop line, and leaves no mark', () => {
    core.cancels(false)
    notices.ready('a1')
    const ready = core.last().deliveryId
    notices.stopped('a1', false)
    core.hear(ready, 'started')
    expect(core.typed.map(t => t.text)).toEqual([READY_LINE, STOPPED_LINE])
    expect(told()).toEqual({})
  })

  it('a ready line being written when Stop came: no stop line when a command said it, when its outcome is unknown, or after a new Start', () => {
    core.cancels(false)
    // Another agent's line on its way is not this agent's.
    notices.ready('a2')
    notices.ready('a1')
    notices.stopped('a1', true)
    core.hear(core.last().deliveryId, 'delivered')

    notices.ready('a1')
    notices.stopped('a1', false)
    core.hear(core.last().deliveryId, 'unknown')

    notices.ready('a1')
    const first = core.last().deliveryId
    notices.stopped('a1', false)
    notices.ready('a1')
    const second = core.last().deliveryId
    core.hear(first, 'delivered')
    expect(core.typed.filter(t => t.agentId === 'a1').map(t => t.text)).toEqual([READY_LINE, READY_LINE, READY_LINE, READY_LINE])
    expect(told()).toEqual({})
    core.hear(second, 'delivered')
    expect(told()).toEqual({ a1: true })
  })

  it('a line the core gives up on is delivered again after 30 s and 60 s, then logged and counted, and the browser stays owed', () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'rejected', 'queue_expired')
    notices.ready('a1')
    expect(core.typed).toHaveLength(1)
    vi.advanceTimersByTime(NOTICE_RETRY_MS - 1)
    expect(core.typed).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(core.typed).toHaveLength(2)
    expect(core.typed[1]!.deliveryId).not.toBe(core.typed[0]!.deliveryId)
    core.hear(core.last().deliveryId, 'rejected', 'queue_expired')
    vi.advanceTimersByTime(2 * NOTICE_RETRY_MS - 1)
    expect(core.typed).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(core.typed).toHaveLength(3)
    expect(measure).not.toHaveBeenCalled()
    core.hear(core.last().deliveryId, 'rejected', 'queue_expired')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(3)
    expect(core.typed.every(t => t.text === READY_LINE)).toBe(true)
    expect(measure.mock.calls).toEqual([['agent_browser_notice_failed']])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('notice_failed'))
    expect(told()).toEqual({})
    notices.ready('a1')
    expect(core.typed).toHaveLength(4)
  })

  it('the stop line is tried three times too', () => {
    state.update(s => { s.told = { a1: true } })
    notices.stopped('a1', false)
    core.hear(core.last().deliveryId, 'rejected', 'queue_expired')
    vi.advanceTimersByTime(NOTICE_RETRY_MS)
    core.hear(core.last().deliveryId, 'rejected', 'queue_expired')
    vi.advanceTimersByTime(2 * NOTICE_RETRY_MS)
    core.hear(core.last().deliveryId, 'rejected')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed.map(t => t.text)).toEqual([STOPPED_LINE, STOPPED_LINE, STOPPED_LINE])
    expect(measure.mock.calls).toEqual([['agent_browser_notice_failed']])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('notice_failed: the stopped line was not typed after 3 tries (rejected)'))
  })

  it('a stop while the ready line waits for its next try: it is never tried again and no stop line follows', () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'rejected', 'queue_expired')
    notices.stopped('a1', false)
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(1)
    expect(core.turns.cancelDelivery).not.toHaveBeenCalled()
  })

  it('an unknown outcome sets the mark and types nothing more', () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'unknown')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    notices.ready('a1')
    expect(core.typed).toHaveLength(1)
    expect(told()).toEqual({ a1: true })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('a1'))
  })

  it('a stop for an agent that was never told types nothing', () => {
    notices.stopped('a1', false)
    expect(core.typed).toEqual([])
    expect(core.turns.cancelDelivery).not.toHaveBeenCalled()
  })

  it('the agent ends while a line waits: it is taken back, no retry follows, and the next ready after its resume types the ready line', () => {
    // Waiting in the core, taken back at once.
    notices.ready('a1')
    const first = core.last().deliveryId
    notices.ended('a1')
    expect(core.turns.cancelDelivery).toHaveBeenLastCalledWith(first)
    core.hear(first, 'rejected', 'agent_gone')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(1)

    // Waiting for its next try.
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'rejected', 'agent_gone')
    notices.ended('a1')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(2)

    // Taken back in the core's own time.
    core.cancels(false)
    notices.ready('a1')
    notices.ended('a1')
    core.hear(core.last().deliveryId, 'rejected', 'cancelled')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(3)
    expect(told()).toEqual({})
    expect(measure).not.toHaveBeenCalled()

    notices.ready('a1')
    expect(core.typed).toHaveLength(4)
    expect(core.typed.every(t => t.text === READY_LINE)).toBe(true)
  })

  it('the agent ends while a line is being written: written, it is never typed again; the stop line is not followed up', () => {
    core.cancels(false)
    notices.ready('a1')
    notices.ended('a1')
    core.hear(core.last().deliveryId, 'delivered')
    expect(told()).toEqual({ a1: true })
    notices.ready('a1')
    expect(core.typed).toHaveLength(1)

    // A stop line taken back by the end, then written, ends there.
    notices.stopped('a1', false)
    notices.ended('a1')
    core.hear(core.last().deliveryId, 'delivered')
    // A ready line Stop took back, then the end: its late writing types no stop line.
    notices.ready('a1')
    notices.stopped('a1', false)
    notices.ended('a1')
    core.hear(core.last().deliveryId, 'started')
    expect(core.typed.map(t => t.text)).toEqual([READY_LINE, STOPPED_LINE, READY_LINE])
    expect(told()).toEqual({})
  })

  it("another service's deliveries are ignored", () => {
    notices.ready('a1')
    core.hear('team:d1', 'rejected')
    core.hear('agent-browser:a1:ready:not-ours', 'rejected')
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(1)
    expect(told()).toEqual({})
  })

  it('an unreadable state file types nothing and is logged', () => {
    writeFileSync(path, '{"browsers": {')
    notices.ready('a1')
    notices.stopped('a1', false)
    expect(core.typed).toEqual([])
    expect(log).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot be read'))
  })

  it('a mark that cannot be saved is logged', () => {
    notices.ready('a1')
    writeFileSync(path, '[]')
    core.hear(core.last().deliveryId, 'delivered')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not a browser state file'))
  })

  it('close stops hearing', () => {
    notices.ready('a1')
    core.hear(core.last().deliveryId, 'rejected', 'queue_expired')
    notices.ready('a2')
    notices.close()
    expect(core.listeners.size).toBe(0)
    vi.advanceTimersByTime(10 * NOTICE_RETRY_MS)
    expect(core.typed).toHaveLength(2)
  })
})
