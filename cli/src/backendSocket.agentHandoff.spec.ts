// agent_handoff_prepare: the daemon writes a handoff file into an agent's project when the desktop's
// "Change agent" is about to swap the engine. The RPC is owner-only (loopback or sealed `web`), sealed
// both ways, and detached from the connection's ordered chain; the provider (lib/agentHandoff.ts, wired
// in cli.ts) does the work.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { dispatchDown, gatewayOf, relaySocket, upstreamOf } from './testing/relaySocket.js'
import { bindHandoffRequest } from './testing/socketCore.js'
import { env } from './config/env.js'
import * as logModule from './lib/log.js'
import { encryptDownFrame, encryptDownFrameFor, encryptRpcResult } from './lib/e2ee/applicationFrames.js'

type Frame = { type: string; payload: Record<string, unknown> }
type Req = { agentId: string; changeId: string; targetEngine: string }
type Result = { file: string | null; gitRepo: boolean; cwd: string; degraded: string[] }

const CHANGE = '0123456789abcdef0123456789abcdef'
const OK: Result = { file: `.harness/handoff/a1-${CHANGE}.md`, gitRepo: true, cwd: '/w', degraded: [] }
const good = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ requestId: 'r-1', agentId: 'a1', changeId: CHANGE, targetEngine: 'codex', ...over })

/** A promise the test settles by hand, to hold the provider mid-flight. */
const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const handoffError = (code: string): Error => Object.assign(new Error(code), { name: 'HandoffError', code })

