import { request, type Server } from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHookServer, type HookServerHandlers, chooseHookAgent, hookFiredAt, knownTranscriptFor } from './hookServer.js'
import { registry, type RegisteredSession } from './lib/registry.js'
import { env } from './config/env.js'
import { readHookCredential } from './lib/hookAuth.js'
import { ENGINES } from './engines/types.js'
import { engineHooks } from './engines/hooks.js'

let server: Server | null = null

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
    ['/api/hook/session-end', { reason: 'clear' }, 'onSessionEnd'],
    ['/api/hook/turn-start', {}, 'onTurnStart'],
    ['/api/hook/tool-start', { toolUseId: 'tool-1', toolName: 'Task' }, 'onToolStart'],
    ['/api/hook/turn-stop', { status: 'error' }, 'onTurnStop'],
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

  it('answers a proxied control-plane read whose handler throws, instead of hanging it', async () => {
    // The handler is a void-discarded async: a throw used to be an unhandledRejection and a request
    // with no response, which the desktop app reported 30s later as its own receive timeout.
    const { base } = await start({ onMachinesList: async () => { throw new TypeError('fetch failed') } })
    const response = await fetch(`${base}/api/machines`)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ success: false, error: { code: 'PROXY_FAILED', message: 'fetch failed' } })
  })

  it('forwards a proxied answer verbatim, status and body alike', async () => {
    const { base } = await start({
      onAuthMe: async () => ({ status: 504, body: { success: false, error: { code: 'BACKEND_TIMEOUT', message: 'slow' } } }),
    })
    const response = await fetch(`${base}/api/auth/me`)
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ success: false, error: { code: 'BACKEND_TIMEOUT', message: 'slow' } })
  })
})

