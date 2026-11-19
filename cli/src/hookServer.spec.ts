import { randomBytes } from 'node:crypto'
import { request, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHookServer, type HookServerHandlers, chooseHookAgent, clientEnvPane, hookFacts, hookFiredAt, knownTranscriptFor } from './hookServer.js'
import { registry, type RegisteredSession } from './lib/registry.js'
import { env } from './config/env.js'
import { readHookCredential } from './lib/hookAuth.js'
import { ENGINES } from './engines/types.js'
import { engineHooks } from './engines/hooks.js'
import { pipeRequest } from './lib/windows/pipeClient.js'
import type { DoorRequest } from './core/serviceRoutes.js'

let server: Server | null = null

/** The fetch a test's calls go through: this OS user's process, so over the loopback port it shows the daemon's
 *  local credential (lib/localCredential.ts) — unless the test names its own `x-harness-local`. */
const realFetch = globalThis.fetch
function credentialedFetch(base: string, credential: string): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(base)) return realFetch(input, init)
    const headers = new Headers(init?.headers)
    if (!headers.has('x-harness-local')) headers.set('x-harness-local', credential)
    return realFetch(input, { ...init, headers })
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  if (!server) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

async function start(overrides: Partial<HookServerHandlers> = {}) {
  const handlers: HookServerHandlers = {
    onRegistered: vi.fn(),
    onSessionEnd: vi.fn(),
    ...overrides,
  }
  const started = await startHookServer(0, handlers)
  server = started.server
  const credential = readHookCredential(env.ADAPTER_DATA_DIR)
  if (!credential) throw new Error('hook credential was not created')
  credentialedFetch(`http://127.0.0.1:${started.port}`, credential)
  return {
    handlers,
    base: `http://127.0.0.1:${started.port}`,
    headers: { 'content-type': 'application/json', 'x-harness-hook-token': credential },
  }
}