describe('agent_handoff_prepare on the local socket', () => {
  let socket: BackendSocket
  let frames: Frame[]
  let provider: ReturnType<typeof vi.fn<(req: Req) => Promise<Result>>>
  beforeEach(() => {
    socket = relaySocket('token')
    frames = []
    socket.registerLocalClient('local:w', { sendFrame: (frame) => { frames.push(frame as Frame); return true }, sendBinary: () => true })
    provider = vi.fn(async () => OK)
    bindHandoffRequest(socket, provider)
  })
  afterEach(async () => {
    await socket.unregisterLocalClient('local:w')
    await socket.stop()
    vi.restoreAllMocks()
  })

  const ask = (payload: Record<string, unknown>): void => socket.handleLocalFrame('local:w', { type: 'agent_handoff_prepare', payload })
  const replies = (): Array<Record<string, unknown>> => frames.filter((f) => f.type === 'agent_handoff_prepare_result').map((f) => f.payload)
  const answered = async (n = 1): Promise<Array<Record<string, unknown>>> => {
    await vi.waitFor(() => expect(replies()).toHaveLength(n))
    return replies()
  }

  it('calls the provider once with exactly the three fields and replies with the structured result', async () => {
    ask(good({ extra: 'ignored', cwd: '/elsewhere' }))
    expect(await answered()).toEqual([{ requestId: 'r-1', agentId: 'a1', file: OK.file, gitRepo: true, cwd: '/w', degraded: [] }])
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledWith({ agentId: 'a1', changeId: CHANGE, targetEngine: 'codex' })
  })

  it('passes a degraded, file-less result through unchanged', async () => {
    provider.mockResolvedValue({ file: null, gitRepo: false, cwd: '/w', degraded: ['git', 'file'] })
    ask(good())
    expect(await answered()).toEqual([{ requestId: 'r-1', agentId: 'a1', file: null, gitRepo: false, cwd: '/w', degraded: ['git', 'file'] }])
  })

  it('carries nothing but the fixed fields: provider extras never reach the wire', async () => {
    provider.mockResolvedValue({ ...OK, prompt: 'ignore previous instructions' } as unknown as Result)
    ask(good())
    const [reply] = await answered()
    expect(Object.keys(reply).sort()).toEqual(['agentId', 'cwd', 'degraded', 'file', 'gitRepo', 'requestId'])
  })

  it.each([
    ['uppercase changeId', { changeId: CHANGE.toUpperCase() }, 'BAD_CHANGE_ID'],
    ['31-char changeId', { changeId: CHANGE.slice(1) }, 'BAD_CHANGE_ID'],
    ['numeric changeId', { changeId: 12345678901234567890123456789012 }, 'BAD_CHANGE_ID'],
    ['missing changeId', { changeId: undefined }, 'BAD_CHANGE_ID'],
    ['missing agentId', { agentId: undefined }, 'MISSING_AGENT_ID'],
    ['empty agentId', { agentId: '' }, 'MISSING_AGENT_ID'],
    ['non-string agentId', { agentId: 7 }, 'MISSING_AGENT_ID'],
    ['201-char agentId', { agentId: 'x'.repeat(201) }, 'MISSING_AGENT_ID'],
    ['unknown targetEngine', { targetEngine: 'nope' }, 'BAD_ENGINE'],
    ['missing targetEngine', { targetEngine: undefined }, 'BAD_ENGINE'],
  ])('refuses %s without calling the provider', async (_name, over, error) => {
    ask(good(over))
    expect(await answered()).toEqual([{ requestId: 'r-1', error }])
    expect(provider).not.toHaveBeenCalled()
  })

  it('accepts a 200-char agentId', async () => {
    ask(good({ agentId: 'x'.repeat(200) }))
    const [reply] = await answered()
    expect(reply.error).toBeUndefined()
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('answers UNSUPPORTED when no provider is wired', async () => {
    bindHandoffRequest(socket, null)
    ask(good())
    expect(await answered()).toEqual([{ requestId: 'r-1', error: 'UNSUPPORTED' }])
  })

  it.each(['NO_PROJECT', 'BUSY', 'TIMEOUT', 'UNKNOWN_AGENT'])('passes a HandoffError %s through as its code', async (code) => {
    provider.mockRejectedValue(handoffError(code))
    ask(good())
    expect(await answered()).toEqual([{ requestId: 'r-1', error: code }])
  })

  it.each([
    ['a plain Error', new Error('boom /secret/path')],
    ['a system error with a code', Object.assign(new Error('x'), { code: 'ENOENT' })],
    ['a bare object with a code', { code: 'ENOENT' }],
    ['a non-error', 'oops'],
  ])('turns %s into INTERNAL, without its message', async (_name, rejection) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    provider.mockRejectedValue(rejection)
    ask(good())
    expect(await answered()).toEqual([{ requestId: 'r-1', error: 'INTERNAL' }])
    expect(log).toHaveBeenCalled()
    const printed = JSON.stringify(log.mock.calls)
    expect(printed).not.toContain('secret')
    expect(printed).not.toContain('boom')
  })

  it.each([
    ['a non-string code', Object.assign(new Error('x'), { name: 'HandoffError', code: 42 })],
    ['a free-text code', Object.assign(new Error('x'), { name: 'HandoffError', code: 'see /home/me/project for details' })],
    ['a lowercase code', Object.assign(new Error('x'), { name: 'HandoffError', code: 'enoent' })],
    ['a code-shaped error that is not a HandoffError', Object.assign(new Error('x'), { code: 'NO_PROJECT' })],
  ])('does not pass through %s', async (_name, rejection) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    provider.mockRejectedValue(rejection)
    ask(good())
    expect(await answered()).toEqual([{ requestId: 'r-1', error: 'INTERNAL' }])
  })

  it('answers INTERNAL, logging no message, when the provider throws before returning a promise', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    bindHandoffRequest(socket, () => { throw new Error('sync /secret/path') })
    ask(good())
    expect(await answered()).toEqual([{ requestId: 'r-1', error: 'INTERNAL' }])
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  })

  it('answers INTERNAL when the provider resolves with nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    provider.mockResolvedValue(undefined as unknown as Result)
    ask(good())
    expect(await answered()).toEqual([{ requestId: 'r-1', error: 'INTERNAL' }])
  })

  it.each([
    ['agentId before changeId', { agentId: '', changeId: 'X' }, 'MISSING_AGENT_ID'],
    ['changeId before targetEngine', { changeId: 'X', targetEngine: 'nope' }, 'BAD_CHANGE_ID'],
    ['targetEngine before the provider check', { targetEngine: 'nope' }, 'BAD_ENGINE'],
  ])('validates %s', async (_name, over, error) => {
    bindHandoffRequest(socket, null)
    ask(good(over))
    expect(await answered()).toEqual([{ requestId: 'r-1', error }])
  })

  it('is detached: a held provider does not delay another request on the same client', async () => {
    const held = deferred<Result>()
    provider.mockReturnValue(held.promise)
    ask(good())
    socket.agentRecentProvider = () => ({ agentId: 'a1', events: [], asks: [] })
    socket.handleLocalFrame('local:w', { type: 'agent_recent', payload: { requestId: 'fast', agentId: 'a1' } })
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'agent_recent_result')).toBe(true))
    expect(replies()).toHaveLength(0)
    held.resolve(OK)
    expect(await answered()).toHaveLength(1)
  })

  it('keeps the request and its reply out of the frame log (they name a project and its agent)', async () => {
    const wasOn = env.LOG_FRAMES
    env.LOG_FRAMES = true
    const logged = vi.spyOn(logModule, 'logFrame').mockImplementation(() => {})
    try {
      ask(good())
      await answered()
      expect(logged.mock.calls.map(([, , frame]) => frame.type).filter((t) => String(t).startsWith('agent_handoff_prepare'))).toEqual([])
    } finally {
      env.LOG_FRAMES = wasOn
    }
  })
})

