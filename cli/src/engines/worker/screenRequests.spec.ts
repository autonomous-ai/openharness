import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screenFor } from '../screens.js'
import { engineScreenRequests } from './screenRequests.js'
import { screenReading, SCREEN_CAPABILITIES, SCREEN_CAPTURE_BYTES, SCREEN_IN_FLIGHT, SCREEN_READ, SCREEN_REPLY_BYTES, SCREEN_WAIT_MS } from './screenProtocol.js'

const who = { owner: true, local: true }
const capture = '────────────\n❯\n────────────\n? for shortcuts'
const payload = { version: 1, capture }
const answer = screenFor('claude').inspect(capture)
const fail = (error: string) => ({ version: 1, error })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('read-only engine screen workers', () => {
  it.each(['claude', 'codex'] as const)('%s preserves recorded permission evidence', async engine => {
    const text = readFileSync(new URL(`../../lib/__fixtures__/permission-${engine}.txt`, import.meta.url), 'utf8')
    const requests = engineScreenRequests(engine)
    expect(await requests[SCREEN_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, screen: 1, engine })
    const reply = await requests[SCREEN_READ]({ version: 1, capture: text }, who)
    expect(reply).toEqual({ version: 1, answer: screenFor(engine).inspect(text) })
    expect((reply as any).answer.messageHold).toBe('permission_open')
    expect(screenReading((reply as any).answer)).toBe(true)
  })
  it('accepts only private local core requests and bounded captures', async () => {
    const load = vi.fn(async () => screenFor('claude'))
    const requests = engineScreenRequests('claude', { load })
    const send = (p = payload, asker = who, closed?: AbortSignal) => requests[SCREEN_READ](p, asker, closed)
    for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...who, connection: 'client' }]) {
      expect(await send(payload, asker)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    }
    for (const p of [{ version: 2, capture }, { version: 1, capture: 42 }, { ...payload, terminal: 'agent' },
      { ...payload, capture: 'é'.repeat(SCREEN_CAPTURE_BYTES) }]) {
      expect(await send(p as typeof payload)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    }
    expect(await send(payload, who, AbortSignal.abort())).toEqual(fail('ENGINE_UNAVAILABLE'))
    expect(load).not.toHaveBeenCalled()
    expect(await requests[SCREEN_CAPABILITIES]({ version: 1 }, who)).toMatchObject({ screen: 1 })
    expect(load).not.toHaveBeenCalled()
    expect(await send({ ...payload, requestId: 'core-route-1' } as typeof payload)).toEqual({ version: 1, answer })
    expect(await send({ ...payload, requestId: 1 } as unknown as typeof payload)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    expect(await send({ ...payload, requestId: 'x'.repeat(201) } as typeof payload)).toEqual(fail('ENGINE_INVALID_REQUEST'))
    expect(await send()).toEqual({ version: 1, answer })
    expect(load).toHaveBeenCalledOnce()
  })
  it('bounds concurrent loads and contains a stopped or failed parser', async () => {
    vi.useFakeTimers()
    const recycle = vi.fn()
    let finish!: (value: ReturnType<typeof screenFor>) => void
    const requests = engineScreenRequests('claude', { recycle, load: () => new Promise(resolve => { finish = resolve }) })
    const send = () => requests[SCREEN_READ](payload, who)
    const pending = Array.from({ length: SCREEN_IN_FLIGHT }, send)
    expect(await send()).toEqual(fail('ENGINE_BUSY'))
    await vi.advanceTimersByTimeAsync(SCREEN_WAIT_MS)
    for (const read of pending) expect(await read).toEqual(fail('ENGINE_UNAVAILABLE'))
    expect(recycle).toHaveBeenCalled()
    finish(screenFor('claude'))
    const load = vi.fn().mockRejectedValueOnce(new Error('import failed')).mockResolvedValue(screenFor('claude'))
    const retry = engineScreenRequests('claude', { load })
    expect(await retry[SCREEN_READ](payload, who)).toEqual(fail('ENGINE_UNAVAILABLE'))
    expect(await retry[SCREEN_READ](payload, who)).toEqual({ version: 1, answer })
  })
  it('drops disconnected work and rejects faulty adapter output', async () => {
    const closed = new AbortController()
    const requests = engineScreenRequests('claude', { load: async () => { closed.abort(); return screenFor('claude') } })
    expect(await requests[SCREEN_READ](payload, who, closed.signal)).toEqual(fail('ENGINE_UNAVAILABLE'))
    for (const [result, error] of [[{}, 'ENGINE_INVALID_REPLY'], [{ ...answer, teamHold: 'invented' }, 'ENGINE_INVALID_REPLY'],
      [{ ...answer, extra: 'x'.repeat(SCREEN_REPLY_BYTES) }, 'ENGINE_REPLY_TOO_LARGE']] as const) {
      const worker = engineScreenRequests('claude', { load: async () => ({ inspect: () => result as typeof answer }) })
      expect(await worker[SCREEN_READ](payload, who)).toEqual(fail(error))
    }
    const throwing = engineScreenRequests('claude', { load: async () => ({ inspect: () => { throw new Error('bad decoder') } }) })
    expect(await throwing[SCREEN_READ](payload, who)).toEqual(fail('ENGINE_UNAVAILABLE'))
  })
  it('rejects malformed UI facts before any caller can treat a pane as writable', () => {
    for (const value of [null, [], {}, { ...answer, pane: { ...answer.pane, draft: true } },
      { ...answer, question: { kind: 'review', submitRow: 'C-c' } }, { ...answer, activity: { label: 2, indicator: '' } },
      { ...answer, question: { kind: 'question', rows: [], question: 'approve?', multi: false, typeRow: null } },
      { ...answer, messageHold: 'unknown' }, { ...answer, execute: 'Enter' }]) expect(screenReading(value)).toBe(false)
    expect(screenReading({ ...answer, question: { kind: 'review', submitRow: '1' }, messageHold: 'question_open' })).toBe(true)
  })
})