describe('process-owned hook server', () => {

  it('honors engine admission before registering or announcing a prompt, including a failed check', async () => {
    const admit = vi.spyOn(engineHooks.codex, 'admit')
      .mockReturnValueOnce({ accepted: false, reason: 'codex_subagent' })
      .mockImplementation(() => { throw new Error('rollout unavailable') })
    const agent = { engine: 'codex', agentId: 'parent', runtimes: [{ backend: 'tmux', paneId: '%41' }], primaryRuntimeKey: 'tmux\u0000%41', processIdentity: { pid: 4242, startMarker: 'fixture', executable: '<codex>' } } as RegisteredSession
    const byAgent = vi.spyOn(registry, 'byAgent').mockReturnValue(agent)
    try {
      const onPromptSubmitted = vi.fn()
      const { handlers, base, headers } = await start({
        resolveHookAgent: async () => agent,
        onPromptSubmitted,
      })
      for (const reason of ['codex_subagent', 'engine_hook_failed']) {
        const response = await fetch(`${base}/api/hook/session-start`, {
          method: 'POST', headers,
          body: JSON.stringify({ engine: 'codex', tmuxPane: '%41', sessionId: 'child', hookEvent: 'UserPromptSubmit' }),
        })
        expect(await response.json()).toEqual(reason === 'engine_hook_failed' ? { pending: true } : { ignored: true, reason })
      }
      expect(handlers.onRegistered).not.toHaveBeenCalled()
      expect(onPromptSubmitted).not.toHaveBeenCalled()
    } finally { admit.mockRestore(); byAgent.mockRestore() }
  })

  it('keeps both hints of a mixed tmux and pty host array', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const runtimeHints = [{ backend: 'tmux', paneId: '%5' }, { backend: 'ptyhost', instance: 'p2', paneId: '%1003' }]
    await fetch(`${base}/api/hook/session-start`, { method: 'POST', headers,
      body: JSON.stringify({ engine: 'claude', sessionId: 'session-1', runtimeHints, callerPid: 4242 }) })
    expect(resolveHookAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimeHints }))
  })

  it('holds a hook whose pty host pane is another host instance\'s pane with the same id', async () => {
    const admit = vi.spyOn(engineHooks.codex, 'admit').mockReturnValue({ accepted: false, reason: 'codex_subagent' })
    const runtime = { backend: 'ptyhost', instance: 'p1', paneId: '%1' }
    const agent = { engine: 'codex', agentId: 'parent', runtimes: [runtime], primaryRuntimeKey: 'ptyhost\u0000p1\u0000%1', processIdentity: { pid: 4242, startMarker: 'fixture', executable: '<codex>' } } as unknown as RegisteredSession
    const byAgent = vi.spyOn(registry, 'byAgent').mockReturnValue(agent)
    try {
      const { base, headers } = await start({ resolveHookAgent: async () => agent })
      const post = async (instance: string) => (await fetch(`${base}/api/hook/session-start`, {
        method: 'POST', headers,
        body: JSON.stringify({ engine: 'codex', runtimeHints: [{ backend: 'ptyhost', instance, paneId: '%1' }], sessionId: `child-${instance}`, hookEvent: 'UserPromptSubmit' }),
      })).json()
      expect(await post('p2')).toEqual({ pending: true })
      expect(await post('p1')).toEqual({ ignored: true, reason: 'codex_subagent' })
    } finally { admit.mockRestore(); byAgent.mockRestore() }
  })

  it('runs targeted resolution and rejects a hook without a matching pane engine process', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { handlers, base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        engine: 'codex',
        tmuxPane: '%41',
        sessionId: '019fea92-e31a-7692-9c35-f616e9d458b7',
        cwd: '/work/demo',
      }),
    })

    expect(await response.json()).toEqual({ ignored: true, reason: 'no_matching_engine_process' })
    expect(resolveHookAgent).toHaveBeenCalledWith({
      engine: 'codex', tmuxPane: '%41', runtimeHints: [{ backend: 'tmux', paneId: '%41' }], callerPid: undefined,
      onWait: expect.any(Function),
    })
    expect(handlers.onRegistered).not.toHaveBeenCalled()
  })

  it('accepts a Herdr hint from a hook installed by an earlier build, and resolves by its tmux pane only', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        engine: 'codex',
        tmuxPane: '%41',
        sessionId: '019fea92-e31a-7692-9c35-f616e9d458b7',
        runtimeHints: [
          { backend: 'tmux', paneId: '%41' },
          { backend: 'herdr', paneId: 'w1:p1', sessionName: 'default', socketPath: '/tmp/herdr.sock' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(resolveHookAgent).toHaveBeenCalledWith({
      engine: 'codex', tmuxPane: '%41', runtimeHints: [{ backend: 'tmux', paneId: '%41' }], callerPid: undefined,
      onWait: expect.any(Function),
    })
  })

  it('resolves a hook from a pty host pane (Windows) by its instance and pane', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        engine: 'claude',
        sessionId: '7f3b1c2e-0a4d-4e5f-9a6b-1c2d3e4f5a6b',
        runtimeHints: [{ backend: 'ptyhost', instance: 'p2', paneId: '%1003' }],
        callerPid: 4242,
      }),
    })

    expect(response.status).toBe(200)
    expect(resolveHookAgent).toHaveBeenCalledWith({
      engine: 'claude', tmuxPane: undefined, runtimeHints: [{ backend: 'ptyhost', instance: 'p2', paneId: '%1003' }], callerPid: 4242,
      onWait: expect.any(Function),
    })
  })

  it.each(['p2-0.4.21-dev.win1', 'p2-h0123456789ab'])('resolves a hook from a versioned pty host\'s pane by its instance: %s', async (instance) => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const runtimeHints = [{ backend: 'ptyhost', instance, paneId: '%7' }]
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST', headers, body: JSON.stringify({ engine: 'claude', sessionId: 'session-1', runtimeHints, callerPid: 4242 }),
    })
    expect(response.status).toBe(200)
    expect(resolveHookAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimeHints }))
  })

  it('answers a hook whose agent has yet to record its process before the wait, and only logs what the wait finds', async () => {
    // The engine's hook command gives up on a reply after 500ms and then writes the registry itself, as for
    // a daemon that is down (hook/notify.mjs, fallbackRegister): held for the wait, its own row took the
    // agent's place under the running daemon. Answered first, it writes nothing.
    let found!: (agent: RegisteredSession | null) => void
    const resolveHookAgent = vi.fn(({ onWait }: { onWait?: () => void }) => {
      onWait?.()
      return new Promise<RegisteredSession | null>((resolve) => { found = resolve })
    })
    const { handlers, base, headers } = await start({ resolveHookAgent: resolveHookAgent as HookServerHandlers['resolveHookAgent'] })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const reply = await Promise.race([
        fetch(`${base}/api/hook/session-start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ engine: 'claude', tmuxPane: '%7', sessionId: 'session-7', callerPid: 4242 }),
        }),
        new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 2_000)),
      ])
      expect(reply).not.toBe('held')
      expect((reply as Response).status).toBe(202)
      expect(await (reply as Response).json()).toMatchObject({ pending: false, retry: true })
      // The wait ends with no agent for it: said in the log, and nothing is answered twice.
      found(null)
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[hooks] session- session-start ignored · no_matching_engine_process'))
      expect(handlers.onRegistered).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  it('ignores a hook whose only terminal is a Herdr pane', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        engine: 'claude',
        sessionId: 'session-1',
        runtimeHints: [{ backend: 'herdr', paneId: 'w1:p1', sessionName: 'default' }],
      }),
    })

    expect(await response.json()).toEqual({ ignored: true, reason: 'not_in_terminal' })
    expect(resolveHookAgent).not.toHaveBeenCalled()
  })

  it('rejects hooks outside configured terminal contexts before attempting process resolution', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { handlers, base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ engine: 'claude', sessionId: 'session-1', cwd: '/work/demo' }),
    })

    expect(await response.json()).toEqual({ ignored: true, reason: 'not_in_terminal' })
    expect(resolveHookAgent).not.toHaveBeenCalled()
    expect(handlers.onRegistered).not.toHaveBeenCalled()
  })

  it('treats SessionEnd as a reconciliation hint and exposes no launcher websocket endpoint', async () => {
    const onSessionEnd = vi.fn()
    const agent = { engine: 'claude', sessionId: 'session-1', agentId: 'agent-1', runtimes: [], processIdentity: null } as unknown as RegisteredSession
    vi.spyOn(registry, 'bySession').mockReturnValue(agent)
    vi.spyOn(registry, 'byAgent').mockReturnValue(agent)
    const resolveHookAgent = vi.fn(async () => agent)
    const { base, headers } = await start({ onSessionEnd, resolveHookAgent })
    const ended = await fetch(`${base}/api/hook/session-end`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        engine: 'claude', sessionId: 'session-1', reason: 'clear', tmuxPane: '%1', callerPid: 123,
      }),
    })
    expect(await ended.json()).toEqual({ ok: true })
    expect(onSessionEnd).toHaveBeenCalledWith('session-1', 'clear')

    const legacy = await fetch(`${base}/api/machine-ws`)
    expect(legacy.status).toBe(404)
  })

  it('rejects every unauthenticated mutating hook request', async () => {
    const { base, handlers } = await start()
    const response = await fetch(`${base}/api/hook/session-end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' })
    expect(handlers.onSessionEnd).not.toHaveBeenCalled()
  })

  it.each([
    [{ engine: 'claude', sessionId: 'session-1', tmuxPane: '%1', unknown: true }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'tmux', paneId: '%1', extra: true }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p1', paneId: '%1', extra: true }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'host', paneId: '%1' }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p2-0.4.21 x', paneId: '%1' }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p2-', paneId: '%1' }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p1', paneId: '1' }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p1' }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 1, paneId: '%1' }] }],
    [{ engine: 'claude', sessionId: 'session-1', runtimeHints: [{ backend: 'ptyhost', instance: 'p1', paneId: '%1\n' }] }],
    [{ engine: 'claude', sessionId: 'session-1', tmuxPane: '%1', source: { forged: true } }],
    [{ engine: 'claude', sessionId: 'session-1', tmuxPane: '%1', input: 'x'.repeat(128 * 1024 + 1) }],
    [null],
  ])('rejects malformed or unknown hook fields before process resolution', async (body) => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST', headers, body: JSON.stringify(body),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid hook body' })
    expect(resolveHookAgent).not.toHaveBeenCalled()
  })

  it.each([
    ['ok', 200], ['invalid', 400], ['dropped', 200],
  ] as const)('answers %s from onObserved with %i', async (outcome, status) => {
    const onObserved = vi.fn(() => outcome)
    const { base, headers } = await start({ onObserved })
    const response = await fetch(`${base}/api/hook/observed`, { method: 'POST', headers, body: JSON.stringify({ engine: 'claude' }) })
    expect(response.status).toBe(status)
    expect(onObserved).toHaveBeenCalledWith({ engine: 'claude' })
  })

  it('answers 200 to /api/hook/observed when no handler is wired', async () => {
    const { base, headers } = await start()
    expect((await fetch(`${base}/api/hook/observed`, { method: 'POST', headers, body: '{}' })).status).toBe(200)
  })

  it('answers 400 to a bad json body on /api/hook/observed', async () => {
    const onObserved = vi.fn(() => 'ok' as const)
    const { base, headers } = await start({ onObserved })
    expect((await fetch(`${base}/api/hook/observed`, { method: 'POST', headers, body: '{nope' })).status).toBe(400)
    expect(onObserved).not.toHaveBeenCalled()
  })

  it('answers 400 to a 4097-byte body', async () => {
    const onObserved = vi.fn(() => 'ok' as const)
    const { base, headers } = await start({ onObserved })
    const body = JSON.stringify({ pad: 'x'.repeat(4097 - 10) })
    expect(Buffer.byteLength(body)).toBe(4097)
    expect((await fetch(`${base}/api/hook/observed`, { method: 'POST', headers, body })).status).toBe(400)
    expect(onObserved).not.toHaveBeenCalled()
  })

  it('answers 401 without the hook token', async () => {
    const onObserved = vi.fn(() => 'ok' as const)
    const { base } = await start({ onObserved })
    const response = await fetch(`${base}/api/hook/observed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(401)
    expect(onObserved).not.toHaveBeenCalled()
  })

  describe('the mod\'s inbox route', () => {
    const INBOX = '/api/hook/inbox'
    const POLL = { sessionId: 'session-1' }
    const post = (base: string, path: string, headers: Record<string, string>, body: string, signal?: AbortSignal) =>
      fetch(`${base}${path}`, { method: 'POST', headers, body, signal })

    it('/api/hook/inbox answers 401 without the hook token', async () => {
      const handler = vi.fn(async () => 'invalid' as const)
      const { base } = await start({ onInbox: handler })
      expect((await post(base, INBOX, { 'content-type': 'application/json' }, '{}')).status).toBe(401)
      expect(handler).not.toHaveBeenCalled()
    })

    it('/api/hook/inbox answers 400 to a bad json body', async () => {
      const handler = vi.fn(async () => 'invalid' as const)
      const { base, headers } = await start({ onInbox: handler })
      expect((await post(base, INBOX, headers, '{nope')).status).toBe(400)
      expect(handler).not.toHaveBeenCalled()
    })

    it('/api/hook/inbox answers 400 to a body one byte over its limit, and takes one at it', async () => {
      const limit = 1024
      const handler = vi.fn(async () => 'invalid' as const)
      const { base, headers } = await start({ onInbox: handler })
      // `{"pad":""}` is 10 bytes.
      const padded = (bytes: number): string => JSON.stringify({ pad: 'x'.repeat(bytes - 10) })
      expect(Buffer.byteLength(padded(limit + 1))).toBe(limit + 1)
      expect((await post(base, INBOX, headers, padded(limit + 1))).status).toBe(400)
      expect(handler).not.toHaveBeenCalled()
      await post(base, INBOX, headers, padded(limit))
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('/api/hook/inbox answers 400 when the handler says invalid', async () => {
      const handler = vi.fn(async () => 'invalid' as const)
      const { base, headers } = await start({ onInbox: handler })
      expect((await post(base, INBOX, headers, JSON.stringify({ sessionId: 'session-1' }))).status).toBe(400)
      expect(handler).toHaveBeenCalledWith({ sessionId: 'session-1' }, expect.any(AbortSignal))
    })

    // The dial only shows a waiting prompt (docs/specs/2026-11-13-device-claude-orca.md): no route answers one.
    it('/api/hook/approval is no route: 404, with no decision', async () => {
      const { base, headers } = await start()
      const response = await post(base, '/api/hook/approval', headers, JSON.stringify({ sessionId: 'session-1', tool: 'Bash', summary: 'npm test' }))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not found' })
    })

    it.each([
      [{ text: 'run the tests' }, 200, { text: 'run the tests' }],
      [{}, 200, {}],
      ['off', 503, { error: 'NO_DEVICE' }],
    ] as const)('/api/hook/inbox answers %j with %i', async (answer, status, reply) => {
      const onInbox = vi.fn(async () => answer)
      const { base, headers } = await start({ onInbox })
      const response = await post(base, '/api/hook/inbox', headers, JSON.stringify({ sessionId: 'session-1' }))
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual(reply)
    })

    it('/api/hook/inbox answers 503 when no handler is wired', async () => {
      const { base, headers } = await start()
      const response = await post(base, '/api/hook/inbox', headers, JSON.stringify({ sessionId: 'session-1' }))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'NO_DEVICE' })
    })

    it('/api/hook/inbox aborts its signal when the client goes before the answer', async () => {
      let answer!: (value: { text?: string }) => void
      let reached!: (gone: AbortSignal) => void
      const held = new Promise<AbortSignal>((resolve) => { reached = resolve })
      const handler = vi.fn((_body: unknown, gone: AbortSignal) => {
        reached(gone)
        return new Promise<{ text?: string }>((resolve) => { answer = resolve })
      })
      const { base, headers } = await start({ onInbox: handler })
      const client = new AbortController()
      const request = post(base, INBOX, headers, JSON.stringify(POLL), client.signal).catch(() => 'gone')
      const gone = await held
      expect(gone.aborted).toBe(false)
      const aborted = new Promise<void>((resolve) => gone.addEventListener('abort', () => resolve(), { once: true }))
      client.abort()
      expect(await request).toBe('gone')
      await aborted
      // The answer that comes after has nobody to go to.
      answer({ text: 'late' })
    })

    // Over TCP, who is calling is looked up before any route (audit H1). A client gone during that closed before the route
    // listened for it: the route never saw it go, and sat reading a body that never comes.
    it('/api/hook/inbox lets go of a client that went while who it is was looked up, reading and forwarding nothing', async () => {
      const handler = vi.fn(async () => 'invalid' as const)
      let answered!: () => void
      const lookedUp = new Promise<void>((resolve) => { answered = resolve })
      // The lookup answers only once the client has gone.
      const peerAccount = (socket: Socket) => new Promise<boolean>((resolve) => socket.once('close', () => { resolve(true); answered() }))
      const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onInbox: handler }, { peerAccount })
      server = started.server
      const arrived: IncomingMessage[] = []
      server.prependListener('request', (req: IncomingMessage) => { arrived.push(req) })
      const client = new AbortController()
      const request = fetch(`http://127.0.0.1:${started.port}${INBOX}`, {
        method: 'POST', body: JSON.stringify(POLL), signal: client.signal,
        headers: { 'content-type': 'application/json', 'x-harness-hook-token': readHookCredential(env.ADAPTER_DATA_DIR)! },
      }).catch(() => 'gone')
      await vi.waitFor(() => expect(arrived).toHaveLength(1))
      client.abort()
      expect(await request).toBe('gone')
      await lookedUp
      // Every step the route takes after the lookup has run.
      await new Promise((resolve) => setImmediate(resolve))
      expect(arrived[0].listenerCount('data')).toBe(0)
      expect(handler).not.toHaveBeenCalled()
    })

    it('/api/hook/inbox leaves its signal alone once the answer is written', async () => {
      let seen: AbortSignal | undefined
      const handler = vi.fn(async (_body: unknown, gone: AbortSignal) => {
        seen = gone
        return {}
      })
      const { base, headers } = await start({ onInbox: handler })
      // This listener runs before the route's own: by the time it resolves, the route has heard the close too.
      const closed = new Promise<void>((resolve) => server!.once('request', (_req, res) => res.once('close', () => resolve())))
      const response = await post(base, INBOX, headers, JSON.stringify(POLL))
      expect(response.status).toBe(200)
      await response.text()
      await closed
      expect(seen?.aborted).toBe(false)
    })
  })

  it.each([
    ['/api/hook/session-end', { reason: 'clear' }, 'onSessionEnd'],
    ['/api/hook/turn-start', {}, 'onTurnStart'],
    ['/api/hook/tool-start', { toolUseId: 'tool-1', toolName: 'Task' }, 'onToolStart'],
    ['/api/hook/turn-stop', { status: 'error' }, 'onTurnStop'],
    ['/api/hook/wait', { hookEvent: 'PermissionRequest' }, 'onPersonWait'],
    ['/api/hook/subagent', { hookEvent: 'SubagentStart' }, 'onSubagent'],
  ] as const)('rejects a forged bound-session mutation on %s', async (path, extra, handlerName) => {
    const handler = vi.fn()
    const resolveHookAgent = vi.fn(async () => ({
      engine: 'claude', sessionId: 'real-session', agentId: 'agent-1',
    } as never))
    const { base, headers } = await start({ [handlerName]: handler, resolveHookAgent })
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        engine: 'claude', sessionId: 'forged-session', tmuxPane: '%1', callerPid: 123, ...extra,
      }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'UNBOUND_HOOK' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('hands a Stop on with when its engine ran it, and holds it as long as a test asks', async () => {
    const onTurnStop = vi.fn()
    const agent = { engine: 'claude', sessionId: 'real-session', agentId: 'agent-1', runtimes: [], processIdentity: null } as unknown as RegisteredSession
    vi.spyOn(registry, 'bySession').mockReturnValue(agent)
    vi.spyOn(registry, 'byAgent').mockReturnValue(agent)
    const resolveHookAgent = vi.fn(async () => agent)
    const stop = (base: string, headers: Record<string, string>) => fetch(`${base}/api/hook/turn-stop`, {
      method: 'POST', headers, body: JSON.stringify({ engine: 'claude', sessionId: 'real-session', tmuxPane: '%1', callerPid: 123 }),
    })
    const { base, headers } = await start({ onTurnStop, resolveHookAgent })
    expect((await stop(base, { ...headers, 'x-harness-hook-fired-at': '1700000000000' })).status).toBe(200)
    expect(onTurnStop).toHaveBeenLastCalledWith({ sessionId: 'real-session', status: undefined, transcriptPath: undefined, firedAt: 1_700_000_000_000 })
    // A hook client too old to say: as before.
    expect((await stop(base, headers)).status).toBe(200)
    expect(onTurnStop).toHaveBeenLastCalledWith({ sessionId: 'real-session', status: undefined, transcriptPath: undefined })
    server?.close()
    const held = await start({ onTurnStop, resolveHookAgent, stopHookDelayMs: 50 })
    onTurnStop.mockClear()
    expect((await stop(held.base, held.headers)).status).toBe(200)
    expect(onTurnStop).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onTurnStop).toHaveBeenCalledOnce())
  })

  it('reads when a hook was run from its header, and nothing else as that', () => {
    expect(hookFiredAt({ headers: { 'x-harness-hook-fired-at': '1700000000000' } })).toBe(1_700_000_000_000)
    for (const value of [undefined, '', 'soon', '-5', '0', '1.5', '1e400']) {
      expect(hookFiredAt({ headers: { 'x-harness-hook-fired-at': value } })).toBeUndefined()
    }
  })

  describe('the wait and subagent routes', () => {
    const hook = (base: string, headers: Record<string, string>, path: string, extra: Record<string, unknown> = {}) =>
      fetch(`${base}${path}`, { method: 'POST', headers,
        body: JSON.stringify({ engine: 'claude', sessionId: 'real-session', tmuxPane: '%1', callerPid: 123, ...extra }) })
    /** The session bound to the pane its hook ran in: the process the hook resolves to is its agent's. */
    const bound = () => {
      const agent = { engine: 'claude', sessionId: 'real-session', agentId: 'agent-1', runtimes: [], processIdentity: null } as unknown as RegisteredSession
      vi.spyOn(registry, 'bySession').mockReturnValue(agent)
      vi.spyOn(registry, 'byAgent').mockReturnValue(agent)
      return vi.fn(async () => agent)
    }

    it('hands a wait on with when its engine ran it', async () => {
      const onPersonWait = vi.fn()
      const { base, headers } = await start({ onPersonWait, resolveHookAgent: bound() })
      const waited = await hook(base, { ...headers, 'x-harness-hook-fired-at': '1700000000000' }, '/api/hook/wait',
        { hookEvent: 'PermissionRequest', toolName: 'Bash' })
      expect(waited.status).toBe(200)
      expect(await waited.json()).toEqual({ ok: true })
      expect(onPersonWait).toHaveBeenLastCalledWith({ sessionId: 'real-session', firedAt: 1_700_000_000_000 })
      // A hook client too old to say: the wait is handed on with no time.
      expect((await hook(base, headers, '/api/hook/wait', { hookEvent: 'PermissionRequest' })).status).toBe(200)
      expect(onPersonWait.mock.lastCall).toStrictEqual([{ sessionId: 'real-session' }])
    })

    it('a subagent hook says started or stopped by its event, and any other event is refused', async () => {
      const onSubagent = vi.fn()
      const resolveHookAgent = bound()
      const { base, headers } = await start({ onSubagent, resolveHookAgent })
      expect((await hook(base, headers, '/api/hook/subagent', { hookEvent: 'SubagentStart' })).status).toBe(200)
      expect(onSubagent).toHaveBeenLastCalledWith({ sessionId: 'real-session', started: true })
      // With when its engine ran it: a stop can be taken before its start (core/turns/turnHooks.ts).
      expect((await hook(base, { ...headers, 'x-harness-hook-fired-at': '1700000000000' }, '/api/hook/subagent',
        { hookEvent: 'SubagentStop' })).status).toBe(200)
      expect(onSubagent).toHaveBeenLastCalledWith({ sessionId: 'real-session', started: false, firedAt: 1_700_000_000_000 })
      onSubagent.mockClear()
      resolveHookAgent.mockClear()
      for (const extra of [{ hookEvent: 'Stop' }, { hookEvent: 'subagentstart' }, {}]) {
        const refused = await hook(base, headers, '/api/hook/subagent', extra)
        expect(refused.status).toBe(400)
        expect(await refused.json()).toEqual({ error: 'invalid hook body' })
      }
      expect(onSubagent).not.toHaveBeenCalled()
      expect(resolveHookAgent).not.toHaveBeenCalled()
    })

    // What the person is asked is theirs: a wait says only that the engine waits, and when.
    it('refuses a wait that carries a tool\'s input or a prompt', async () => {
      const onPersonWait = vi.fn()
      const resolveHookAgent = bound()
      const { base, headers } = await start({ onPersonWait, resolveHookAgent })
      for (const extra of [{ input: { command: 'ls' } }, { prompt: 'go on' }]) {
        const refused = await hook(base, headers, '/api/hook/wait', { hookEvent: 'PermissionRequest', ...extra })
        expect(refused.status).toBe(400)
        expect(await refused.json()).toEqual({ error: 'invalid hook body' })
      }
      expect(onPersonWait).not.toHaveBeenCalled()
      expect(resolveHookAgent).not.toHaveBeenCalled()
    })

    // A pane whose binding went stale sends one on every turn: a line a minute says it, as a refused host is said, on
    // every route, whichever session and route it was for.
    it('says an unbound hook at most once a minute on any route, and answers each one 403', async () => {
      const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const handlers = { onPersonWait: vi.fn(), onSubagent: vi.fn(), onTurnStop: vi.fn(), onSessionEnd: vi.fn(), onToolStart: vi.fn(),
          onTurnStart: vi.fn() }
        const { base, headers } = await start(handlers)
        const unbound = async (path: string, sessionId?: string) => {
          const refused = await hook(base, headers, path, { sessionId, hookEvent: 'SubagentStart', toolUseId: 'tool-1', toolName: 'Read' })
          expect(refused.status).toBe(403)
          expect(await refused.json()).toEqual({ error: 'UNBOUND_HOOK' })
        }
        await unbound('/api/hook/session-end', 'gone0001')
        await unbound('/api/hook/wait', 'gone0002')
        for (const [path, sessionId] of [['/api/hook/tool-start', 'gone0001'], ['/api/hook/turn-start', 'gone0002'],
          ['/api/hook/turn-stop', 'gone0001'], ['/api/hook/subagent', 'gone0003'], ['/api/hook/wait', undefined]] as const) {
          vi.setSystemTime(Date.now() + 60_001)
          await unbound(path, sessionId)
        }
        expect(said.mock.calls.filter(([line]) => String(line).includes('unbound'))).toEqual([
          ['[hooks] gone0001 session-end refused · unbound'],
          ['[hooks] gone0001 tool-start refused · unbound'],
          ['[hooks] gone0002 turn-start refused · unbound'],
          ['[hooks] gone0001 turn-stop refused · unbound'],
          ['[hooks] gone0003 subagent refused · unbound'],
          ['[hooks] ? wait refused · unbound'],
        ])
        for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()
      } finally { vi.useRealTimers() }
    })

    it('needs the hook token on each', async () => {
      const handlers = { onPersonWait: vi.fn(), onSubagent: vi.fn() }
      const { base } = await start({ ...handlers, resolveHookAgent: bound() })
      for (const path of ['/api/hook/wait', '/api/hook/subagent']) {
        const refused = await hook(base, { 'content-type': 'application/json' }, path, { hookEvent: 'SubagentStart' })
        expect(refused.status).toBe(401)
        expect(await refused.json()).toEqual({ error: 'UNAUTHORIZED' })
      }
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()
    })

    it('answers 400 to a body that is not JSON on every bound route', async () => {
      const { base, headers } = await start({ resolveHookAgent: bound() })
      for (const path of ['/api/hook/session-end', '/api/hook/tool-start', '/api/hook/turn-start', '/api/hook/wait', '/api/hook/subagent']) {
        const refused = await fetch(`${base}${path}`, { method: 'POST', headers, body: '{' })
        expect(refused.status).toBe(400)
        expect(await refused.json()).toEqual({ error: 'bad json' })
      }
    })
  })

  it('answers a proxied control-plane read whose handler throws, instead of hanging it', async () => {
    // The handler is a void-discarded async: a throw used to be an unhandledRejection and a request
    // with no response, which the desktop app reported 30s later as its own receive timeout.
    const { base } = await start({ onMachinesList: async () => { throw new TypeError('fetch failed') } })
    const response = await fetch(`${base}/api/machines`)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ success: false, error: { code: 'PROXY_FAILED', message: 'fetch failed' } })
  })

  it('hands a route a service answers on as it came, and writes its answer and the headers it declares', async () => {
    const heard: unknown[] = []
    const onServiceRoute = vi.fn((path: string, request: DoorRequest, localOk: boolean) => (path === '/api/auth/me' || path === '/api/desk/ops'
      ? (async () => {
        heard.push({ path, method: request.method, target: request.target, localOk, ...(request.method === 'GET' ? {} : { body: await request.readBody(4) }) })
        return { status: 504, body: { success: false, error: { code: 'BACKEND_TIMEOUT', message: 'slow' } }, headers: { 'x-harness-usage-vocabulary': '10' } }
      })()
      : null))
    const { base } = await start({ onServiceRoute })
    const response = await fetch(`${base}/api/auth/me?fresh=1`)
    expect(response.status).toBe(504)
    expect(response.headers.get('x-harness-usage-vocabulary')).toBe('10')
    expect(await response.json()).toEqual({ success: false, error: { code: 'BACKEND_TIMEOUT', message: 'slow' } })
    // A write's body as text, read up to its route's bound (past it, empty), and whether it carries the local header.
    await fetch(`${base}/api/desk/ops`, { method: 'POST', headers: { 'x-adapter-local': '1' }, body: '{}' })
    await fetch(`${base}/api/desk/ops`, { method: 'POST', body: '{"ops":[]}' })
    expect(heard).toEqual([
      { path: '/api/auth/me', method: 'GET', target: '/api/auth/me?fresh=1', localOk: false },
      { path: '/api/desk/ops', method: 'POST', target: '/api/desk/ops', localOk: true, body: '{}' },
      { path: '/api/desk/ops', method: 'POST', target: '/api/desk/ops', localOk: false, body: '' },
    ])
    // No service answers it: the door's own 404.
    const missing = await fetch(`${base}/api/nowhere`, { method: 'POST', body: '{}' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })
    // A path open without the credential (a hook's), asked without it, never reaches a service.
    onServiceRoute.mockClear()
    expect((await realFetch(`${base}/api/hook/unknown`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect(onServiceRoute).not.toHaveBeenCalled()
  })
})

// The hook says the gateway and the Codex home of its own environment in two headers (hook/notify.mjs): a daemon that
// does not read a header ignores it, where it refuses a body with a field it does not list.
describe('what a hook says of its own environment', () => {
  const GATEWAY = 'x-harness-hook-gateway', HOME = 'x-harness-hook-codex-home'

  it.each([
    [{ [GATEWAY]: 'ori' }, { gateway: 'ori' }, []],
    [{ [GATEWAY]: 'none' }, { gateway: null }, []],
    [{}, {}, []],
    [{ [GATEWAY]: 'vendor' }, {}, [GATEWAY]],
    [{ [GATEWAY]: 'ori, none' }, {}, [GATEWAY]],
    [{ [HOME]: '/home/u/.codex-work' }, { codexHome: '/home/u/.codex-work' }, []],
    [{ [HOME]: encodeURIComponent('/home/nguyễn/.codex work') }, { codexHome: '/home/nguyễn/.codex work' }, []],
    [{ [HOME]: encodeURIComponent(`/${'あ'.repeat(1023)}`) }, { codexHome: `/${'あ'.repeat(1023)}` }, []],
    [{ [HOME]: 'relative/home' }, {}, [HOME]],
    [{ [HOME]: `/${'x'.repeat(1024)}` }, {}, [HOME]],
    [{ [HOME]: '/bad%0Ahome' }, {}, [HOME]],
    [{ [HOME]: '/cut%E0%A4%A' }, {}, [HOME]],
    [{ [HOME]: '' }, {}, [HOME]],
  ])('%j is taken as %j, refusing %j', (headers, taken, refused) => {
    expect(hookFacts({ headers }, 'linux')).toEqual({ ...taken, refused })
  })

  // A home on a share or a device would have the core open another computer's folder on every registration
  // (cli/AGENTS.md rule 4): on Windows only a drive's path is taken, as agent_create takes one.
  it.each([
    ['C:\\Users\\u\\.codex-work', { codexHome: 'C:\\Users\\u\\.codex-work' }, []],
    ['\\\\host\\share\\.codex', {}, [HOME]],
    ['//host/share/.codex', {}, [HOME]],
    ['\\\\?\\C:\\x', {}, [HOME]],
    ['\\foo', {}, [HOME]],
    ['/foo', {}, [HOME]],
  ])('on Windows the home %j is taken as %j, refusing %j', (home, taken, refused) => {
    expect(hookFacts({ headers: { [HOME]: encodeURIComponent(home) } }, 'win32')).toEqual({ ...taken, refused })
  })

  /** A session-start from the pane of a live agent of `engine`, which registers: `registry.register` is spied and
   *  answers `result`. */
  async function registering(engine: 'claude' | 'codex', result: Record<string, unknown> = {}) {
    const agent = { engine, sessionId: '', agentId: `${engine}-agent`, active: true,
      runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux\u0000%1',
      processIdentity: { pid: 4242, startMarker: 'fixture', executable: `<${engine}>` } } as RegisteredSession
    vi.spyOn(registry, 'byAgent').mockReturnValue(agent)
    const register = vi.spyOn(registry, 'register')
      .mockResolvedValue({ entry: agent, isNew: true, evicted: null, rebound: null, orphaned: null, ...result })
    const { base, headers } = await start({ resolveHookAgent: async () => agent })
    const post = (extra: Record<string, string>) => fetch(`${base}/api/hook/session-start`, {
      method: 'POST', headers: { ...headers, ...extra },
      body: JSON.stringify({ engine, sessionId: 'session-1', tmuxPane: '%1', hookEvent: 'SessionStart' }),
    })
    return { register, post }
  }

  it('registers with the facts it took, and names a refused header without its value', async () => {
    const logged = (['log', 'warn', 'error', 'info', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}))
    const { register, post } = await registering('claude')
    // What the start said (the dial's prompts are off with no Unix socket, as here) is not this request's.
    vi.mocked(console.warn).mockClear()
    expect((await post({ [GATEWAY]: 'vendor', [HOME]: 'secret/place' })).status).toBe(200)
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    expect(register.mock.calls[0][0]).not.toHaveProperty('gateway')
    expect(register.mock.calls[0][0]).not.toHaveProperty('codexHome')
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['[hooks] session- SessionStart header refused · x-harness-hook-gateway'],
      ['[hooks] session- SessionStart header refused · x-harness-hook-codex-home'],
    ])
    expect(JSON.stringify(logged.flatMap(spy => spy.mock.calls))).not.toMatch(/vendor|secret/)
  })

  it('registers with the gateway it took', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { register, post } = await registering('claude')
    await post({ [GATEWAY]: 'ori' })
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    expect(register.mock.calls[0][0]).toMatchObject({ gateway: 'ori' })
  })

  it('takes the longest home a hook sends', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const home = `/${'あ'.repeat(1023)}`
    expect(Buffer.byteLength(encodeURIComponent(home))).toBe(9_210)
    const { register, post } = await registering('codex')
    expect((await post({ [HOME]: encodeURIComponent(home) })).status).toBe(200)
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    expect(register.mock.calls[0][0]).toMatchObject({ codexHome: home })
  })

  it('names a home the registration refused, without its value', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { register, post } = await registering('codex', { refusedHome: true })
    await post({ [HOME]: '/home/u/.codex-work' })
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[hooks] session- SessionStart header refused · x-harness-hook-codex-home'))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('codex-work')
  })

  it('reads neither on another route', async () => {
    const onTurnStop = vi.fn(), onSessionEnd = vi.fn()
    const agent = { engine: 'claude', sessionId: 'real-session', agentId: 'agent-1', runtimes: [], processIdentity: null } as unknown as RegisteredSession
    vi.spyOn(registry, 'bySession').mockReturnValue(agent)
    vi.spyOn(registry, 'byAgent').mockReturnValue(agent)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { base, headers } = await start({ onTurnStop, onSessionEnd, resolveHookAgent: async () => agent })
    // The start's own line (no Unix socket here) is not these requests'.
    warn.mockClear()
    for (const path of ['/api/hook/turn-stop', '/api/hook/session-end']) {
      const send = async (extra: Record<string, string>) => {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, ...extra },
          body: JSON.stringify({ engine: 'claude', sessionId: 'real-session', tmuxPane: '%1', callerPid: 123 }) })
        return [response.status, await response.json()]
      }
      expect(await send({ [GATEWAY]: 'vendor', [HOME]: 'secret/place' })).toEqual(await send({}))
    }
    expect(onTurnStop).toHaveBeenCalledTimes(2)
    expect(onTurnStop.mock.calls[0]).toEqual(onTurnStop.mock.calls[1])
    expect(onSessionEnd).toHaveBeenCalledTimes(2)
    expect(onSessionEnd.mock.calls[0]).toEqual(onSessionEnd.mock.calls[1])
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([{ gateway: 'ori' }, { codexHome: '/x' }])('a body that names them is refused as before: %j', async (field) => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent })
    const response = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST', headers, body: JSON.stringify({ engine: 'claude', sessionId: 'session-1', tmuxPane: '%1', ...field }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid hook body' })
    expect(resolveHookAgent).not.toHaveBeenCalled()
  })

  // The daemon a later hook will meet as the older one.
  it('ignores a header it does not read', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { register, post } = await registering('claude')
    await post({})
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    await post({ 'X-Harness-Hook-Next': '1' })
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2))
    expect(register.mock.calls[1][0]).toEqual(register.mock.calls[0][0])
    expect(register.mock.calls[0][1]?.current).toBeTypeOf('function')
    expect(register.mock.calls[1][1]).toEqual({ ...register.mock.calls[0][1], current: expect.any(Function) })
  })
})