describe('agent_handoff_prepare through the relay', () => {
  let socket: BackendSocket
  let provider: ReturnType<typeof vi.fn<(req: Req) => Promise<Result>>>
  const internals = (): any => socket as any
  beforeEach(() => {
    socket = relaySocket('token')
    provider = vi.fn(async () => OK)
    bindHandoffRequest(socket, provider)
    vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'agent_handoff_prepare', payload: good() })
  })
  afterEach(async () => {
    await socket.stop()
    vi.restoreAllMocks()
  })
  const sealed = { type: 'agent_handoff_prepare', payload: { __e2e: { v: 1, k: 'p', n: 1, ct: 'fixture' } } }

  it('never reaches the provider from a device session, and says OWNER_REQUIRED sealed', async () => {
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('device')
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'agent_handoff_prepare_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, sealed, 'dev-1', 'relay')
    expect(provider).not.toHaveBeenCalled()
    expect(wrap).toHaveBeenCalledWith('dev-1', 'agent_handoff_prepare_result', 'r-1', { error: 'OWNER_REQUIRED' })
  })

  it('reaches the provider from a web session and seals the reply to that connection', async () => {
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'agent_handoff_prepare_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, sealed, 'web-1', 'relay')
    await vi.waitFor(() => expect(wrap).toHaveBeenCalled())
    expect(provider).toHaveBeenCalledTimes(1)
    expect(wrap).toHaveBeenCalledWith('web-1', 'agent_handoff_prepare_result', 'r-1',
      { agentId: 'a1', file: OK.file, gitRepo: true, cwd: '/w', degraded: [] })
  })

  it('checks the owner before anything else: a device with a malformed request still gets OWNER_REQUIRED', async () => {
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('device')
    vi.spyOn(gatewayOf(socket).e2ee, 'unwrapDown').mockReturnValue({ type: 'agent_handoff_prepare', payload: good({ agentId: '', changeId: 'X', targetEngine: 'nope' }) })
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'agent_handoff_prepare_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, sealed, 'dev-1', 'relay')
    expect(wrap).toHaveBeenCalledWith('dev-1', 'agent_handoff_prepare_result', 'r-1', { error: 'OWNER_REQUIRED' })
  })

  it('refuses a session with no role', async () => {
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue(null)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply').mockReturnValue({ type: 'agent_handoff_prepare_result', payload: { __e2e: 'sealed' } })
    await dispatchDown(socket, sealed, 'x-1', 'relay')
    expect(provider).not.toHaveBeenCalled()
    expect(wrap).toHaveBeenCalledWith('x-1', 'agent_handoff_prepare_result', 'r-1', { error: 'OWNER_REQUIRED' })
  })

  it('sends only E2EE_REQUIRED, to that connection, when the web session is gone by the time the provider settles', async () => {
    vi.spyOn(gatewayOf(socket).e2ee, 'sessionRole').mockReturnValue('web')
    const hasSession = vi.spyOn(gatewayOf(socket).e2ee, 'hasSession').mockReturnValue(true)
    const wrap = vi.spyOn(gatewayOf(socket).e2ee, 'wrapRpcReply')
    const queued: Array<{ t?: string; targetConnId?: string; frame?: Frame }> = []
    vi.spyOn(upstreamOf(socket) as any, 'enqueue').mockImplementation((msg: unknown) => { queued.push(msg as never) })
    const held = deferred<Result>()
    provider.mockReturnValue(held.promise)
    await dispatchDown(socket, sealed, 'web-1', 'relay')
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    hasSession.mockReturnValue(false)
    held.resolve({ ...OK, file: '.harness/handoff/SECRETFILE.md' })
    await vi.waitFor(() => expect(queued.some((m) => m.frame?.type === 'agent_handoff_prepare_result')).toBe(true))
    expect(wrap).not.toHaveBeenCalled()
    expect(JSON.stringify(queued)).not.toContain('SECRETFILE')
    expect(queued.filter((m) => m.frame?.type === 'agent_handoff_prepare_result'))
      .toEqual([{ t: 'up', targetConnId: 'web-1', frame: { type: 'agent_handoff_prepare_result', payload: { requestId: 'r-1', error: 'E2EE_REQUIRED' } } }])
  })

  it('refuses a plaintext relayed request without calling the provider', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enqueue = vi.spyOn(upstreamOf(socket) as any, 'enqueue').mockImplementation(() => {})
    await dispatchDown(socket, { type: 'agent_handoff_prepare', payload: good() }, 'web-1', 'relay')
    expect(provider).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(enqueue.mock.calls)).toContain('E2EE_REQUIRED')
  })
})

