/** Healthy HTTP hook behavior recorded from main before pending native admission is moved. */
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './lib/registry.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the hook admission golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./lib/loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('./lib/bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./lib/processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/hook-admission.golden.json', import.meta.url))
const RECORD = process.env.RECORD_HOOK_ADMISSION_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const CHILD = 'cccccccc-3333-4333-8333-cccccccccccc'

it.each(['linux', 'darwin'])('preserves healthy native hook admission on %s', async platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-admission-golden-')))
  const path = (...parts: string[]) => join(root, ...parts)
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 })
  }
  let server: Server | undefined
  const labels = new Map<string, string>()
  const shape = (row: RegisteredSession | undefined | null) => row ? {
    agent: labels.get(row.agentId), engine: row.engine, session: row.sessionId,
    transcript: row.transcriptPath, source: row.source,
  } : null
  const check = (name: string, value: unknown) => {
    const key = `${platform}:${name}`
    captured[key] = JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
    if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T00:00:00Z') })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HARNESS_HOOK_ROUTES_DIR']) {
      mkdirSync(path(name), { recursive: true, mode: 0o700 }); vi.stubEnv(name, path(name))
    }
    vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects'))
    vi.stubEnv('TZ', 'UTC')
    write(path('ADAPTER_DATA_DIR', 'engine-homes.json'), '{}')
    const claude = path('CLAUDE_CONFIG_DIR', 'projects', 'fixture', `${A}.jsonl`)
    const codex = path('CODEX_HOME', 'sessions', `rollout-${B}.jsonl`)
    const child = path('CODEX_HOME', 'sessions', `rollout-${CHILD}.jsonl`)
    write(claude, JSON.stringify({ type: 'user', cwd: root, sessionId: A, isSidechain: false }) + '\n')
    const meta = (id: string, source: unknown = 'cli') => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source } }) + '\n'
    write(codex, meta(B)); write(child, meta(CHILD, { subagent: { thread_spawn: { parent_thread_id: B, depth: 1 } } }))
    vi.resetModules()
    const { registry } = await import('./lib/registry.js')
    const { startHookServer } = await import('./hookServer.js')
    const { readHookCredential } = await import('./lib/hookAuth.js')
    const agents = new Map<string, RegisteredSession>()
    for (const [index, engine] of (['claude', 'codex'] as const).entries()) {
      const { entry } = registry.openProcessAgent({ engine, tmuxPane: `%${index + 1}`, cwd: root,
        processIdentity: { pid: 4100 + index, startMarker: 'fixture-start', executable: `<${engine}>` } })!
      agents.set(engine, entry); labels.set(entry.agentId, engine)
    }
    const registered: unknown[] = [], prompts: unknown[] = [], promptHooks: unknown[] = [], turns: unknown[] = [], ends: unknown[] = []
    const started = await startHookServer(0, {
      resolveHookAgent: async input => registry.byAgent(agents.get(input.engine)?.agentId ?? '') ?? null,
      onRegistered: (entry, meta) => { registered.push({ row: shape(entry), ...meta }) },
      onPromptSubmitted: (agentId, prompt) => { prompts.push({ agent: labels.get(agentId), prompt }) },
      onPromptHook: (sessionId, firedAt) => { promptHooks.push({ sessionId, firedAt }) },
      onTurnStart: value => { turns.push({ start: value }) },
      onTurnStop: value => { turns.push({ stop: value }) },
      onToolStart: value => { turns.push({ tool: value }) },
      onSessionEnd: (sessionId, reason) => { ends.push({ sessionId, reason }) },
    })
    server = started.server
    const send = async (endpoint: string, body: Record<string, unknown>, authorized = true) => {
      const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-hook-fired-at': '1791590400123',
          ...(authorized ? { 'x-harness-hook-token': readHookCredential(path('ADAPTER_DATA_DIR'))! } : {}) },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    }
    const claudeBody = { engine: 'claude', tmuxPane: '%1', sessionId: A, transcriptPath: claude, cwd: root, source: 'fixture' }
    const codexBody = { engine: 'codex', tmuxPane: '%2', sessionId: B, transcriptPath: codex, cwd: root, source: 'fixture' }
    check('authentication', await send('session-start', claudeBody, false))
    check('claude-start', await send('session-start', { ...claudeBody, hookEvent: 'SessionStart' }))
    check('claude-prompt', await send('session-start', { ...claudeBody, hookEvent: 'UserPromptSubmit', prompt: 'healthy Claude prompt' }))
    check('codex-start', await send('session-start', { ...codexBody, hookEvent: 'SessionStart' }))
    check('codex-prompt', await send('session-start', { ...codexBody, hookEvent: 'UserPromptSubmit', prompt: 'healthy Codex prompt' }))
    check('delegated', await send('session-start', { ...codexBody, sessionId: CHILD, transcriptPath: child,
      hookEvent: 'UserPromptSubmit', prompt: 'delegated prompt' }))
    check('bound-controls', [await send('turn-start', codexBody), await send('tool-start', { ...codexBody, toolUseId: 'tool-1', toolName: 'Read', input: { file: '<file>' } }),
      await send('turn-stop', { ...codexBody, status: 'completed' }), await send('session-end', { ...codexBody, reason: 'exit' })])
    check('unbound-control', await send('turn-stop', { ...codexBody, sessionId: CHILD }))
    check('callbacks', { registered, prompts, promptHooks, turns, ends })
    check('bindings', registry.list().map(shape).sort((a, b) => a!.agent!.localeCompare(b!.agent!)))
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    log.mockRestore(); warn.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    Object.defineProperty(process, 'platform', originalPlatform)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})