// Hermes 0.22+ runs every session's hooks in one shared gateway, so a hook names the gateway's pane: on DESKTOP-0TFH0OJ
// (2026-11-09) `p2-0.5.80:%2002`, the first Hermes pane, for a conversation typed in `%2005`. The pane a session was
// opened from is frozen with its policy in Hermes' store, from the client's `terminal.client_env_passthrough` names.
describe('a Hermes hook from its shared gateway', () => {
  const FC = 'local-fc37402fa0f9bc03c97ab45ce86220a06510ce9e8fced80fb9ed2a39324ce67a'
  const DESKTOP = 'local-d199d58e8da30774bce4db24f350f2c05b7142a62dc92ed6df8f4d68a85eb6fd'
  const GATEWAY_PANE = { backend: 'ptyhost', instance: 'p2-0.5.80', paneId: '%2002' }
  /** Hermes 0.22.7's two tables, as much of them as is read: the session's row and its frozen policy. */
  const store = (rows: Array<[string, Record<string, string> | null]>) => {
    const { DatabaseSync } = (process as unknown as { getBuiltinModule(name: string): unknown }).getBuiltinModule('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
    }
    mkdirSync(env.HERMES_HOME, { recursive: true })
    rmSync(join(env.HERMES_HOME, 'state.db'), { force: true })
    const db = new DatabaseSync(join(env.HERMES_HOME, 'state.db'))
    const quote = (text: string) => `'${text.replaceAll('\'', '\'\'')}'`
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT); CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      ${rows.map(([id, clientEnv]) => `INSERT INTO sessions VALUES (${quote(id)}, 'local');
        INSERT INTO state_meta VALUES (${quote(`gateway.local_policy.v1:${id}`)},
          ${quote(JSON.stringify({ session_id: id, policy: { client_env_json: clientEnv && JSON.stringify(clientEnv), source: 'cli' } }))});`).join('\n')}`)
    db.close()
  }
  const hook = (base: string, headers: Record<string, string>, sessionId: string) => fetch(`${base}/api/hook/session-start`, {
    method: 'POST', headers, body: JSON.stringify({ engine: 'hermes', sessionId, hookEvent: 'on_session_start', runtimeHints: [GATEWAY_PANE], callerPid: 500 }),
  })

  it('is resolved by the pane its session was opened from, that pane alone the evidence', async () => {
    store([[FC, { HARNESS_PANE: 'p2-0.5.80:%2005', PATH: 'C:\\Windows' }]])
    const resolveHookAgent = vi.fn(async () => null)
    const hookViaSharedProcess = vi.fn(async () => true)
    const { base, headers } = await start({ resolveHookAgent, hookViaSharedProcess })
    expect((await hook(base, headers, FC)).status).toBe(200)
    expect(hookViaSharedProcess).toHaveBeenCalledWith({ engine: 'hermes', callerPid: 500 })
    expect(resolveHookAgent).toHaveBeenCalledWith({
      engine: 'hermes', tmuxPane: undefined, runtimeHints: [{ backend: 'ptyhost', instance: 'p2-0.5.80', paneId: '%2005' }],
      callerPid: 500, bySessionPane: true, onWait: expect.any(Function),
    })
  })

  it('is ignored, and says why, when its session names no pane (the Desktop app\'s, or a plain terminal\'s)', async () => {
    store([[DESKTOP, null]])
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent, hookViaSharedProcess: async () => true })
    const response = await hook(base, headers, DESKTOP)
    expect(await response.json()).toEqual({ ignored: true, reason: 'hermes_gateway_session_has_no_pane' })
    expect(resolveHookAgent).not.toHaveBeenCalled()
  })

  it('leaves a hook its pane\'s own Hermes ran as it came (Hermes 0.21 and older)', async () => {
    const resolveHookAgent = vi.fn(async () => null)
    const { base, headers } = await start({ resolveHookAgent, hookViaSharedProcess: async () => false })
    await hook(base, headers, FC)
    expect(resolveHookAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimeHints: [GATEWAY_PANE] }))
    expect(resolveHookAgent).toHaveBeenCalledWith(expect.not.objectContaining({ bySessionPane: true }))
  })
})

describe('the pane a Hermes client environment names', () => {
  it.each([
    ['a pty host pane', { HARNESS_PANE: 'p2-0.5.80:%2005' }, { backend: 'ptyhost', instance: 'p2-0.5.80', paneId: '%2005' }],
    ['a tmux pane, ahead of a pty host pane it runs in', { TMUX_PANE: '%7', HARNESS_PANE: 'p2:%1' }, { backend: 'tmux', paneId: '%7' }],
    ['nothing for no pane', { PATH: '/bin' }, null],
    ['nothing for a malformed tmux pane', { TMUX_PANE: '7' }, null],
    ['nothing for a malformed pty host pane', { HARNESS_PANE: '%2005' }, null],
  ])('%s', (_name, clientEnv, pane) => {
    expect(clientEnvPane(JSON.stringify(clientEnv))).toEqual(pane)
  })

  it.each([[null], [''], ['not json'], ['[]'], [42]])('nothing for a stored value that is not a map: %s', (value) => {
    expect(clientEnvPane(value)).toBeNull()
  })
})

describe('account Experimental settings proxy', () => {
  it('reads through the account proxy and guards writes with the local header', async () => {
    const snapshot = { accountId: 'owner', revision: 0, features: { focus_bar_creature: false, share_button: false } }
    const write = vi.fn(async (body: unknown) => ({ status: 200, body: { success: true, data: { ...snapshot, echo: body } } }))
    const { base } = await start({ onExperimentalRead: async () => ({ status: 200, body: { success: true, data: snapshot } }), onExperimentalWrite: write })
    expect((await (await fetch(`${base}/api/experimental-settings`)).json())).toEqual({ success: true, data: snapshot })
    const body = { accountId: 'owner', feature: 'share_button', enabled: true }
    expect((await fetch(`${base}/api/experimental-settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(403)
    expect(write).not.toHaveBeenCalled()
    const saved = await fetch(`${base}/api/experimental-settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: JSON.stringify(body) })
    expect(saved.status).toBe(200)
    expect(write).toHaveBeenCalledExactlyOnceWith(body)
    expect((await fetch(`${base}/api/experimental-settings`, { method: 'PATCH', headers: { 'x-adapter-local': '1' }, body: '{bad' })).status).toBe(400)
  })
})

describe('what the person lets agents do', () => {
  it('reads the agents\' settings as this computer keeps them, and writes a change through, guarded by the local header', async () => {
    // The account's experiments (core/experiments.ts `createAgentSettingsSync` answers both): every one off by default.
    const off = { agentsStartAgents: false, pullRequestLine: false, agentMessages: false, signedIn: true }
    const writes: unknown[] = []
    const { base } = await start({
      onAgentSettingsRead: async () => ({ status: 200, body: off }),
      onAgentSettingsWrite: async (body) => { writes.push(body); return { status: 200, body: { ...off, ...(body as object) } } },
    })
    const patch = (body: string, local = true) => fetch(`${base}/api/agent-settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(local ? { 'x-adapter-local': '1' } : {}) }, body })
    expect(await (await fetch(`${base}/api/agent-settings`)).json()).toEqual(off)
    expect((await patch('{"agentMessages":true}', false)).status).toBe(403)
    expect(await (await patch('{"agentMessages":true}')).json()).toEqual({ ...off, agentMessages: true })
    expect((await patch('{bad')).status).toBe(400)
    expect(writes).toEqual([{ agentMessages: true }])
  })

  it('answers UNAVAILABLE without a handler', async () => {
    const { base } = await start({})
    expect((await fetch(`${base}/api/agent-settings`)).status).toBe(503)
    expect((await fetch(`${base}/api/agent-settings`, { method: 'PATCH', headers: { 'x-adapter-local': '1' }, body: '{}' })).status).toBe(503)
  })
})