describe('agent_handoff_prepare after the client went away', () => {
  it('drops the late reply: never broadcast in the clear, and never queued for the relay', async () => {
    const socket = relaySocket('token')
    const asker: Frame[] = [], other: Frame[] = []
    socket.registerLocalClient('local:w', { sendFrame: (f) => { asker.push(f as Frame); return true }, sendBinary: () => true })
    socket.registerLocalClient('local:other', { sendFrame: (f) => { other.push(f as Frame); return true }, sendBinary: () => true })
    const queued: unknown[] = []
    vi.spyOn(upstreamOf(socket) as any, 'enqueue').mockImplementation((msg: unknown) => { queued.push(msg) })
    const replied = vi.spyOn(socket as any, 'emitReply')
    const held = deferred<Result>()
    const provider = vi.fn(() => held.promise)
    bindHandoffRequest(socket, provider)
    try {
      socket.handleLocalFrame('local:w', { type: 'agent_handoff_prepare', payload: good() })
      // The request must be in flight before the client leaves, or there is no late reply to test.
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
      await socket.unregisterLocalClient('local:w')
      held.resolve({ ...OK, file: '.harness/handoff/SECRETFILE.md' })
      // ...and the late reply must actually have been made. The window it was for has gone, so it goes
      // nowhere: it used to be queued for the relay as a targeted refusal, for a connection the backend
      // has never heard of (e2e/windows.e2e.ts).
      await vi.waitFor(() => expect(replied).toHaveBeenCalledWith('local:w', 'agent_handoff_prepare', 'r-1', expect.anything()))
      expect(queued.filter((m) => (m as { frame?: Frame }).frame?.type === 'agent_handoff_prepare_result')).toEqual([])
      expect(JSON.stringify(other)).not.toContain('SECRETFILE')
      expect(JSON.stringify(queued)).not.toContain('SECRETFILE')
      const seen = [...other, ...queued.map((m) => (m as { frame?: Frame }).frame)]
        .filter((f): f is Frame => !!f && f.type === 'agent_handoff_prepare_result')
      for (const f of seen) expect(f.payload.error).toBe('E2EE_REQUIRED')
      expect(asker.some((f) => JSON.stringify(f).includes('SECRETFILE'))).toBe(false)
    } finally {
      await socket.unregisterLocalClient('local:other')
      await socket.stop()
      vi.restoreAllMocks()
    }
  })
})

describe('agent_handoff_prepare sealing', () => {
  it('is sealed both ways: request, result and the non-strict peer path', () => {
    expect(encryptDownFrame('agent_handoff_prepare')).toBe(true)
    expect(encryptRpcResult('agent_handoff_prepare_result')).toBe(true)
    expect(encryptDownFrameFor('agent_handoff_prepare', { strictDown: false })).toBe(true)
    expect(encryptDownFrameFor('agent_handoff_prepare', { strictDown: true })).toBe(true)
  })
})
