import { request, type Server } from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHookServer, type HookServerHandlers, chooseHookAgent, knownTranscriptFor } from './hookServer.js'
import { registry, type RegisteredSession } from './lib/registry.js'
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
  it.each(['claude', 'codex', 'opencode'] as const)('serves shared memory only to the live bound %s adapter', async engine => {
    const entry = { engine, agentId: 'coding-agent', sessionId: 'native',
      processIdentity: { pid: 42, executable: engine, startMarker: 'same-process' } } as RegisteredSession
    const resolveHookAgent = vi.fn(async () => entry as RegisteredSession | null)
    const onMemoryContext = vi.fn(() => ({ additionalContext: 'Historical coding context',
      memoryReceiptId: '77777777-7777-4777-8777-777777777777' }))
    const registration = vi.spyOn(registry, 'register')
    try {
      const { base, headers } = await start({ resolveHookAgent, onMemoryContext })
      const body = { engine, sessionId: 'native', callerPid: 42, tmuxPane: '%41', cliVersion: 'test-version', prompt: 'Review parser\nchanges.' }
      const submit = (value: unknown = body, authenticated = true) => fetch(`${base}/api/hook/memory-context`, {
        method: 'POST', headers: authenticated ? headers : {}, body: JSON.stringify(value) })
      expect((await submit(body, false)).status).toBe(401)
      expect((await submit({ ...body, sessionId: 'other-session' })).status).toBe(403)
      for (const changes of [{ callerPid: undefined }, { cliVersion: undefined }, { prompt: ' ' },
        { prompt: 'x'.repeat(4001) }, { projectId: 'caller-selected' }, { engine: 'terminal' }]) {
        expect((await submit({ ...body, ...changes })).status).toBe(400)
      }
      expect(onMemoryContext).not.toHaveBeenCalled()
      expect(await (await submit()).json()).toEqual({ ok: true, additionalContext: 'Historical coding context',
        memoryReceiptId: '77777777-7777-4777-8777-777777777777' })
      expect(onMemoryContext).toHaveBeenCalledExactlyOnceWith('coding-agent', 'Review parser\nchanges.', { engine, cliVersion: 'test-version' })
      expect(registration).not.toHaveBeenCalled()
      resolveHookAgent.mockResolvedValue(null)
      expect((await submit()).status).toBe(403)
    } finally { registration.mockRestore() }
  })

  it('never falls back to pane-only ownership for memory reads or OpenCode acknowledgements', async () => {
    const onMemoryContext = vi.fn(), onMemoryContextEmitted = vi.fn(async () => true)
    const lookup = vi.spyOn(registry, 'byPaneEngine').mockReturnValue({ engine: 'opencode', sessionId: 'native' } as RegisteredSession)
    try {
      const { base, headers } = await start({ onMemoryContext, onMemoryContextEmitted })
      const body = { engine: 'opencode', sessionId: 'native', callerPid: 42, tmuxPane: '%41', cliVersion: '1.18.34', prompt: 'Review parser.' }
      for (const route of ['memory-context', 'memory-emitted']) {
        const response = await fetch(`${base}/api/hook/${route}`, { method: 'POST', headers,
          body: JSON.stringify({ ...body, memoryReceiptId: '77777777-7777-4777-8777-777777777777' }) })
        expect(response.status).toBe(403)
      }
      expect(lookup).not.toHaveBeenCalled()
      expect(onMemoryContext).not.toHaveBeenCalled()
      expect(onMemoryContextEmitted).not.toHaveBeenCalled()
    } finally { lookup.mockRestore() }
  })

  it('bounds a stalled adapter read without sending late context', async () => {
    const entry = { engine: 'opencode', agentId: 'coding-agent', sessionId: 'native',
      processIdentity: { pid: 42, executable: 'opencode', startMarker: 'same-process' } } as RegisteredSession
    const { base, headers } = await start({ resolveHookAgent: async () => entry,
      onMemoryContext: async () => new Promise(() => {}) })
    const result = await fetch(`${base}/api/hook/memory-context`, { method: 'POST', headers,
      body: JSON.stringify({ engine: 'opencode', sessionId: 'native', callerPid: 42, tmuxPane: '%41', cliVersion: '1.18.34', prompt: 'Review parser.' }) })
    expect(await result.json()).toEqual({ ok: true })
  })

  it('accepts private OpenCode runtime observations only from the verified live session', async () => {
    const entry = { engine: 'opencode', agentId: 'companion', sessionId: 'native',
      processIdentity: { pid: 42, executable: 'opencode', startMarker: 'same-process' } } as RegisteredSession
    const resolveHookAgent = vi.fn(async () => entry as RegisteredSession | null)
    const onOpenCodeMemoryRuntime = vi.fn(() => ({ observe: true, recorded: true }))
    const registration = vi.spyOn(registry, 'register')
    try {
      const { base, headers, handlers } = await start({ resolveHookAgent, onOpenCodeMemoryRuntime })
      const body = { engine: 'opencode', sessionId: 'native', tmuxPane: '%41', callerPid: 42,
        input: { kind: 'observe', snapshot: { private: 'synthetic-secret' } } }
      const submit = (value: unknown = body, authenticated = true) => fetch(`${base}/api/hook/opencode-memory-runtime`, {
        method: 'POST', headers: authenticated ? headers : { 'content-type': 'application/json' }, body: JSON.stringify(value) })
      expect((await submit(body, false)).status).toBe(401)
      expect((await submit({ ...body, sessionId: 'previous-session' })).status).toBe(403)
      expect((await submit({ ...body, engine: 'codex' })).status).toBe(400)
      expect((await submit({ ...body, callerPid: undefined })).status).toBe(400)
      expect((await submit({ ...body, input: { blob: 'x'.repeat(51_000) } })).status).toBe(400)
      expect(onOpenCodeMemoryRuntime).not.toHaveBeenCalled()
      const accepted = await submit()
      expect(await accepted.json()).toEqual({ observe: true, recorded: true })
      expect(onOpenCodeMemoryRuntime).toHaveBeenCalledExactlyOnceWith(entry, body.input)
      expect(registration).not.toHaveBeenCalled()
      expect(handlers.onRegistered).not.toHaveBeenCalled()
      resolveHookAgent.mockResolvedValue(null)
      expect((await submit()).status).toBe(403)
    } finally { registration.mockRestore() }
  })

  it('does not accept private runtime data through discovery fallback without ancestry verification', async () => {
    const callback = vi.fn()
    const { base, headers } = await start({ onOpenCodeMemoryRuntime: callback })
    const result = await fetch(`${base}/api/hook/opencode-memory-runtime`, { method: 'POST', headers,
      body: JSON.stringify({ engine: 'opencode', sessionId: 'native', tmuxPane: '%41', callerPid: 42, input: { kind: 'probe' } }) })
    expect(result.status).toBe(403)
    expect(callback).not.toHaveBeenCalled()
  })

  it('attributes prompt text only after resolving the actual engine process', async () => {
    const entry = { engine: 'claude', agentId: 'agent-scope', sessionId: 'session-scope', runtimes: [{ backend: 'tmux', paneId: '%41' }] } as RegisteredSession
    const onPromptSubmitted = vi.fn()
    const onPromptContext = vi.fn(() => 'Companions collection context')
    const resolveHookAgent = vi.fn(async () => null as RegisteredSession | null)
    const registration = vi.spyOn(registry, 'register').mockReturnValue({ entry, isNew: false, evicted: null, rebound: null, orphaned: null })
    try {
      const { base, headers } = await start({ onPromptSubmitted, onPromptContext, resolveHookAgent })
      const submit = () => fetch(`${base}/api/hook/session-start`, { method: 'POST', headers, body: JSON.stringify({
        engine: 'claude', sessionId: entry.sessionId, tmuxPane: '%41', hookEvent: 'UserPromptSubmit', prompt: 'ask a peer\nfor evidence',
      }) })
      await submit()
      expect(onPromptSubmitted).not.toHaveBeenCalled()
      expect(onPromptContext).not.toHaveBeenCalled()
      resolveHookAgent.mockResolvedValue(entry)
      expect(await (await submit()).json()).toEqual({ ok: true, additionalContext: 'Companions collection context' })
      expect(onPromptContext).toHaveBeenCalledExactlyOnceWith('agent-scope', 'ask a peer\nfor evidence')
      expect(onPromptSubmitted).toHaveBeenCalledExactlyOnceWith('agent-scope', 'ask a peer\nfor evidence')
    } finally { registration.mockRestore() }
  })
  it.each(['claude', 'codex'] as const)('awaits bounded optional memory on a verified %s user prompt only', async engine => {
    const entry = { engine, agentId: 'memory_agent', sessionId: 'memory_session', runtimes: [{ backend: 'tmux', paneId: '%41' }] } as RegisteredSession
    const registration = vi.spyOn(registry, 'register').mockReturnValue({ entry, isNew: false, evicted: null, rebound: null, orphaned: null })
    const context = { additionalContext: 'Historical coding memory', memoryReceiptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    const onPromptContext = vi.fn(async () => context)
    try {
      const { base, headers } = await start({ resolveHookAgent: async () => entry, onPromptContext })
      const submit = async (hookEvent: string) => (await fetch(`${base}/api/hook/session-start`, { method: 'POST', headers,
        body: JSON.stringify({ engine, sessionId: entry.sessionId, tmuxPane: '%41', hookEvent, prompt: 'Fix the coding bug.' }) })).json()
      expect(await submit('SessionStart')).toEqual({ ok: true })
      expect(onPromptContext).not.toHaveBeenCalled()
      expect(await submit('UserPromptSubmit')).toEqual({ ok: true, ...context })
    } finally { registration.mockRestore() }
  })

  it.each(['failed', 'hung', 'oversized'] as const)('continues the prompt when optional recall is %s', async mode => {
    const entry = { engine: 'claude', agentId: 'memory_agent', sessionId: 'memory_session' } as RegisteredSession
    const registration = vi.spyOn(registry, 'register').mockReturnValue({ entry, isNew: false, evicted: null, rebound: null, orphaned: null })
    const onPromptContext = async (): Promise<string> => {
      if (mode === 'failed') throw new Error('Private provider error must not be returned.')
      if (mode === 'hung') return new Promise(() => {})
      return '🪴'.repeat(2_100)
    }
    try {
      const { base, headers } = await start({ resolveHookAgent: async () => entry, onPromptContext })
      const started = performance.now()
      const response = await fetch(`${base}/api/hook/session-start`, { method: 'POST', headers,
        body: JSON.stringify({ engine: 'claude', sessionId: entry.sessionId, tmuxPane: '%41', hookEvent: 'UserPromptSubmit' }) })
      expect(await response.json()).toEqual({ ok: true })
      expect(performance.now() - started).toBeLessThan(1_000)
    } finally { registration.mockRestore() }
  })

  it.each(['codex', 'opencode'] as const)('accepts emitted receipts only from a %s hook bound to the same live native session', async engine => {
    const entry = { engine, agentId: 'memory_agent', sessionId: 'memory_session',
      processIdentity: { pid: 42, executable: engine, startMarker: 'same-process' } } as RegisteredSession
    const resolveHookAgent = vi.fn(async () => entry)
    const onMemoryContextEmitted = vi.fn(async () => true)
    const { base, headers } = await start({ resolveHookAgent, onMemoryContextEmitted })
    const body = { engine, callerPid: 42, sessionId: entry.sessionId, tmuxPane: '%41', memoryReceiptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
    const submit = (value = body, authenticated = true) => fetch(`${base}/api/hook/memory-emitted`, {
      method: 'POST', headers: authenticated ? headers : { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    expect((await submit(body, false)).status).toBe(401)
    expect((await submit({ ...body, sessionId: 'old_session' })).status).toBe(403)
    expect((await submit({ ...body, memoryReceiptId: 'fabricated' })).status).toBe(400)
    expect(onMemoryContextEmitted).not.toHaveBeenCalled()
    expect(await (await submit()).json()).toEqual({ ok: true, recorded: true, delivery: 'unverified' })
    expect(onMemoryContextEmitted).toHaveBeenCalledExactlyOnceWith(entry.agentId, body.memoryReceiptId)
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
    })
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

describe('the zoo proxy', () => {
  it('reads the zoo ungated and writes its ops only with the local header, body passed through', async () => {
    const zoo = { daemons: [], eggs: [], pair: null, habits: [], firstEgg: false, pity: 0, easter: [] }
    const ops = vi.fn(async (body: unknown) => ({ status: 200, body: { success: true, data: { revision: 2, zoo, hatched: [], echo: body } } }))
    const deskRead = vi.fn()
    const { base } = await start({
      onZooRead: async () => ({ status: 200, body: { success: true, data: { revision: 1, zoo } } }),
      onZooOps: ops,
      onDeskRead: deskRead,
    })
    const read = await fetch(`${base}/api/zoo`)
    expect(await read.json()).toEqual({ success: true, data: { revision: 1, zoo } })
    expect(deskRead).not.toHaveBeenCalled()                  // its own document: a zoo read never reads the desk

    const refused = await fetch(`${base}/api/zoo/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ops":[]}' })
    expect(refused.status).toBe(403)
    expect(ops).not.toHaveBeenCalled()

    const body = { ops: [{ op: 'zoo.habit', key: 'turn' }] }
    const written = await fetch(`${base}/api/zoo/ops`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: JSON.stringify(body) })
    expect(((await written.json()) as { data: unknown }).data).toMatchObject({ revision: 2, hatched: [], echo: body })
    expect(ops).toHaveBeenCalledWith(body)

    const bad = await fetch(`${base}/api/zoo/ops`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: '{nope' })
    expect(bad.status).toBe(400)
  })

  it('passes a signed-out answer through as it came, the way the desk does', async () => {
    const signedOut = { status: 401, body: { success: false, error: { code: 'NOT_SIGNED_IN', message: 'Not signed in' } } }
    const { base } = await start({ onZooRead: async () => signedOut, onZooOps: async () => signedOut })
    const read = await fetch(`${base}/api/zoo`)
    expect(read.status).toBe(401)
    expect(await read.json()).toEqual(signedOut.body)
    const write = await fetch(`${base}/api/zoo/ops`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: '{"ops":[{"op":"zoo.habit","key":"turn"}]}' })
    expect(write.status).toBe(401)
  })

  it('passes a daemons-off answer through as it came: the window hides daemons on the 404', async () => {
    const off = { status: 404, body: { success: false, error: { code: 'DAEMONS_OFF', message: 'Daemons are off for this account or on this computer.' } } }
    const { base } = await start({ onZooRead: async () => off, onZooOps: async () => off })
    const read = await fetch(`${base}/api/zoo`)
    expect(read.status).toBe(404)
    expect(await read.json()).toEqual(off.body)
    const write = await fetch(`${base}/api/zoo/ops`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-adapter-local': '1' }, body: '{"ops":[{"op":"zoo.habit","key":"turn"}]}' })
    expect(write.status).toBe(404)
    expect(await write.json()).toEqual(off.body)
  })

  it('answers 503 on a daemon built without the zoo', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/api/zoo`)).status).toBe(503)
    expect((await fetch(`${base}/api/zoo/ops`, { method: 'POST', headers: { 'x-adapter-local': '1' }, body: '{}' })).status).toBe(503)
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
    const onLogs = vi.fn(() => 'secret log')
    const { base } = await start({ onStatus, onLogs })
    const evil = { host: 'rebind.evil.example:' + new URL(base).port }
    for (const [method, path, extra] of [
      ['GET', '/api/status', {}], ['GET', '/api/logs', {}], ['GET', '/', {}], ['GET', '/api/machines', {}],
      ['POST', '/api/remote-password/set', { 'x-adapter-local': '1' }], ['POST', '/api/stop', { 'x-adapter-local': '1' }],
    ] as const) {
      expect(await send(base, method, path, { ...evil, ...extra }), `${method} ${path}`).toBe(403)
    }
    expect(onStatus).not.toHaveBeenCalled()
    expect(onLogs).not.toHaveBeenCalled()
  })

  it('serves a status that has to read before it answers', async () => {
    // A harness's `updatedAt` is when its conversation last moved, which is read from its transcript.
    const { base } = await start({ onStatus: async () => ({ sessions: [{ id: 'a', updatedAt: 42 }] }) })
    const res = await fetch(`${base}/api/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [{ id: 'a', updatedAt: 42 }] })
  })

  it('still serves loopback names, and the dashboard from its own origin', async () => {
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
    const commandBar = { status: vi.fn(async () => ({ configured: false })), decide: vi.fn() }
    const started = await startHookServer(0, { onRegistered: vi.fn(), onSessionEnd: vi.fn(), onStatus, onCommandBar: commandBar as never }, { socketPath })
    server = started.server
    try {
      expect(started.localSocket?.path).toBe(socketPath)
      // Node sends `Host: localhost` without a port over a socket — refused on TCP, fine here.
      expect(await viaSocket(socketPath, 'GET', '/api/status')).toBe(200)
      expect(await viaSocket(socketPath, 'GET', '/api/status', { host: 'rebind.evil.example' })).toBe(200)
      expect(onStatus).toHaveBeenCalledTimes(2)
      // The command bar asked for a loopback PEER; a socket peer has no address and is let in.
      expect(await viaSocket(socketPath, 'GET', '/api/command-bar/status', { 'x-adapter-local': '1' })).toBe(200)
      expect(await viaSocket(socketPath, 'GET', '/api/command-bar/status')).toBe(403)
      // Mutations still need the CSRF header, hooks still need their credential.
      expect(await viaSocket(socketPath, 'POST', '/api/stop')).toBe(403)
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

describe('external session hooks', () => {
  it('needs the hook credential and hands the body to the external handler only', async () => {
    const onExternalHook = vi.fn(async () => ({ ok: true }))
    const { base, headers, handlers } = await start({ onExternalHook })
    const send = (body: string, auth = true) => fetch(`${base}/api/hook/external`, { method: 'POST', headers: auth ? headers : {}, body })
    expect((await send('{}', false)).status).toBe(401)
    expect((await send('{')).status).toBe(400)
    const body = { engine: 'claude', event: 'SessionStart', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' }
    expect(await (await send(JSON.stringify(body))).json()).toEqual({ ok: true })
    expect(onExternalHook).toHaveBeenCalledExactlyOnceWith(body)
    expect(handlers.onRegistered).not.toHaveBeenCalled()
  })

  it('answers ignored when no handler is wired', async () => {
    const { base, headers } = await start()
    const response = await fetch(`${base}/api/hook/external`, { method: 'POST', headers, body: '{}' })
    expect(await response.json()).toEqual({ ignored: true, reason: 'unavailable' })
  })
})