describe('optional feature routes are absent from core', () => {
  it.each(['/api/zoo', '/api/zoo/ops', '/api/hook/memory-context', '/api/hook/memory-emitted', '/api/hook/opencode-memory-runtime'])(
    'does not handle %s or consult account metadata', async path => {
      const me = vi.fn(async () => ({ status: 200, body: {} }))
      const { base } = await start({ onServiceRoute: (route) => (route === '/api/auth/me' ? me() : null) })
      const response = await fetch(`${base}${path}`, {
        method: path === '/api/zoo' ? 'GET' : 'POST', headers: { 'x-adapter-local': '1' }, body: path === '/api/zoo' ? undefined : '{}',
      })
      expect(response.status).toBe(404)
      expect(me).not.toHaveBeenCalled()
    },
  )
})

describe('knownTranscriptFor', () => {
  const sessionId = 'eae0ba40-3d0a-4340-9dd5-0a56ecbc080c'
  const root = mkdtempSync(join(tmpdir(), 'hook-transcript-'))
  const known = join(root, 'openharness', `${sessionId}.jsonl`)
  const announced = join(root, 'openharness-cli', `${sessionId}.jsonl`)
  mkdirSync(join(root, 'openharness'))
  writeFileSync(known, '{}\n')
  const row = { sessionId, transcriptPath: known } as RegisteredSession
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('takes the resumed row\'s transcript when Claude Code announced one under the wrong project dir', () => {
    expect(knownTranscriptFor({ engine: 'claude', sessionId, transcriptPath: announced }, row)).toBe(known)
  })

  it('keeps an announced transcript that exists', () => {
    expect(knownTranscriptFor({ engine: 'claude', sessionId, transcriptPath: known }, { ...row, transcriptPath: join(root, 'other.jsonl') })).toBe(known)
  })

  it('retains a failed native correction as unavailable evidence', () => {
    const lookup = vi.spyOn(engineHooks.claude, 'transcriptFor')
      .mockImplementationOnce(() => { throw new Error('lookup failed') })
      .mockImplementationOnce(() => { throw 'lookup failed again' })
    try {
      expect(() => knownTranscriptFor({ sessionId, transcriptPath: announced }, row)).toThrow()
      expect(() => knownTranscriptFor({ sessionId, transcriptPath: announced }, row)).toThrow()
    } finally { lookup.mockRestore() }
  })

  it.each<[string, Parameters<typeof knownTranscriptFor>[0], RegisteredSession | undefined]>([
    ['another conversation', { engine: 'claude', sessionId: 'other-conversation', transcriptPath: announced }, row],
    ['another engine', { engine: 'codex', sessionId, transcriptPath: announced }, row],
    ['a row whose file is not named by the conversation', { engine: 'claude', sessionId, transcriptPath: announced }, { ...row, transcriptPath: join(root, 'openharness', 'renamed.jsonl') }],
    ['a row whose file is gone', { engine: 'claude', sessionId, transcriptPath: announced }, { ...row, transcriptPath: join(root, 'gone', `${sessionId}.jsonl`) }],
    ['no row', { engine: 'claude', sessionId, transcriptPath: announced }, undefined],
    ['no announcement', { engine: 'claude', sessionId }, row],
    ['no conversation id', { engine: 'claude', transcriptPath: announced }, row],
  ])('leaves the announcement alone for %s', (_case, body, agent) => {
    expect(knownTranscriptFor(body, agent)).toBe(body.transcriptPath)
  })
})

