import { afterEach, describe, expect, it, vi } from 'vitest'
import { launch as codexLaunch } from '../../engines/codex/launch.js'
import type { EngineNativeControl, NativeConversation, NativeStopHost } from '../../engines/facets/nativeControl.js'
import { NATIVE_UNCONFIRMED } from '../../engines/worker/nativeControlHost.js'
import { NATIVE_ACTIVITY, NATIVE_CONTROL_CAPABILITIES, NATIVE_CONTROL_HOST, NATIVE_RECOVER, NATIVE_STOP,
  NATIVE_STOP_QUERIES } from '../../engines/worker/nativeControlProtocol.js'
import { engineNativeControlRequests } from '../../engines/worker/nativeControlRequests.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { argvTokens, type ProcessRow } from '../../lib/tmux.js'
import { createNativeControls, type NativeControlsDeps } from './nativeControls.js'

const server = codexLaunch.sharedServer!
const identity = { pid: 41, startMarker: 'born', executable: 'codex' }
const row = (over: Partial<RegisteredSession> = {}) => ({ agentId: 'agent', sessionId: 'thread', engine: 'codex', active: true,
  runtimes: [], processIdentity: identity, ...over }) as unknown as RegisteredSession
const daemon = { pid: 90, parentPid: 1, executable: 'codex', startMarker: 'Thu  Oct 1', args: 'codex app-server' }
const table = (args = 'codex resume thread'): ProcessRow[] => [{ ...identity, parentPid: 1, args }, daemon]
const conversation: NativeConversation = { home: '/fixture/codex', sessionId: 'thread' }
const pidFile = JSON.stringify({ pid: 90, processStartTime: 'Thu Oct 1 ' })
const who = { owner: true, local: true }

/** A control that records what it was asked, and runs a script against core's answers. */
function control(script: (host: NativeStopHost) => Promise<void> = async host => { await host.current() }) {
  const asked: NativeConversation[] = []
  const value: EngineNativeControl = {
    activity: vi.fn(async (c: NativeConversation) => { asked.push(c); return 'working' as const }),
    stop: vi.fn(async (c: NativeConversation, host: NativeStopHost) => { asked.push(c); await script(host) }),
    recover: vi.fn(async () => {}),
    close: vi.fn(),
  }
  return { value, asked }
}

