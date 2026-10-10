/** Healthy registry, admission and Stop answers recorded from main before strict binding evidence. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the binding golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/binding-evidence.golden.json', import.meta.url))
const RECORD = process.env.RECORD_BINDING_EVIDENCE_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const C = 'cccccccc-3333-4333-8333-cccccccccccc', D = 'dddddddd-4444-4444-8444-dddddddddddd'
const E = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee', CHILD = 'ffffffff-6666-4666-8666-ffffffffffff'
const shape = (row: RegisteredSession | undefined | null) => row ? {
  agent: row.agentId, engine: row.engine, session: row.sessionId, transcript: row.transcriptPath,
  profile: row.codexHome, source: row.source,
} : null

it.each(['linux', 'darwin'])('preserves healthy binding and capture answers on %s', async platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'binding-evidence-golden-')))
  const path = (...parts: string[]) => join(root, ...parts)
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, text, { mode: 0o600 })
  }
  const check = (name: string, value: unknown) => {
    const key = `${platform}:${name}`
    captured[key] = JSON.parse(JSON.stringify(value ?? null).split(root).join('<root>'))
    if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T00:00:00Z') })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
      mkdirSync(path(name), { recursive: true, mode: 0o700 })
      vi.stubEnv(name, path(name))
    }
    vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects'))
    vi.stubEnv('TZ', 'UTC')
    const moved = path('moved-codex'), claude = path('CLAUDE_CONFIG_DIR', 'projects', 'project', `${E}.jsonl`)
    const parent = path('CODEX_HOME', 'sessions', 'day', `rollout-${A}.jsonl`)
    const child = path('CODEX_HOME', 'sessions', 'day', `rollout-${CHILD}.jsonl`)
    const movedFile = join(moved, 'sessions', 'day', `rollout-${B}.jsonl`)
    const profile = path('profile'), profiled = join(profile, 'sessions', `rollout-${C}.jsonl`)
    const outside = path('elsewhere', `rollout-${D}.jsonl`)
    const registeredFile = path('CODEX_HOME', 'sessions', 'day', `rollout-${D}.jsonl`)
    const meta = (id: string, source: unknown = 'cli') => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source } }) + '\n'
    write(parent, meta(A)); write(movedFile, meta(B)); write(profiled, meta(C)); write(outside, meta(D)); write(registeredFile, meta(D))
    write(child, meta(CHILD, { subagent: { thread_spawn: { parent_thread_id: A, depth: 1 } } }))
    write(claude, JSON.stringify({ type: 'user', cwd: root, sessionId: E, isSidechain: false }) + '\n')
    symlinkSync(parent, path('alias.jsonl'))
    write(path('ADAPTER_DATA_DIR', 'engine-homes.json'), JSON.stringify({ claude: [], codex: [moved] }))
    const legacy = (agent: string, engine: string, sessionId: string, transcriptPath: string | null, pane: number, codexHome: string | null = null) => ({
      launcherId: agent, engine, sessionId, transcriptPath, codexHome, tmuxPane: `%${pane}`, cwd: root,
      source: 'fixture', projectDir: 'project', processIdentity: null, registeredAt: 1, updatedAt: 1,
      lastHookAt: 1, lastTranscriptAt: 1,
    })
    write(path('ADAPTER_DATA_DIR', 'registry.json'), JSON.stringify([
      legacy('parent', 'codex', A, child, 1), legacy('moved', 'codex', B, movedFile, 2),
      legacy('profile', 'codex', C, profiled, 3, profile), legacy('outside', 'codex', D, outside, 4),
      legacy('claude', 'claude', E, claude, 5), legacy('terminal', 'terminal', '', null, 6),
    ]))
    vi.resetModules()
    const homes = await import('./engineHomes.js')
    const { registry, validTranscriptPath } = await import('./registry.js')
    const { admitHook } = await import('../engines/hooks.js')
    const { captureResumeIdentity } = await import('./captureResumeIdentity.js')
    registry.load()
    check('loaded', registry.list().map(shape).sort((a, b) => a!.agent.localeCompare(b!.agent)))
    check('paths', [validTranscriptPath('codex', parent), validTranscriptPath('codex', path('alias.jsonl')),
      validTranscriptPath('codex', movedFile), validTranscriptPath('codex', profiled, profile),
      validTranscriptPath('codex', outside), validTranscriptPath('claude', claude)])
    check('admission', [admitHook('codex', { transcriptPath: parent }), admitHook('codex', { transcriptPath: child }),
      admitHook('claude', { transcriptPath: claude })])
    check('homes', [homes.sessionHomeOf('codex', { transcriptPath: parent }),
      homes.sessionHomeOf('codex', { transcriptPath: movedFile }), homes.sessionHomeOf('codex', { profile, transcriptPath: profiled })])
    check('stop', [shape(await captureResumeIdentity(registry.byAgent('parent')!)), shape(await captureResumeIdentity(registry.byAgent('moved')!))])
    const bound = registry.register({ engine: 'codex', sessionId: D, transcriptPath: registeredFile, tmuxPane: '%6', cwd: root, source: 'fixture-register' })
    check('registered-terminal', bound && { row: shape(bound.entry), isNew: bound.isNew, evicted: bound.evicted, rebound: bound.rebound })
    check('saved', JSON.parse(readFileSync(path('ADAPTER_DATA_DIR', 'registry.json'), 'utf8')).map(shape).sort((a: any, b: any) => a.agent.localeCompare(b.agent)))
    homes.resetEngineHomes()
  } finally {
    log.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    Object.defineProperty(process, 'platform', originalPlatform)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})