describe('chooseHookAgent', () => {
  it('prefers caller ancestry, the evidence that cannot be guessed at', () => {
    expect(chooseHookAgent(['strong'], ['weak'], 'codex')).toEqual({ agent: 'strong', reason: 'ancestry' })
  })

  it('accepts the runtime alone when ancestry is unavailable and the pane is unambiguous', () => {
    // Cursor posts its hooks from outside the pane's process tree — on tmux and on Herdr alike — so
    // demanding ancestry rejected every hook it ever sent and no session bound. The pane is the proof:
    // the hook named a runtime, and that runtime carries exactly one agent of this engine.
    expect(chooseHookAgent([], ['only-agent-on-that-pane'], 'cursor')).toEqual({
      agent: 'only-agent-on-that-pane', reason: 'runtime',
    })
  })

  it('answers nothing rather than guessing', () => {
    expect(chooseHookAgent([], [], 'cursor')).toEqual({ agent: null, reason: 'none' })
    expect(chooseHookAgent([], ['a', 'b'], 'cursor')).toEqual({ agent: null, reason: 'ambiguous' })
    expect(chooseHookAgent(['a', 'b'], ['c'], 'cursor')).toEqual({ agent: null, reason: 'ambiguous' })
  })

  it.each(ENGINES.filter((engine) => engine !== 'cursor'))(
    'rejects a late %s hook when the pane now belongs to a replacement process',
    (engine) => {
      const replacement = { agentId: 'replacement-agent', sessionId: 'new-session' }
      expect(chooseHookAgent([], [replacement], engine)).toEqual({ agent: null, reason: 'none' })
      expect(chooseHookAgent([replacement], [replacement], engine))
        .toEqual({ agent: replacement, reason: 'ancestry' })
    },
  )
})

