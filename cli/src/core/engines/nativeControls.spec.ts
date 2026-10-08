import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineNativeControl, NativeConversation, NativeStopHost } from '../../engines/facets/nativeControl.js'
import { NATIVE_UNCONFIRMED } from '../../engines/worker/nativeControlHost.js'
import { NATIVE_ACTIVITY, NATIVE_CONTROL_CAPABILITIES, NATIVE_CONTROL_HOST, NATIVE_STOP, NATIVE_STOP_QUERIES } from '../../engines/worker/nativeControlProtocol.js'
import { engineNativeControlRequests } from '../../engines/worker/nativeControlRequests.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { argvTokens, type ProcessRow } from '../../lib/tmux.js'
import { createNativeControls, type NativeControlsDeps } from './nativeControls.js'

const identity = { pid: 41, startMarker: 'born', executable: 'codex' }
const row = (over: Partial<RegisteredSession> = {}) => ({ agentId: 'agent', sessionId: 'thread', engine: 'codex', active: true,
  runtimes: [], processIdentity: identity, ...over }) as unknown as RegisteredSession
const rows: ProcessRow[] = [{ ...identity, parentPid: 1, args: 'codex resume thread' }, { pid: 90, parentPid: 1, executable: 'codex', startMarker: 'Thu  Oct 1', args: 'codex app-server' }]
const conversation: NativeConversation = { home: '/fixture/codex', sessionId: 'thread', owner: ['codex', 'resume', 'thread'] }
const who = { owner: true, local: true }

/** A control that records what it was asked, and asks core what a stop is told to ask. */
function control(script: (host: NativeStopHost) => Promise<void> = async host => { await host.current() }) {
  const asked: NativeConversation[] = []
  const value: EngineNativeControl = {
    activity: vi.fn(async (c: NativeConversation) => { asked.push(c); return 'working' as const }),
    stop: vi.fn(async (c: NativeConversation, host: NativeStopHost) => { asked.push(c); await script(host) }),
    close: vi.fn(),
  }
  return { value, asked }
}

