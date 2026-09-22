import type { Server } from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHookServer, type HookServerHandlers, chooseHookAgent, knownTranscriptFor } from './hookServer.js'
import type { RegisteredSession } from './lib/registry.js'
import { env } from './config/env.js'
import { readHookCredential } from './lib/hookAuth.js'
import { CommandBarService } from './lib/commandBar.js'
import { ENGINES } from './engines/types.js'

let server: Server | null = null

describe('native command bar endpoints', () => {
  it('requires a native local header and rejects browser origins before evaluating', async () => {
    const decide = vi.fn()
    const { base } = await start({ onCommandBar: { status: vi.fn(), decide } })
    const attempts: Record<string, string>[] = [{}, { 'x-adapter-local': '1', origin: 'https://example.com' }]
    for (const headers of attempts) {
      const response = await fetch(`${base}/api/command-bar/resolve`, { method: 'POST', headers, body: '{}' })
      expect(response.status).toBe(403)
    }
    expect(decide).not.toHaveBeenCalled()
  })

  it('returns configuration without credentials and wraps useful setup errors', async () => {
    const { base } = await start({ onCommandBar: new CommandBarService({ key: async () => null }) })
    const headers = { 'x-adapter-local': '1', 'content-type': 'application/json' }
    const status = await fetch(`${base}/api/command-bar/status`, { headers })
    expect(await status.json()).toMatchObject({ success: true, data: { configured: false, provider: 'OpenRouter' } })
    const response = await fetch(`${base}/api/command-bar/resolve`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', candidates: [] }) })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'OPENROUTER_REQUIRED' } })
    const bad = await fetch(`${base}/api/command-bar/resolve`, { method: 'POST', headers, body: '{' })
    expect(bad.status).toBe(400)
    const large = await fetch(`${base}/api/command-bar/resolve`, { method: 'POST', headers, body: 'x'.repeat(129_000) })
    expect(large.status).toBe(413)
  })
})

afterEach(async () => {
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
    })
    expect(handlers.onRegistered).not.toHaveBeenCalled()
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
    const resolveHookAgent = vi.fn(async () => ({
      engine: 'claude', sessionId: 'session-1', agentId: 'agent-1',
    } as never))
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

  it.each<[string, Parameters<typeof knownTranscriptFor>[0], RegisteredSession | undefined]>([
    ['another conversation', { engine: 'claude', sessionId: 'other-conversation', transcriptPath: announced }, row],
    ['another engine', { engine: 'codex', sessionId, transcriptPath: announced }, row],
    ['a row whose file is not named by the conversation', { engine: 'claude', sessionId, transcriptPath: announced }, { ...row, transcriptPath: join(root, 'openharness', 'renamed.jsonl') }],
    ['a row whose file is gone', { engine: 'claude', sessionId, transcriptPath: announced }, { ...row, transcriptPath: join(root, 'gone', `${sessionId}.jsonl`) }],
    ['no row', { engine: 'claude', sessionId, transcriptPath: announced }, undefined],
    ['no announcement', { engine: 'claude', sessionId }, row],
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