describe('/api/status', () => {
  it('serves whatever the daemon reports — including the pid the desktop uses to tell daemons apart', async () => {
    const { base } = await start({
      onStatus: () => ({ pid: process.pid, connected: false, restarting: false, discoveryReady: true }),
    })
    const response = await fetch(`${base}/api/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pid: process.pid, connected: false, restarting: false, discoveryReady: true })
  })
})

describe('browser setup links are gone', () => {
  // They served the retired web client; the route that minted them must not come back.
  it('mints nothing at the old /api/e2ee/setup-link route', async () => {
    const { base } = await start()
    const response = await fetch(`${base}/api/e2ee/setup-link`, { method: 'POST', headers: { 'x-adapter-local': '1' } })
    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain('setup=browser')
  })
})

describe('requests must name this server', () => {
  // A page that re-points its hostname at 127.0.0.1 is same-origin to this port; only its Host gives it away.
  async function send(base: string, method: string, path: string, headers: Record<string, string>): Promise<number> {
    const url = new URL(path, base)
    // This OS user's process: it shows the local credential, as every route but liveness wants over the port.
    const credentialed = { 'x-harness-local': readHookCredential(env.ADAPTER_DATA_DIR) ?? '', ...headers }
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: url.port, path: url.pathname, method, headers: credentialed }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      r.on('error', reject)
      r.end()
    })
  }

  it('refuses every route, reads included, when Host is not a loopback name for this port', async () => {
    const onStatus = vi.fn(() => ({ ok: true }))
    const { base } = await start({ onStatus })
    const evil = { host: 'rebind.evil.example:' + new URL(base).port }
    for (const [method, path, extra] of [
      ['GET', '/api/status', {}], ['GET', '/', {}], ['GET', '/api/machines', {}],
      ['POST', '/api/remote-password/set', { 'x-adapter-local': '1' }], ['POST', '/api/group/sync', { 'x-adapter-local': '1' }],
    ] as const) {
      expect(await send(base, method, path, { ...evil, ...extra }), `${method} ${path}`).toBe(403)
    }
    expect(onStatus).not.toHaveBeenCalled()
  })

  // Each is said at most once a minute, on a minute of its own: a pane whose binding went stale, refused every turn,
  // never hides a page refused for its Host, nor such a page the pane.
  it('says a refused Host in the same minute an unbound hook was said, and the other way round', async () => {
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { base, headers } = await start()
    const evil = { host: 'rebind.evil.example:' + new URL(base).port }
    const unbound = () => fetch(`${base}/api/hook/wait`, { method: 'POST', headers,
      body: JSON.stringify({ engine: 'claude', sessionId: 'gone0001', tmuxPane: '%1', callerPid: 123 }) })
    expect((await unbound()).status).toBe(403)
    expect(await send(base, 'GET', '/api/status', evil)).toBe(403)
    expect(await send(base, 'GET', '/api/status', evil)).toBe(403)
    expect((await unbound()).status).toBe(403)
    expect(said.mock.calls.map(([line]) => String(line).split(' · ')[0]).filter(line => line.includes('refused'))).toEqual([
      '[hooks] gone0001 wait refused',
      '[hooks] refused GET /api/status',
    ])
  })

  it('serves no web dashboard: its page, log tail and stop button are gone', async () => {
    // Nothing opened the page (no app, website, script or the backend), and the web client that linked to
    // it retired with the browser setup links (#348). `harness stop` stops the daemon by its pid.
    const { base } = await start({ onStatus: () => ({ ok: true }) })
    for (const [method, path] of [['GET', '/'], ['GET', '/index.html'], ['GET', '/api/logs'], ['POST', '/api/stop']] as const) {
      expect(await send(base, method, path, { 'x-adapter-local': '1' }), `${method} ${path}`).toBe(404)
    }
  })

  it('answers every request even when its handler throws, instead of leaving the caller waiting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let failing: 'read' | 'body' = 'read'
    const { base, headers } = await start({
      // A status that cannot be read, then one that cannot be written once its headers went out.
      onStatus: async () => { if (failing === 'read') throw new Error('status read failed'); return { n: 1n } },
      // A hook told "pending" before its resolution failed.
      resolveHookAgent: async ({ onWait }) => { onWait?.(); throw 'resolution failed after the answer' },
    })
    // Before the answer: a 500 the caller can act on, at once.
    const status = await fetch(`${base}/api/status`)
    expect(status.status).toBe(500)
    expect(await status.json()).toEqual({ error: 'INTERNAL' })
    // After the headers went out: the response is ended, not left open.
    failing = 'body'
    const unwritable = await fetch(`${base}/api/status`)
    expect(unwritable.status).toBe(200)
    expect(await unwritable.text()).toBe('')
    // After the response ended: nothing more to send, and nothing breaks.
    const hook = await fetch(`${base}/api/hook/session-start`, {
      method: 'POST', headers, body: JSON.stringify({ engine: 'codex', tmuxPane: '%41', sessionId: '019fea92-e31a-7692-9c35-f616e9d458b7' }),
    })
    expect(hook.status).toBe(202)
    expect(await hook.json()).toMatchObject({ pending: false, retry: true })
    expect(error).toHaveBeenCalledWith('[hooks] GET failed:', 'Error')
    expect(error).toHaveBeenCalledWith('[hooks] GET failed:', 'TypeError')
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[hooks] POST failed:', 'string'))
    error.mockRestore()
  })

  it('serves a status that has to read before it answers', async () => {
    // A harness's `updatedAt` is when its conversation last moved, which is read from its transcript.
    const { base } = await start({ onStatus: async () => ({ sessions: [{ id: 'a', updatedAt: 42 }] }) })
    const res = await fetch(`${base}/api/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [{ id: 'a', updatedAt: 42 }] })
  })

  it('still serves loopback names, and a page from the daemon\'s own origin', async () => {
    const { base } = await start({ onStatus: () => ({ ok: true }) })
    const port = new URL(base).port
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      expect(await send(base, 'GET', '/api/status', { host }), host).toBe(200)
    }
    expect(await send(base, 'GET', '/api/status', { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200)
    expect(await send(base, 'GET', '/api/status', { host: `127.0.0.1:${port}`, origin: 'http://evil.example' })).toBe(403)
  })
})