/** The core's broker, with the real worker requests behind its links: the worker's questions come back to it. */
function isolated(engine: EngineNativeControl, over: Partial<NativeControlsDeps> = {}) {
  let core: ReturnType<typeof createNativeControls>
  const requests = engineNativeControlRequests('codex', { load: async () => engine, recycle: vi.fn(),
    query: async (query, payload) => await core.answer('engine-codex', query, payload) ?? { error: 'DENIED' } })
  const call = vi.fn(async (_service: string, method: string, payload: Record<string, unknown>) =>
    await requests[method]({ ...payload, requestId: 'core-route' }, who) as Record<string, unknown>)
  core = createNativeControls({ call, handles: () => true, inline: () => undefined, rows: async () => rows, home: () => '/fixture/codex', argv: argvTokens, ...over })
  core.connected('engine-codex')
  return { core, call }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Codex\'s control connection, from the core', () => {
  it('reads activity in the worker for the conversation core identified, and nothing for an engine without one', async () => {
    const engine = control()
    const t = isolated(engine.value)
    expect(await t.core.activity(row())).toBe('working')
    expect(engine.asked).toEqual([conversation])
    expect(t.call.mock.calls.map(call => call[1])).toEqual([NATIVE_CONTROL_CAPABILITIES, NATIVE_ACTIVITY])
    expect(await t.core.activity(row({ engine: 'claude' }))).toBe('unknown')
    expect(await t.core.activity(row({ processIdentity: undefined }))).toBe('unknown')
    // Not the process core holds for the session: another executable, or a pid reused since.
    expect(await t.core.activity(row({ processIdentity: { ...identity, executable: 'node' } }))).toBe('unknown')
    expect(t.call).toHaveBeenCalledTimes(2)
  })

  it('reads the process table once in two seconds, and takes a failed or malformed read as unknown', async () => {
    let now = 0
    const read = vi.fn(async () => rows)
    const engine = control()
    const t = isolated(engine.value, { rows: read, now: () => now })
    await Promise.all([t.core.activity(row()), t.core.activity(row())])
    expect(read).toHaveBeenCalledOnce()
    now = 2_001
    await t.core.activity(row())
    expect(read).toHaveBeenCalledTimes(2)
    vi.mocked(engine.value.activity).mockResolvedValueOnce('sleeping' as never)
    expect(await t.core.activity(row())).toBe('unknown')
    vi.mocked(engine.value.activity).mockRejectedValueOnce(new Error('server gone'))
    expect(await t.core.activity(row())).toBe('unknown')
    // A store core cannot name is no conversation to ask about.
    const relative = isolated(engine.value, { home: () => 'codex' })
    expect(await relative.core.activity(row())).toBe('unknown')
    expect(relative.call).not.toHaveBeenCalled()
  })

  it('stops through the worker under a grant: each question answered by core, the grant gone after', async () => {
    const answers: unknown[] = []
    const engine = control(async host => {
      answers.push(await host.current(), await host.running(90, 'Thu Oct 1 '), await host.running(90, 'Fri'), await host.unused())
    })
    const t = isolated(engine.value)
    const unused = vi.fn(async () => true)
    await t.core.stop(row(), () => true, unused)
    expect(answers).toEqual([true, true, false, true])
    expect(unused).toHaveBeenCalledWith(row())
    expect(engine.asked).toEqual([conversation])
    expect(t.call.mock.calls.map(call => call[1])).toEqual([NATIVE_CONTROL_CAPABILITIES, NATIVE_STOP])
    const token = t.call.mock.calls[1][2].token as string
    expect(await t.core.answer('engine-codex', NATIVE_CONTROL_HOST, { version: 1, token, action: { kind: 'current' } })).toEqual({ version: 1, error: 'ANSWER_FAILED' })
    // A close's proof absent, the chat is not shown unused.
    const none = control(async host => { if (await host.unused()) throw new Error('took a missing proof') })
    await isolated(none.value).core.stop(row(), () => true)
  })

  it('carries the engine\'s refusal to the person, and never signals on a stop that could not be confirmed', async () => {
    const refused = control(async () => { throw new Error('Stop this conversation on its remote Codex server before closing its terminal') })
    await expect(isolated(refused.value).core.stop(row(), () => true)).rejects.toThrow('remote Codex server')
    // Terminal control in a message is not a person's message.
    const hostile = control(async () => { throw new Error('\x1b]0;owned\x07') })
    await expect(isolated(hostile.value).core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    const down = isolated(control().value, { call: async () => ({ error: 'SERVICE_UNAVAILABLE' }) })
    await expect(down.core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
  })

  it('revokes the stop when it is no longer wanted, and refuses every question after', async () => {
    let current = true
    const after: unknown[] = []
    const engine = control(async host => {
      current = false
      if (!await host.current()) {
        after.push(await host.running(90, 'Thu Oct 1').catch(error => error.message))
        throw new Error('The close request was cancelled or the session changed')
      }
    })
    await expect(isolated(engine.value).core.stop(row(), () => current)).rejects.toThrow('cancelled')
    expect(after).toEqual([NATIVE_UNCONFIRMED])
    // A check that cannot be made is not a yes.
    const throwing = control(async host => { await host.current() })
    await expect(isolated(throwing.value).core.stop(row(), () => { throw new Error('registry gone') })).rejects.toThrow(NATIVE_UNCONFIRMED)
  })

  it('answers only its own grant, for the service it was given to, and only the questions it may ask', async () => {
    let t!: ReturnType<typeof isolated>
    const results: unknown[] = []
    const engine = control(async () => {
      const token = t.call.mock.calls.find(call => call[1] === NATIVE_STOP)![2].token as string
      const ask = (action: unknown, service = 'engine-codex', value = token) =>
        t.core.answer(service, NATIVE_CONTROL_HOST, { version: 1, token: value, action, query: NATIVE_CONTROL_HOST })
      results.push(await ask({ kind: 'current' }, 'engine-claude'))
      results.push(await ask({ kind: 'current' }, 'engine-codex', 'f'.repeat(64)))
      results.push(await ask({ kind: 'delete' }))
      results.push(await ask({ kind: 'running', pid: -1, startedAt: 'x' }))
      results.push(await ask({ kind: 'current' }))
    })
    t = isolated(engine.value)
    await t.core.stop(row(), () => true)
    expect(results.map(result => (result as Record<string, unknown>).error ?? (result as Record<string, unknown>).value))
      .toEqual(['ANSWER_FAILED', 'ANSWER_FAILED', 'ANSWER_FAILED', 'ANSWER_FAILED', true])
    expect(t.core.answer('engine-codex', 'engine.questionControl', {})).toBeNull()
  })

  it('takes two questions at once, or more than the grant allows, as the end of the stop', async () => {
    let pending: Promise<boolean> | undefined
    const overlapping = control(async host => {
      pending = host.unused()
      await host.current()
    })
    let release!: (value: boolean) => void
    const unused = () => new Promise<boolean>(resolve => { release = resolve })
    const stop = expect(isolated(overlapping.value).core.stop(row(), () => true, unused)).rejects.toThrow(NATIVE_UNCONFIRMED)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await stop
    release(true)
    await pending!.catch(() => {})
    const chatty = control(async host => { for (let n = 0; n <= NATIVE_STOP_QUERIES; n++) await host.current() })
    await expect(isolated(chatty.value).core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
  })

  it('bounds core\'s own proof of an unused chat, and a proof that fails is no proof', async () => {
    vi.useFakeTimers()
    const engine = control(async host => { await host.unused() })
    const slow = isolated(engine.value).core.stop(row(), () => true, () => new Promise(() => {}))
    const settled = expect(slow).rejects.toThrow(NATIVE_UNCONFIRMED)
    await vi.advanceTimersByTimeAsync(10_001)
    await settled
    vi.useRealTimers()
    await expect(isolated(engine.value).core.stop(row(), () => true, async () => { throw new Error('screen gone') })).rejects.toThrow(NATIVE_UNCONFIRMED)
  })

  it('ends a stop whose worker connection was replaced: its grant goes with the connection', async () => {
    let t!: ReturnType<typeof isolated>
    const engine = control(async host => {
      // Another engine's worker coming and going leaves this grant alone.
      t.core.disconnected('engine-claude'); t.core.connected('engine-claude')
      expect(await host.current()).toBe(true)
      t.core.disconnected('engine-codex'); t.core.connected('engine-codex')
      await host.current()
    })
    t = isolated(engine.value)
    await expect(t.core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    t.core.connected('engine-other'); t.core.disconnected('engine-other')
  })

  it('keeps the early answers core can give alone, and asks nothing for another engine', async () => {
    const engine = control()
    const t = isolated(engine.value, { rows: async () => null })
    await expect(t.core.stop(row(), () => true)).rejects.toThrow('verify the Codex server')
    await isolated(engine.value).core.stop(row({ engine: 'claude' }), () => true)
    // An exited client that never bound a conversation: nothing on any server is its.
    const exited = row({ sessionId: '', processIdentity: { pid: 7, startMarker: 'gone', executable: 'codex' } })
    await isolated(engine.value).core.stop(exited, () => true)
    await expect(isolated(engine.value).core.stop(exited, () => false)).rejects.toThrow('cancelled')
    await expect(isolated(engine.value, { home: () => 'relative' }).core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    expect(engine.value.stop).not.toHaveBeenCalled()
  })

  it('runs the control in process only when composed so, bounded the same way, and closes it at shutdown', async () => {
    vi.useFakeTimers()
    const engine = control(() => new Promise(() => {}))
    const core = createNativeControls({ handles: () => false, inline: () => engine.value, rows: async () => rows, home: () => '/fixture/codex', argv: argvTokens, call: vi.fn() })
    expect(await core.activity(row())).toBe('working')
    const stuck = expect(core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    await vi.advanceTimersByTimeAsync(60_001)
    await stuck
    vi.useRealTimers()
    vi.mocked(engine.value.stop).mockRejectedValueOnce('not an error')
    await expect(core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    core.close()
    expect(engine.value.close).toHaveBeenCalledOnce()
    const none = createNativeControls({ handles: () => false, inline: () => undefined, rows: async () => rows, home: () => '/fixture/codex', argv: argvTokens, call: vi.fn() })
    expect(await none.activity(row())).toBe('unknown')
    await expect(none.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    none.close()
  })
})
