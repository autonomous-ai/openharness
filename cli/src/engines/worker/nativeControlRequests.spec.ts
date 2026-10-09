import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineNativeControl, NativeStopHost } from '../facets/nativeControl.js'
import { NATIVE_UNCONFIRMED } from './nativeControlHost.js'
import { boundConversation, NATIVE_ACTIVITY, NATIVE_CONTROL_CAPABILITIES, NATIVE_CONTROL_HOST, NATIVE_QUERY_MS, NATIVE_RECOVER, NATIVE_STOP,
  NATIVE_STOP_IN_FLIGHT, NATIVE_STOP_WAIT_MS, nativeConversation, nativeStopAction, nativeStopAnswer } from './nativeControlProtocol.js'
import { engineNativeControlRequests } from './nativeControlRequests.js'

const who = { owner: true, local: true }
const conversation = { home: '/fixture/codex', sessionId: 'thread' }
const token = 'a'.repeat(64)
const stop = { version: 1, token, conversation }
const refused = (message: string) => ({ version: 1, answer: { refused: message } })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function setup(run: (host: NativeStopHost) => Promise<void> = async host => { await host.current() }, value = true) {
  const control: EngineNativeControl = {
    activity: vi.fn(async () => 'idle' as const), stop: vi.fn(async (_c, host) => run(host)), recover: vi.fn(async () => {}), close: vi.fn(),
  }
  const query = vi.fn(async (_query: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => ({ version: 1, value }))
  const load = vi.fn(async () => control), recycle = vi.fn()
  return { control, query, load, recycle, requests: engineNativeControlRequests('codex', { query, load, recycle }) }
}

describe('the Codex worker\'s control connection', () => {
  it('reads activity as a snapshot, and loads the control once, only when first asked', async () => {
    const t = setup()
    expect(await t.requests[NATIVE_CONTROL_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, nativeControl: 1, engine: 'codex' })
    expect(t.load).not.toHaveBeenCalled()
    expect(await t.requests[NATIVE_ACTIVITY]({ version: 1, conversation }, who)).toEqual({ version: 1, answer: 'idle' })
    expect(await t.requests[NATIVE_STOP](stop, who)).toEqual({ version: 1, answer: { stopped: true } })
    expect(await t.requests[NATIVE_RECOVER]({ version: 1, conversation }, who)).toEqual({ version: 1, answer: true })
    vi.mocked(t.control.recover).mockRejectedValueOnce(new Error('not archived'))
    expect(await t.requests[NATIVE_RECOVER]({ version: 1, conversation }, who)).toEqual({ version: 1, answer: false })
    // A recovery, like a stop, acts on a bound conversation only.
    expect(await t.requests[NATIVE_RECOVER]({ version: 1, conversation: { ...conversation, sessionId: '' } }, who)).toEqual({ version: 1, error: 'ENGINE_INVALID_REQUEST' })
    expect(t.load).toHaveBeenCalledOnce()
    expect(t.query).toHaveBeenCalledWith(NATIVE_CONTROL_HOST, { version: 1, token, action: { kind: 'current' } })
  })

  it('takes a stop only from core, privately, for a conversation it can name, four at a time', async () => {
    const t = setup(() => new Promise(() => {}))
    for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...who, connection: 'client' }]) {
      expect(await t.requests[NATIVE_STOP](stop, asker)).toEqual({ version: 1, error: 'ENGINE_INVALID_REQUEST' })
    }
    for (const payload of [{ ...stop, version: 2 }, { ...stop, token: 'short' }, { ...stop, conversation: { ...conversation, home: 'relative' } },
      { ...stop, pane: '%1' }, { ...stop, conversation: { ...conversation, owner: ['codex'] } }, { ...stop, conversation: { ...conversation, sessionId: '' } }]) {
      expect(await t.requests[NATIVE_STOP](payload, who)).toEqual({ version: 1, error: 'ENGINE_INVALID_REQUEST' })
    }
    expect(await t.requests[NATIVE_STOP](stop, who, AbortSignal.abort())).toEqual({ version: 1, error: 'ENGINE_INVALID_REQUEST' })
    for (let n = 0; n < NATIVE_STOP_IN_FLIGHT; n++) void t.requests[NATIVE_STOP](stop, who)
    expect(await t.requests[NATIVE_STOP](stop, who)).toEqual({ version: 1, error: 'ENGINE_BUSY' })
  })

  it('carries a refusal\'s message, and nothing that is not a line of text', async () => {
    const t = setup(async () => { throw new Error('Codex returned a different conversation') })
    expect(await t.requests[NATIVE_STOP](stop, who)).toEqual(refused('Codex returned a different conversation'))
    for (const thrown of [new Error('\x1b[2Jcleared'), new Error('x'.repeat(601)), 'not an error']) {
      const u = setup(async () => { throw thrown })
      expect(await u.requests[NATIVE_STOP](stop, who)).toEqual(refused(NATIVE_UNCONFIRMED))
    }
    // An answer core will not give ends the stop: the control is told it could not ask.
    const denied = setup(async host => { await host.current() })
    denied.query.mockResolvedValueOnce({ version: 1, error: 'ANSWER_FAILED' })
    expect(await denied.requests[NATIVE_STOP](stop, who)).toEqual(refused(NATIVE_UNCONFIRMED))
  })

  it('ends a stop when its connection closes, its deadline passes (recycling this worker) or core does not answer', async () => {
    vi.useFakeTimers()
    const closed = new AbortController()
    const asked: unknown[] = []
    const t = setup(async host => {
      closed.abort()
      asked.push(await host.current().catch(error => error.message))
    })
    expect(await t.requests[NATIVE_STOP](stop, who, closed.signal)).toEqual(refused(NATIVE_UNCONFIRMED))
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual([NATIVE_UNCONFIRMED])
    expect(t.query).not.toHaveBeenCalled()

    const stuck = setup(() => new Promise(() => {}))
    const pending = stuck.requests[NATIVE_STOP](stop, who)
    await vi.advanceTimersByTimeAsync(NATIVE_STOP_WAIT_MS)
    expect(await pending).toEqual(refused(NATIVE_UNCONFIRMED))
    expect(stuck.recycle).toHaveBeenCalledOnce()

    const silent = setup(async host => { await host.current() })
    silent.query.mockImplementation(() => new Promise(() => {}))
    const waiting = silent.requests[NATIVE_STOP](stop, who)
    await vi.advanceTimersByTimeAsync(NATIVE_QUERY_MS)
    expect(await waiting).toEqual(refused(NATIVE_UNCONFIRMED))
    expect(silent.recycle).not.toHaveBeenCalled()
  })

  it('takes an answer that arrives after the stop was ended as authorizing nothing', async () => {
    let release!: (value: Record<string, unknown>) => void
    const closed = new AbortController()
    const after = vi.fn()
    const t = setup(async host => { if (await host.current()) after() })
    t.query.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = t.requests[NATIVE_STOP](stop, who, closed.signal)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    closed.abort()
    expect(await pending).toEqual(refused(NATIVE_UNCONFIRMED))
    release({ version: 1, value: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(after).not.toHaveBeenCalled()
  })

  it('retries a control that failed to load, and refuses a stop the connection ended while it loaded', async () => {
    const control: EngineNativeControl = { activity: vi.fn(), stop: vi.fn(async () => {}), recover: vi.fn(), close: vi.fn() }
    const load = vi.fn().mockRejectedValueOnce(new Error('import failed')).mockResolvedValue(control)
    const requests = engineNativeControlRequests('codex', { query: vi.fn(), load })
    expect(await requests[NATIVE_STOP](stop, who)).toEqual(refused(NATIVE_UNCONFIRMED))
    expect(await requests[NATIVE_STOP](stop, who)).toEqual({ version: 1, answer: { stopped: true } })
    const closed = new AbortController()
    const slow = engineNativeControlRequests('codex', { query: vi.fn(), load: async () => { closed.abort(); return control } })
    expect(await slow[NATIVE_STOP](stop, who, closed.signal)).toEqual(refused(NATIVE_UNCONFIRMED))
  })

  it('validates every message shape it shares with core', () => {
    expect(nativeConversation({ ...conversation, sessionId: '' })).toBe(true)
    expect(boundConversation({ ...conversation, sessionId: '' })).toBe(false)
    for (const value of [null, { ...conversation, extra: 1 }, { ...conversation, home: '/a\0b' }, { ...conversation, sessionId: 'x'.repeat(201) }])
      expect(nativeConversation(value)).toBe(false)
    expect(nativeStopAnswer({ stopped: true })).toBe(true)
    for (const value of [{ stopped: false }, { refused: '' }, { stopped: true, refused: 'x' }, []]) expect(nativeStopAnswer(value)).toBe(false)
    for (const kind of ['current', 'pending', 'settled']) expect(nativeStopAction({ kind })).toBe(true)
    for (const value of [{ kind: 'current', extra: 1 }, { kind: 'running', pid: 90 }, { kind: 'kill' }, 'current']) expect(nativeStopAction(value)).toBe(false)
  })
})