describe('the Wi-Fi device\'s routes at the door', () => {
  it('hands each on as it came once its checks pass, and writes the answer its service gave', async () => {
    const onServiceRoute = vi.fn((path: string, request: DoorRequest) => path === '/api/autonomous-device/nobody' ? null : (async () => {
      const body = request.method === 'GET' ? undefined : await request.readBody()
      return { status: 207, body: { path, request: { method: request.method, target: request.target, ...(body === undefined ? {} : { body }) } } }
    })())
    const { base } = await start({ onServiceRoute })
    const bearer = { authorization: `Bearer ${readHookCredential(env.ADAPTER_DATA_DIR)}` }
    // A read: its query goes with it, and no body.
    const read = await realFetch(`${base}/api/autonomous-device/status?all=true`, { headers: bearer })
    expect(read.status).toBe(207)
    expect(await read.json()).toEqual({ path: '/api/autonomous-device/status', request: { method: 'GET', target: '/api/autonomous-device/status?all=true' } })
    // A write: its body as text, whatever it holds, for its service to read.
    const write = await realFetch(`${base}/api/autonomous-device/revoke`, { method: 'POST', headers: bearer, body: 'not json' })
    expect(await write.json()).toEqual({ path: '/api/autonomous-device/revoke', request: { method: 'POST', target: '/api/autonomous-device/revoke', body: 'not json' } })
    // No service answers the path.
    const none = await realFetch(`${base}/api/autonomous-device/nobody`, { headers: bearer })
    expect(none.status).toBe(503)
    expect(await none.json()).toEqual({ error: { code: 'UNAVAILABLE', message: 'Autonomous device service unavailable' } })
    // The door's own refusal comes first: nothing is handed on.
    expect((await realFetch(`${base}/api/autonomous-device/status`)).status).toBe(403)
    expect(onServiceRoute).toHaveBeenCalledTimes(3)
  })

  it('answers 503 when no service is wired to answer them', async () => {
    const { base } = await start()
    const reply = await realFetch(`${base}/api/autonomous-device/status`, { headers: { authorization: `Bearer ${readHookCredential(env.ADAPTER_DATA_DIR)}` } })
    expect(reply.status).toBe(503)
  })
})

describe('the daemon socket', () => {
  function viaSocket(socketPath: string, method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const r = request({ socketPath, path, method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      r.on('error', reject)
      r.end()
    })
  }

  it('serves the same routes with no loopback Host, and keeps every other guard', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const onStatus = vi.fn(() => ({ ok: true }))
    const onServiceRoute = vi.fn(() => Promise.resolve({ status: 200, body: { ok: true } }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onStatus, onServiceRoute }, { socketPath })
    server = started.server
    try {
      expect(started.localSocket?.path).toBe(socketPath)
      // Node sends `Host: localhost` without a port over a socket — refused on TCP, fine here.
      expect(await viaSocket(socketPath, 'GET', '/api/status')).toBe(200)
      expect(await viaSocket(socketPath, 'GET', '/api/status', { host: 'rebind.evil.example' })).toBe(200)
      expect(onStatus).toHaveBeenCalledTimes(2)
      // The device routes ask for a loopback PEER; a socket peer has no address and is let in.
      const bearer = { authorization: `Bearer ${readHookCredential(env.ADAPTER_DATA_DIR)}` }
      expect(await viaSocket(socketPath, 'GET', '/api/autonomous-device/status', bearer)).toBe(200)
      expect(await viaSocket(socketPath, 'GET', '/api/autonomous-device/status')).toBe(403)
      expect(onServiceRoute).toHaveBeenCalledTimes(1)
      // Mutations still need the CSRF header, hooks still need their credential.
      expect(await viaSocket(socketPath, 'PATCH', '/api/agent-settings')).toBe(403)
      expect(await viaSocket(socketPath, 'POST', '/api/hook/session-start')).not.toBe(200)
      // The TCP port is untouched: a foreign Host is still refused there.
      const port = (started.server.address() as { port: number }).port
      const tcp = await new Promise<number>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port, path: '/api/status', headers: { host: 'rebind.evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
        r.on('error', reject)
        r.end()
      })
      expect(tcp).toBe(403)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says which requests came over the socket, for a route only the socket may ask (the phone\'s sign-in code)', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const onServiceRoute = vi.fn((_path: string, _request: DoorRequest, _localOk: boolean, socket: boolean) => Promise.resolve({ status: socket ? 200 : 403, body: {} }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onServiceRoute }, { socketPath })
    server = started.server
    try {
      const local = { 'x-adapter-local': '1' }
      expect(await viaSocket(socketPath, 'POST', '/api/auth/handoff', local)).toBe(200)
      const port = (started.server.address() as { port: number }).port
      // Over the port: refused without the local credential before any route, and not the socket with it.
      const tcp = await fetch(`http://127.0.0.1:${port}/api/auth/handoff`, { method: 'POST', headers: local })
      expect(tcp.status).toBe(401)
      const credential = readHookCredential(env.ADAPTER_DATA_DIR) ?? ''
      const credentialed = await fetch(`http://127.0.0.1:${port}/api/auth/handoff`, { method: 'POST', headers: { ...local, 'x-harness-local': credential } })
      expect(credentialed.status).toBe(403)
      expect(onServiceRoute.mock.calls.map(([path, , localOk, socket]) => [path, localOk, socket])).toEqual([['/api/auth/handoff', true, true], ['/api/auth/handoff', true, false]])
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('takes `harness stop` over the trusted endpoint only — never on the loopback port', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const onDaemonStop = vi.fn(async () => ({ status: 202, body: { ok: true } }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onDaemonStop }, { socketPath })
    server = started.server
    try {
      const local = { 'x-adapter-local': '1' }
      expect(await viaSocket(socketPath, 'POST', '/api/daemon/stop', local)).toBe(202)
      expect(await viaSocket(socketPath, 'POST', '/api/daemon/stop')).toBe(403)
      const port = (started.server.address() as { port: number }).port
      const tcp = await fetch(`http://127.0.0.1:${port}/api/daemon/stop`, { method: 'POST', headers: local })
      expect(tcp.status).toBe(401)
      const credential = readHookCredential(env.ADAPTER_DATA_DIR) ?? ''
      const credentialed = await fetch(`http://127.0.0.1:${port}/api/daemon/stop`, { method: 'POST', headers: { ...local, 'x-harness-local': credential } })
      expect(credentialed.status).toBe(403)
      expect(onDaemonStop).toHaveBeenCalledTimes(1)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('has no `harness stop` route where no handler is given: a Mac or Linux core, unchanged', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn() }, { socketPath })
    server = started.server
    try {
      expect(await viaSocket(socketPath, 'POST', '/api/daemon/stop', { 'x-adapter-local': '1' })).toBe(404)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('over the Windows pipe, serves only requests that prove the token, and trusts those', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, `harness-${randomBytes(16).toString('hex')}`)
    const token = randomBytes(32)
    const onServiceRoute = vi.fn((_path: string, _request: DoorRequest, _localOk: boolean, socket: boolean) => Promise.resolve({ status: socket ? 200 : 403, body: {} }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onServiceRoute }, { socketPath, pipeToken: token })
    server = started.server
    try {
      const local = { 'x-adapter-local': '1' }
      // The route a Unix socket's file mode guards: here the token is what lets it through.
      expect((await pipeRequest({ pipe: socketPath, token }, { method: 'POST', path: '/api/auth/handoff', headers: local })).status).toBe(200)
      expect(await viaSocket(socketPath, 'POST', '/api/auth/handoff', local)).toBe(401)
      expect(onServiceRoute).toHaveBeenCalledTimes(1)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts on TCP alone when the socket cannot be opened, and says why by the failure\'s kind, with no path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = mkdtempSync('/tmp/hsock-')
    const blocked = join(dir, 'daemon.sock')
    writeFileSync(blocked, 'not a socket')
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn() }, { socketPath: blocked })
    server = started.server
    expect(started.localSocket).toBeNull()
    expect(started.port).toBeGreaterThan(0)
    // The claim refuses a file that is no socket in words that name its path: only the kind is logged.
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith('[hooks] local socket'))).toEqual([['[hooks] local socket unavailable · Error']])
    rmSync(dir, { recursive: true, force: true })
  })

  // The permission hook (deviceClaude/asked.ts) and the mod's voice poll post over the socket only: without one, this line is
  // why the dial shows no waiting prompt and takes no voice.
  it('says once, with no path, that the dial\'s waiting prompts and voice are off where it has no Unix socket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const said = () => warn.mock.calls.filter(([line]) => String(line).includes('the dial\'s waiting prompts'))
    const dir = mkdtempSync('/tmp/hsock-')
    const blocked = join(dir, 'daemon.sock')
    writeFileSync(blocked, 'not a socket')
    try {
      for (const socketPath of [null, blocked]) {
        const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn() }, { socketPath })
        await new Promise<void>((resolve) => started.server.close(() => resolve()))
        expect(said()).toEqual([['[hooks] the dial\'s waiting prompts and voice from the Claude Code plugin are off: no Unix socket']])
        warn.mockClear()
      }
      const socketPath = join(dir, 'open.sock')
      const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn() }, { socketPath })
      await started.localSocket?.close()
      await new Promise<void>((resolve) => started.server.close(() => resolve()))
      expect(started.localSocket?.path).toBe(socketPath)
      expect(said()).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

it.each(['/api/hook/session-end', '/api/hook/turn-start', '/api/hook/tool-start', '/api/hook/turn-stop', '/api/hook/wait', '/api/hook/subagent'])(
  'refuses a binding changed during process resolution on %s', async path => {
    const row = { engine: 'claude', sessionId: 'race-session', agentId: 'race-agent', runtimes: [], processIdentity: null,
      evidenceRevision: 1 } as unknown as RegisteredSession
    vi.spyOn(registry, 'bySession').mockReturnValue(row)
    vi.spyOn(registry, 'byAgent').mockReturnValue(row)
    const mutation = vi.fn()
    const { base, headers } = await start({ onSessionEnd: mutation, onTurnStart: mutation, onToolStart: mutation, onTurnStop: mutation,
      onPersonWait: mutation, onSubagent: mutation,
      resolveHookAgent: async () => { await Promise.resolve(); row.evidenceRevision = 2; return row } })
    const response = await fetch(`${base}${path}`, { method: 'POST', headers,
      body: JSON.stringify({ engine: 'claude', sessionId: row.sessionId, tmuxPane: '%1', callerPid: 4242,
        toolUseId: 'fixture-tool', toolName: 'Task', hookEvent: 'SubagentStart' }) })
    expect(response.status).toBe(403)
    expect(mutation).not.toHaveBeenCalled()
  },
)