describe('the desk proxy', () => {
  it('reads the desk ungated and writes its ops only with the local header, body passed through', async () => {
    const ops = vi.fn(async (body: unknown) => ({ status: 200, body: { success: true, data: { revision: 2, tabs: [], echo: body } } }))
    const { base } = await start({
      onDeskRead: async () => ({ status: 200, body: { success: true, data: { revision: 1, tabs: [] } } }),
      onDeskOps: ops,
    })
    const read = await fetch(`${base}/api/desk`)
    expect(await read.json()).toEqual({ success: true, data: { revision: 1, tabs: [] } })

    const refused = await fetch(`${base}/api/desk/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ops":[]}' })
    expect(refused.status).toBe(403)
    expect(ops).not.toHaveBeenCalled()

    const body = { ops: [{ op: 'tab.create', id: 'a', name: 'Local' }] }
    const written = await fetch(`${base}/api/desk/ops`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: JSON.stringify(body) })
    expect(((await written.json()) as { data: unknown }).data).toMatchObject({ revision: 2, echo: body })
    expect(ops).toHaveBeenCalledWith(body)

    const bad = await fetch(`${base}/api/desk/ops`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: '{nope' })
    expect(bad.status).toBe(400)
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

describe('optional feature routes are absent from core', () => {
  it.each(['/api/zoo', '/api/zoo/ops', '/api/hook/memory-context', '/api/hook/memory-emitted', '/api/hook/opencode-memory-runtime'])(
    'does not handle %s or consult account metadata', async path => {
      const me = vi.fn(async () => ({ status: 200, body: {} }))
      const { base } = await start({ onAuthMe: me })
      const response = await fetch(`${base}${path}`, {
        method: path === '/api/zoo' ? 'GET' : 'POST', headers: { 'x-adapter-local': '1' }, body: path === '/api/zoo' ? undefined : '{}',
      })
      expect(response.status).toBe(404)
      expect(me).not.toHaveBeenCalled()
    },
  )
})

describe('the Harness Store proxy', () => {
  it('forwards a store read with its path and query, and a store write only with the local header', async () => {
    const calls: Array<[string, string, unknown]> = []
    const { base } = await start({
      onStore: async (method, path, body) => { calls.push([method, path, body]); return { status: 200, body: { success: true, data: { ok: method } } } },
    })
    const read = await fetch(`${base}/api/store/harnesses/autonomous/marp/reviews?limit=5`)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ success: true, data: { ok: 'GET' } })

    const crossOrigin = await fetch(`${base}/api/store/harnesses/autonomous/marp/review`, { method: 'PUT', body: JSON.stringify({ rating: 5 }) })
    expect(crossOrigin.status).toBe(403)

    const write = await fetch(`${base}/api/store/harnesses/autonomous/marp/review`, {
      method: 'PUT', headers: { 'x-adapter-local': '1', 'content-type': 'application/json' }, body: JSON.stringify({ rating: 5, title: 'Keynote' }),
    })
    expect(write.status).toBe(200)
    const gone = await fetch(`${base}/api/store/harnesses/autonomous/marp/review`, { method: 'DELETE', headers: { 'x-adapter-local': '1' } })
    expect(gone.status).toBe(200)
    expect(calls).toEqual([
      ['GET', '/api/store/harnesses/autonomous/marp/reviews?limit=5', undefined],
      ['PUT', '/api/store/harnesses/autonomous/marp/review', { rating: 5, title: 'Keynote' }],
      ['DELETE', '/api/store/harnesses/autonomous/marp/review', undefined],
    ])
  })

  it('refuses a store path with anything but id characters in it', async () => {
    const { base } = await start({ onStore: async () => ({ status: 200, body: {} }) })
    expect((await fetch(`${base}/api/store/harnesses/a%20b/reviews`)).status).toBe(400)
    expect((await fetch(`${base}/api/store/ratings`, { method: 'POST', headers: { 'x-adapter-local': '1' } })).status).toBe(405)
  })
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
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: url.port, path: url.pathname, method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
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
    expect(error).toHaveBeenCalledWith('[hooks] GET /api/status failed:', 'status read failed')
    expect(error).toHaveBeenCalledWith('[hooks] GET /api/status failed:', expect.stringContaining('BigInt'))
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[hooks] POST /api/hook/session-start failed:', 'resolution failed after the answer'))
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

describe('the trust group endpoints', () => {
  const local = { 'x-adapter-local': '1', 'content-type': 'application/json' }
  const key = Buffer.alloc(32, 7).toString('base64')
  const machineId = 'a'.repeat(32)

  it('trust-peer takes only a real key and machine id, and trims the label', async () => {
    const onTrustLinkedPeer = vi.fn(() => ({ status: 200, body: { ok: true } }))
    const { base } = await start({ onTrustLinkedPeer })
    const post = (body: unknown, headers: Record<string, string> = local) =>
      fetch(`${base}/api/link/trust-peer`, { method: 'POST', headers, body: JSON.stringify(body) })
    for (const bad of [{ pub: 'x', machineId }, { pub: key, machineId: 'nope' }, { machineId }, { pub: `${key}AA`, machineId }]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await post({ pub: key, machineId }, { 'content-type': 'application/json' })).status).toBe(403)
    expect((await post({ pub: key, machineId, label: `  ${'n'.repeat(80)} ` })).status).toBe(200)
    expect(onTrustLinkedPeer).toHaveBeenCalledTimes(1)
    expect(onTrustLinkedPeer).toHaveBeenCalledWith({ pub: key, machineId, label: 'n'.repeat(60) })
  })

  it('group remove and sync are local writes; list is readable', async () => {
    const onGroupRemove = vi.fn(() => ({ status: 200, body: { label: 'b', fingerprint: 'fp' } }))
    const onGroupSync = vi.fn(() => ({ status: 200, body: { ok: true } }))
    const onGroupList = vi.fn(() => ({ status: 200, body: { members: [] } }))
    const { base } = await start({ onGroupRemove, onGroupSync, onGroupList })
    expect((await fetch(`${base}/api/group/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"selector":"1"}' })).status).toBe(403)
    expect((await fetch(`${base}/api/group/sync`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${base}/api/group/remove`, { method: 'POST', headers: local, body: '{"selector":"  "}' })).status).toBe(400)
    expect((await fetch(`${base}/api/group/remove`, { method: 'POST', headers: local, body: '{"selector":" 1 "}' })).status).toBe(200)
    expect(onGroupRemove).toHaveBeenCalledWith('1')
    expect((await fetch(`${base}/api/group/sync`, { method: 'POST', headers: local })).status).toBe(200)
    expect(await (await fetch(`${base}/api/group`)).json()).toEqual({ members: [] })
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
    const onAutonomousDeviceRequest = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onStatus, onAutonomousDeviceRequest }, { socketPath })
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
      expect(onAutonomousDeviceRequest).toHaveBeenCalledTimes(1)
      // Mutations still need the CSRF header, hooks still need their credential.
      expect(await viaSocket(socketPath, 'POST', '/api/group/sync')).toBe(403)
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

  it('hands out a phone sign-in code over the socket only — never on the loopback port', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const socketPath = join(dir, 'daemon.sock')
    const onAuthHandoff = vi.fn(async () => ({ status: 200, body: { success: true, data: { code: 'hnh_x', expiresIn: 90 } } }))
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onAuthHandoff }, { socketPath })
    server = started.server
    try {
      const local = { 'x-adapter-local': '1' }
      expect(await viaSocket(socketPath, 'POST', '/api/auth/handoff', local)).toBe(200)
      expect(await viaSocket(socketPath, 'POST', '/api/auth/handoff')).toBe(403)
      const port = (started.server.address() as { port: number }).port
      const tcp = await fetch(`http://127.0.0.1:${port}/api/auth/handoff`, { method: 'POST', headers: local })
      expect(tcp.status).toBe(403)
      expect(onAuthHandoff).toHaveBeenCalledTimes(1)
    } finally {
      await started.localSocket?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('starts on TCP alone when the socket cannot be opened', async () => {
    const dir = mkdtempSync('/tmp/hsock-')
    const blocked = join(dir, 'daemon.sock')
    writeFileSync(blocked, 'not a socket')
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn() }, { socketPath: blocked })
    server = started.server
    expect(started.localSocket).toBeNull()
    expect(started.port).toBeGreaterThan(0)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the device history and dismiss endpoints', () => {
  const local = { 'x-adapter-local': '1', 'content-type': 'application/json' }

  it('history needs the local header', async () => {
    const onDevicesHistory = vi.fn(async () => ({ status: 200, body: { rows: [], complete: true, frozen: null } }))
    const { base } = await start({ onDevicesHistory })
    expect((await fetch(`${base}/api/devices/history`)).status).toBe(403)
    expect(onDevicesHistory).not.toHaveBeenCalled()
    const ok = await fetch(`${base}/api/devices/history`, { headers: local })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ rows: [], complete: true, frozen: null })
  })

  it('dismiss needs the local header, parses the body and refuses bad JSON', async () => {
    const onDevicesDismiss = vi.fn(() => ({ status: 200, body: { ok: true } }))
    const { base } = await start({ onDevicesDismiss })
    const post = (body: string, headers: Record<string, string> = local) => fetch(`${base}/api/devices/dismiss`, { method: 'POST', headers, body })
    expect((await post('{}', { 'content-type': 'application/json' })).status).toBe(403)
    expect(onDevicesDismiss).not.toHaveBeenCalled()
    expect((await post('{bad')).status).toBe(400)
    expect((await post(JSON.stringify({ pub: 5 }))).status).toBe(400)
    expect((await post(JSON.stringify({ pub: 'k' }))).status).toBe(200)
    expect(onDevicesDismiss).toHaveBeenLastCalledWith({ pub: 'k' })
    expect((await post(JSON.stringify({ baseline: true }))).status).toBe(200)
    expect(onDevicesDismiss).toHaveBeenLastCalledWith({ baseline: true })
    expect((await post('{}')).status).toBe(200)
    expect(onDevicesDismiss).toHaveBeenLastCalledWith({})
    // The keys a window displayed: a list of strings, bounded.
    expect((await post(JSON.stringify({ pubs: ['a', 'b'] }))).status).toBe(200)
    expect(onDevicesDismiss).toHaveBeenLastCalledWith({ pubs: ['a', 'b'] })
    expect((await post(JSON.stringify({ pubs: 'a' }))).status).toBe(400)
    expect((await post(JSON.stringify({ pubs: ['a', 5] }))).status).toBe(400)
    expect((await post(JSON.stringify({ pubs: Array.from({ length: 257 }, (_, i) => `k${i}`) }))).status).toBe(400)
  })

  it('rebaseline passes the previewed head on, and refuses a malformed one', async () => {
    const onDevicesRebaseline = vi.fn(async () => ({ status: 200, body: {} }))
    const { base } = await start({ onDevicesRebaseline })
    const post = (body: unknown) => fetch(`${base}/api/devices/rebaseline`, { method: 'POST', headers: local, body: JSON.stringify(body) })
    expect((await post({ confirm: true, head: { seq: 3, hash: 'h' } })).status).toBe(200)
    expect(onDevicesRebaseline).toHaveBeenLastCalledWith(true, { seq: 3, hash: 'h' })
    expect((await post({ confirm: true })).status).toBe(200)
    expect(onDevicesRebaseline).toHaveBeenLastCalledWith(true, undefined)
    expect((await post({ confirm: true, head: { seq: -1, hash: 'h' } })).status).toBe(400)
    expect((await post({ confirm: true, head: 'x' })).status).toBe(400)
  })
})


it.each(['/api/hook/session-end', '/api/hook/turn-start', '/api/hook/tool-start', '/api/hook/turn-stop'])(
  'refuses a binding changed during process resolution on %s', async path => {
    const row = { engine: 'claude', sessionId: 'race-session', agentId: 'race-agent', runtimes: [], processIdentity: null,
      evidenceRevision: 1 } as unknown as RegisteredSession
    vi.spyOn(registry, 'bySession').mockReturnValue(row)
    vi.spyOn(registry, 'byAgent').mockReturnValue(row)
    const mutation = vi.fn()
    const { base, headers } = await start({ onSessionEnd: mutation, onTurnStart: mutation, onToolStart: mutation, onTurnStop: mutation,
      resolveHookAgent: async () => { await Promise.resolve(); row.evidenceRevision = 2; return row } })
    const response = await fetch(`${base}${path}`, { method: 'POST', headers,
      body: JSON.stringify({ engine: 'claude', sessionId: row.sessionId, tmuxPane: '%1', callerPid: 4242,
        toolUseId: 'fixture-tool', toolName: 'Task' }) })
    expect(response.status).toBe(403)
    expect(mutation).not.toHaveBeenCalled()
  },
)