/** The core's broker, with the real worker requests behind its links: the worker's questions come back to it. */
function isolated(engine: EngineNativeControl, over: Partial<NativeControlsDeps> = {}) {
  let core: ReturnType<typeof createNativeControls>
  const requests = engineNativeControlRequests('codex', { load: async () => engine, recycle: vi.fn(),
    query: async (query, payload) => core.answer('engine-codex', query, payload) ?? { error: 'DENIED' } })
  // Calls in flight, which a lost link fails at once, as the core's service links do.
  const inFlight = new Set<(error: Error) => void>()
  const call = vi.fn((_service: string, method: string, payload: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    inFlight.add(reject)
    Promise.resolve(requests[method]({ ...payload, requestId: 'core-route' }, who)).then(reply => resolve(reply as Record<string, unknown>), reject)
      .finally(() => inFlight.delete(reject))
  }))
  const log = vi.fn()
  core = createNativeControls({ call, servers: { codex: server }, handles: () => true, inline: () => undefined, rows: async () => table(),
    home: () => '/fixture/codex', argv: argvTokens, readFile: async () => pidFile, log, ...over })
  core.connected('engine-codex')
  const drop = () => { for (const reject of inFlight) reject(new Error('link lost')); inFlight.clear(); core.disconnected('engine-codex') }
  return { core, call, log, drop, methods: () => call.mock.calls.map(c => c[1]) }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Codex\'s shared server, from the core', () => {
  it('asks the worker about a shared conversation only, and nothing for a client that owns its own or works remotely', async () => {
    const engine = control()
    const t = isolated(engine.value)
    expect(await t.core.activity(row())).toBe('working')
    expect(engine.asked).toEqual([conversation])
    expect(t.methods()).toEqual([NATIVE_CONTROL_CAPABILITIES, NATIVE_ACTIVITY])
    // An argv too short to hold a script is read as the CLI's own: its first option still decides.
    expect(await isolated(engine.value, { rows: async () => table('') }).core.activity(row())).toBe('working')
    expect(await isolated(engine.value, { rows: async () => table('node') }).core.activity(row())).toBe('working')
    for (const args of ['codex --no-daemon resume thread', 'node /bin/codex.js --no-daemon resume thread', 'codex --remote=ws://x resume thread']) {
      const other = isolated(engine.value, { rows: async () => table(args) })
      expect(await other.core.activity(row())).toBe('unknown')
      expect(other.call).not.toHaveBeenCalled()
    }
    expect(await t.core.activity(row({ engine: 'claude' }))).toBe('unknown')
    expect(await t.core.activity(row({ processIdentity: undefined }))).toBe('unknown')
    expect(await t.core.activity(row({ processIdentity: { ...identity, executable: 'node' } }))).toBe('unknown')
    expect(t.call).toHaveBeenCalledTimes(2)
    expect(engine.asked).toHaveLength(3)
  })

  it('reads the process table once in two seconds, and takes a failed or malformed reading as unknown', async () => {
    let now = 0
    const read = vi.fn(async () => table())
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
    const relative = isolated(engine.value, { home: () => 'codex' })
    expect(await relative.core.activity(row())).toBe('unknown')
    expect(relative.call).not.toHaveBeenCalled()
  })

  it('stops a client that owns its conversation, or whose server is gone, with no worker at all', async () => {
    const engine = control()
    const down = { call: async () => ({ error: 'SERVICE_UNAVAILABLE' }) }
    // Launched by Harness with --no-daemon: nothing of it is on any server. A stop needs no worker for it.
    await isolated(engine.value, { ...down, rows: async () => table('node /bin/codex --no-daemon resume thread') }).core.stop(row(), () => true)
    // No record of a server in the store, or its recorded process no longer running.
    await isolated(engine.value, { ...down, readFile: async () => { throw Object.assign(new Error('none'), { code: 'ENOENT' }) } }).core.stop(row(), () => true)
    await isolated(engine.value, { ...down, rows: async () => [table()[0]] }).core.stop(row(), () => true)
    await isolated(engine.value, { ...down, readFile: async () => JSON.stringify({ pid: 90, processStartTime: 'later' }) }).core.stop(row(), () => true)
    await isolated(engine.value).core.stop(row({ engine: 'claude' }), () => true)
    expect(engine.value.stop).not.toHaveBeenCalled()
  })

  it('refuses in the engine\'s own words what core can tell alone', async () => {
    const engine = control()
    await expect(isolated(engine.value, { rows: async () => table('codex resume --remote ws://x thread') }).core.stop(row(), () => true)).rejects.toThrow(server.messages.remote)
    await expect(isolated(engine.value, { rows: async () => null }).core.stop(row(), () => true)).rejects.toThrow(server.messages.unverified)
    await expect(isolated(engine.value).core.stop(row({ sessionId: '' }), () => true)).rejects.toThrow(server.messages.unidentified)
    await expect(isolated(engine.value, { readFile: async () => '{"pid":0}' }).core.stop(row(), () => true)).rejects.toThrow('Invalid Codex server identity')
    await expect(isolated(engine.value, { readFile: async () => { throw new Error('EACCES') } }).core.stop(row(), () => true)).rejects.toThrow('EACCES')
    await expect(isolated(engine.value, { home: () => 'relative' }).core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    // An unbound chat proved unused needs no server; the proof is core's, and so is the last check.
    const unused = vi.fn(async () => true)
    await isolated(engine.value).core.stop(row({ sessionId: '' }), () => true, unused)
    expect(unused).toHaveBeenCalledWith(row({ sessionId: '' }))
    await expect(isolated(engine.value).core.stop(row({ sessionId: '' }), () => false, unused)).rejects.toThrow('cancelled')
    // An exited client that never bound a conversation: nothing on any server is its.
    const exited = row({ sessionId: '', processIdentity: { pid: 7, startMarker: 'gone', executable: 'codex' } })
    await isolated(engine.value).core.stop(exited, () => true)
    await expect(isolated(engine.value).core.stop(exited, () => false)).rejects.toThrow('cancelled')
    expect(engine.value.stop).not.toHaveBeenCalled()
  })

  it('unloads a shared conversation through the worker under a grant, gone after', async () => {
    const answers: unknown[] = []
    let t!: ReturnType<typeof isolated>
    const engine = control(async host => {
      // Another engine's worker coming and going leaves this grant alone.
      t.core.disconnected('engine-claude'); t.core.connected('engine-claude')
      answers.push(await host.current(), await host.pending(), await host.settled())
    })
    t = isolated(engine.value)
    await t.core.stop(row(), () => true)
    expect(answers).toEqual([true, true, true])
    expect(engine.asked).toEqual([conversation])
    expect(t.methods()).toEqual([NATIVE_CONTROL_CAPABILITIES, NATIVE_STOP])
    const token = t.call.mock.calls[1][2].token as string
    expect(t.core.answer('engine-codex', NATIVE_CONTROL_HOST, { version: 1, token, action: { kind: 'current' } })).toEqual({ version: 1, error: 'ANSWER_FAILED' })
  })

  it('carries the engine\'s refusal to the person; a worker that does not answer is logged and never confirms', async () => {
    const refused = control(async () => { throw new Error('Codex returned a different conversation') })
    await expect(isolated(refused.value).core.stop(row(), () => true)).rejects.toThrow('different conversation')
    const hostile = control(async () => { throw new Error('\x1b]0;owned\x07') })
    await expect(isolated(hostile.value).core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    const down = isolated(control().value, { call: async () => ({ error: 'SERVICE_UNAVAILABLE' }) })
    await expect(down.core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    expect(down.log).toHaveBeenCalledWith(expect.stringContaining('the codex worker did not answer the stop'))
  })

  it('revokes the stop when it is no longer wanted, and refuses every question after, a check that throws included', async () => {
    let current = true
    const after: unknown[] = []
    const engine = control(async host => {
      current = false
      if (!await host.pending()) {
        after.push(await host.current().catch(error => error.message))
        throw new Error('The close request was cancelled or the session changed')
      }
    })
    const t = isolated(engine.value)
    await expect(t.core.stop(row(), () => current)).rejects.toThrow('cancelled')
    expect(after).toEqual([NATIVE_UNCONFIRMED])
    // Refused before its step, the stop leaves nothing to repair.
    t.core.disconnected('engine-codex'); t.core.connected('engine-codex')
    expect(t.methods()).not.toContain(NATIVE_RECOVER)
    const throwing = control(async host => { await host.current() })
    await expect(isolated(throwing.value).core.stop(row(), () => { throw new Error('registry gone') })).rejects.toThrow(NATIVE_UNCONFIRMED)
  })

  it('answers only its own grant, for the service it was given to, within its count', async () => {
    let t!: ReturnType<typeof isolated>
    const results: unknown[] = []
    const engine = control(async () => {
      const token = t.call.mock.calls.find(call => call[1] === NATIVE_STOP)![2].token as string
      const ask = (action: unknown, service = 'engine-codex', value = token) =>
        t.core.answer(service, NATIVE_CONTROL_HOST, { version: 1, token: value, action, query: NATIVE_CONTROL_HOST })
      results.push(ask({ kind: 'current' }, 'engine-claude'), ask({ kind: 'current' }, 'engine-codex', 'f'.repeat(64)),
        ask({ kind: 'delete' }), ask({ kind: 'current' }))
    })
    t = isolated(engine.value)
    await t.core.stop(row(), () => true)
    expect(results.map(result => (result as Record<string, unknown>).error ?? (result as Record<string, unknown>).value))
      .toEqual(['ANSWER_FAILED', 'ANSWER_FAILED', 'ANSWER_FAILED', true])
    expect(t.core.answer('engine-codex', 'engine.questionControl', {})).toBeNull()
    const chatty = control(async host => { for (let n = 0; n <= NATIVE_STOP_QUERIES; n++) await host.current() })
    await expect(isolated(chatty.value).core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
  })

  it('undoes, once, through the next worker, a step a lost worker took and never undid', async () => {
    let t!: ReturnType<typeof isolated>
    // The worker notes its archive, then is lost before the unarchive: its link replaced under the stop.
    const engine = control(async host => {
      await host.pending()
      t.drop(); t.core.connected('engine-claude')
      await new Promise(() => {})
    })
    t = isolated(engine.value)
    await expect(t.core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    t.core.connected('engine-codex')
    await vi.waitFor(() => expect(engine.value.recover).toHaveBeenCalledWith(conversation))
    await vi.waitFor(() => expect(t.log).toHaveBeenCalledWith(expect.stringContaining('restored the history of codex conversation')))
    // Once: a later link asks nothing more.
    t.core.disconnected('engine-codex'); t.core.connected('engine-codex')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(engine.value.recover).toHaveBeenCalledOnce()
  })

  it('logs a repair that failed, or that no worker could be asked for, and forgets it either way', async () => {
    for (const [failure, words] of [['refused', 'could not restore'], ['unreachable', 'could not ask']] as const) {
      let t!: ReturnType<typeof isolated>
      const engine = control(async host => {
        await host.pending()
        t.drop()
        await new Promise(() => {})
      })
      if (failure === 'refused') vi.mocked(engine.value.recover).mockRejectedValue(new Error('not archived'))
      t = isolated(engine.value)
      await expect(t.core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
      if (failure === 'unreachable') t.call.mockImplementation(async () => ({ error: 'SERVICE_UNAVAILABLE' }))
      t.core.connected('engine-codex')
      await vi.waitFor(() => expect(t.log).toHaveBeenCalledWith(expect.stringContaining(words)))
    }
  })

  it('leaves nothing to repair once the worker undid its step, or answered at all', async () => {
    const settled = control(async host => { await host.pending(); await host.settled() })
    const t = isolated(settled.value)
    await t.core.stop(row(), () => true)
    const refused = control(async host => { await host.pending(); throw new Error('Codex could not archive') })
    const u = isolated(refused.value)
    await expect(u.core.stop(row(), () => true)).rejects.toThrow('could not archive')
    for (const each of [t, u]) { each.core.disconnected('engine-codex'); each.core.connected('engine-codex') }
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled.value.recover).not.toHaveBeenCalled()
    expect(refused.value.recover).not.toHaveBeenCalled()
  })

  it('runs the control in process only when composed so, bounded the same way, and closes it at shutdown', async () => {
    vi.useFakeTimers()
    const engine = control(() => new Promise(() => {}))
    const deps = { servers: { codex: server }, handles: () => false, inline: () => engine.value, rows: async () => table(), home: () => '/fixture/codex',
      argv: argvTokens, readFile: async () => pidFile, call: vi.fn(), log: vi.fn() }
    const core = createNativeControls(deps)
    expect(await core.activity(row())).toBe('working')
    const stuck = expect(core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    await vi.advanceTimersByTimeAsync(60_001)
    await stuck
    vi.useRealTimers()
    vi.mocked(engine.value.stop).mockImplementationOnce(async (_c, host) => { await host.pending(); throw 'not an error' })
    await expect(core.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    // In process there is no worker to lose: nothing is kept to repair.
    core.connected('engine-codex')
    expect(engine.value.recover).not.toHaveBeenCalled()
    core.close()
    expect(engine.value.close).toHaveBeenCalledOnce()
    const none = createNativeControls({ ...deps, inline: () => undefined })
    expect(await none.activity(row())).toBe('unknown')
    await expect(none.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    none.close()
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    const quiet = createNativeControls({ ...deps, handles: () => true, inline: () => undefined, log: undefined, call: async () => ({ error: 'SERVICE_UNAVAILABLE' }) })
    await expect(quiet.stop(row(), () => true)).rejects.toThrow(NATIVE_UNCONFIRMED)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('did not answer the stop'))
  })
})