describe('audit H1: what a secret heard on the daemon\'s port can do', () => {
  const call = (port: number, path: string, headers: Record<string, string>, method = 'GET') =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) })

  const serve = async (peerAccount: () => Promise<boolean | 'unanswered'>) => {
    const started = await startHookServer(0, {
      onRegistered: vi.fn(), onSessionEnd: vi.fn(), onStatus: async () => ({ supported: true, secretDetail: 'x' }),
      onServiceRoute: () => Promise.resolve({ status: 200, body: { ok: true } }),
    }, { peerAccount })
    return { port: started.port, close: () => new Promise<void>((resolve) => { started.server.closeAllConnections(); started.server.close(() => resolve()) }) }
  }
  const credential = () => readFileSync(join(env.ADAPTER_DATA_DIR, 'hook-credential'), 'utf8').trim()
  const hookToken = () => readFileSync(join(env.ADAPTER_DATA_DIR, 'hook-token'), 'utf8').trim()

  it('the credential opens nothing for a caller of another account', async () => {
    const asked = vi.fn(async () => false)
    const { port, close } = await serve(asked)
    try {
      const secret = credential()
      expect((await call(port, '/api/machines', { 'X-Harness-Local': secret })).status).toBe(401)
      expect((await call(port, '/api/machines', { Authorization: `Bearer ${secret}` })).status).toBe(401)
      expect(await (await call(port, '/api/status', { 'X-Harness-Local': secret })).json()).not.toHaveProperty('secretDetail')
      expect((await call(port, '/api/autonomous-device/status', { Authorization: `Bearer ${secret}` })).status).toBe(403)
      expect(asked).toHaveBeenCalled()
    } finally { await close() }
  })

  it('the credential works for a caller of this account', async () => {
    const { port, close } = await serve(async () => true)
    try {
      expect(await (await call(port, '/api/status', { 'X-Harness-Local': credential() })).json()).toHaveProperty('secretDetail')
      expect((await call(port, '/api/autonomous-device/status', { Authorization: `Bearer ${credential()}` })).status).toBe(200)
    } finally { await close() }
  })

  // A lookup that gave no answer is not kept on the socket (lib/peerAccount.ts): both checks asking it waited a slow lsof out twice.
  it('asks who is calling once for a request whose hook token and credential both match', async () => {
    const asked = vi.fn(async () => true)
    const { port, close } = await serve(asked)
    try {
      expect((await call(port, '/api/hook/session-start', { 'x-harness-hook-token': credential(), 'X-Harness-Local': credential() }, 'POST')).status).not.toBe(401)
      expect(asked).toHaveBeenCalledOnce()
    } finally { await close() }
  })

  // Decided 2026-11-11: a lookup that gave no answer in time is not a refusal. The client is told to ask again.
  it('answers a secret whose caller could not be looked up in time with a retryable 503, and health and status as before', async () => {
    const { port, close } = await serve(async () => 'unanswered')
    try {
      for (const [path, headers, method] of [['/api/machines', { 'X-Harness-Local': credential() }, 'GET'],
        ['/api/hook/session-start', { 'x-harness-hook-token': hookToken() }, 'POST'], ['/api/autonomous-device/status', { Authorization: `Bearer ${credential()}` }, 'GET']] as const) {
        const reply = await call(port, path, headers, method)
        expect(reply.status, path).toBe(503)
        expect(reply.headers.get('retry-after')).toBe('1')
        expect(await reply.json()).toMatchObject({ error: 'PEER_LOOKUP_UNANSWERED' })
      }
      expect((await call(port, '/api/health', { 'X-Harness-Local': credential() })).status).toBe(200)
      // A status probe still finds the daemon there: its public status, as without the credential.
      expect(await (await call(port, '/api/status', { 'X-Harness-Local': credential() })).json()).not.toHaveProperty('secretDetail')
    } finally { await close() }
  })

  it('a wrong credential never makes the daemon ask who is calling', async () => {
    const asked = vi.fn(async () => true)
    const { port, close } = await serve(asked)
    try {
      expect((await call(port, '/api/machines', { 'X-Harness-Local': 'w'.repeat(43) })).status).toBe(401)
      expect(asked).not.toHaveBeenCalled()
    } finally { await close() }
  })

  it('the hook token opens the hook routes and nothing else', async () => {
    const { port, close } = await serve(async () => true)
    try {
      const token = hookToken()
      expect(token).not.toBe(credential())
      expect((await call(port, '/api/hook/session-start', { 'x-harness-hook-token': token }, 'POST')).status).not.toBe(401)
      const shown: Array<Record<string, string>> = [{ 'X-Harness-Local': token }, { Authorization: `Bearer ${token}` }, { 'x-harness-hook-token': token }]
      for (const headers of shown) {
        expect((await call(port, '/api/machines', headers)).status).toBe(401)
        expect(await (await call(port, '/api/status', headers)).json()).not.toHaveProperty('secretDetail')
        expect((await call(port, '/api/autonomous-device/status', headers)).status).toBe(403)
      }
    } finally { await close() }
  })

  it('a hook token or credential opens no hook route for a caller of another account', async () => {
    const { port, close } = await serve(async () => false)
    try {
      for (const secret of [hookToken(), credential()]) {
        expect((await call(port, '/api/hook/session-start', { 'x-harness-hook-token': secret }, 'POST')).status).toBe(401)
        expect((await call(port, '/api/hook/session-end', { 'x-harness-hook-token': secret }, 'POST')).status).toBe(401)
      }
    } finally { await close() }
  })

  it('an engine plugin loaded before the hook token keeps reporting with the credential', async () => {
    const { port, close } = await serve(async () => true)
    try {
      expect((await call(port, '/api/hook/session-start', { 'x-harness-hook-token': credential() }, 'POST')).status).not.toBe(401)
    } finally { await close() }
  })
})

describe('the loopback port wants this OS user\'s local credential', () => {
  // Another OS user's process reaches 127.0.0.1 too — a guest's harness running as its own user
  // (docs/plans/2026-10-19-guest-machine-sharing-plan.md). Only this user can read the 0600 credential.
  const raw = (port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      r.on('error', reject)
      r.end()
    })

  it('refuses every route without it, takes it by header or bearer, and leaves liveness and the hook routes alone', async () => {
    const onMachinesList = vi.fn(async () => ({ status: 200, body: { success: true, data: { machines: [] } } }))
    const started = await startHookServer(0, {
      onRegistered: vi.fn(), onSessionEnd: vi.fn(), onMachinesList,
      onStatus: () => ({ version: '9.9.9', pid: 42, corePid: 43, computerId: 'c1', machineId: 'm1', dataDir: '/secret/data', signedIn: true, localWs: { path: '/api/local-ws' }, localSocket: null }),
    } as Partial<HookServerHandlers> as HookServerHandlers)
    server = started.server
    const port = started.port
    const credential = readHookCredential(env.ADAPTER_DATA_DIR)!
    // Without it: the account's routes, reads and writes alike, are refused.
    for (const [method, path] of [['GET', '/api/machines'], ['GET', '/api/pairs'], ['POST', '/api/revoke-all'], ['GET', '/api/agent-settings'], ['GET', '/nowhere']] as const) {
      const answer = await raw(port, method, path, { 'x-adapter-local': '1' })
      expect(answer.status, `${method} ${path}`).toBe(401)
      expect(JSON.parse(answer.body)).toEqual({ error: 'LOCAL_CREDENTIAL_REQUIRED' })
    }
    // A wrong one is no better.
    expect((await raw(port, 'GET', '/api/machines', { 'x-harness-local': 'x'.repeat(43) })).status).toBe(401)
    // With it, by its header or as a bearer.
    expect((await raw(port, 'GET', '/api/machines', { 'x-harness-local': credential })).status).toBe(200)
    expect((await raw(port, 'GET', '/api/machines', { authorization: `Bearer ${credential}` })).status).toBe(200)
    expect(onMachinesList).toHaveBeenCalledTimes(2)
    // Liveness answers anyone; the status, only who the daemon is and where its socket is.
    expect((await raw(port, 'GET', '/api/health')).status).toBe(200)
    const open = await raw(port, 'GET', '/api/status')
    expect(open.status).toBe(200)
    expect(JSON.parse(open.body)).toEqual({ credentialRequired: true, version: '9.9.9', pid: 42, corePid: 43, computerId: 'c1', localWs: { path: '/api/local-ws' }, localSocket: null })
    const whole = JSON.parse((await raw(port, 'GET', '/api/status', { 'x-harness-local': credential })).body)
    expect(whole).toMatchObject({ machineId: 'm1', dataDir: '/secret/data', signedIn: true })
    // A hook route keeps its own token: refused for want of it, not of the local credential.
    const hook = await raw(port, 'POST', '/api/hook/session-end')
    expect(hook.status).toBe(401)
    expect(JSON.parse(hook.body)).toEqual({ error: 'UNAUTHORIZED' })
  })

  const viaSocket = (socketPath: string, method: string, path: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const r = request({ socketPath, path, method }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
      r.on('error', reject)
      r.end()
    })

  it('takes nothing over the daemon\'s own socket', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const onMachinesList = vi.fn(async () => ({ status: 200, body: { success: true, data: { machines: [] } } }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onMachinesList } as Partial<HookServerHandlers> as HookServerHandlers, { socketPath })
    server = started.server
    try {
      expect(await viaSocket(socketPath, 'GET', '/api/machines')).toBe(200)
      expect(onMachinesList).toHaveBeenCalledTimes(1)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
