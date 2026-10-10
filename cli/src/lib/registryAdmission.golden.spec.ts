/** Former healthy registration and ownership transfers, recorded before atomic admission. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the registration golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/registry-admission.golden.json', import.meta.url))
const RECORD = process.env.RECORD_REGISTRY_ADMISSION_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const C = 'cccccccc-3333-4333-8333-cccccccccccc', CHILD = 'dddddddd-4444-4444-8444-dddddddddddd'

it.each(['linux', 'darwin'])('preserves healthy registration and transfers on %s', async platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-admission-golden-')))
  const path = (...parts: string[]) => join(root, ...parts)
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 })
  }
  const labels = new Map<string, string>()
  const shape = (row: RegisteredSession) => ({ agent: labels.get(row.agentId), engine: row.engine,
    session: row.sessionId, transcript: row.transcriptPath, cwd: row.cwd, source: row.source,
    active: row.active, terminalHost: row.terminalHost ?? false })
  const check = (name: string, value: unknown) => {
    const key = `${platform}:${name}`
    let text = JSON.stringify(value ?? null).split(root).join('<root>')
    for (const [id, label] of labels) text = text.split(id).join(`<${label}>`)
    captured[key] = JSON.parse(text)
    if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T00:00:00Z') })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
      mkdirSync(path(name), { recursive: true, mode: 0o700 }); vi.stubEnv(name, path(name))
    }
    vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects')); vi.stubEnv('TZ', 'UTC')
    write(path('ADAPTER_DATA_DIR', 'engine-homes.json'), '{}')
    const codex = path('CODEX_HOME', 'sessions', `rollout-${A}.jsonl`)
    const child = path('CODEX_HOME', 'sessions', `rollout-${CHILD}.jsonl`)
    const claude = (id: string) => path('CLAUDE_CONFIG_DIR', 'projects', 'fixture', `${id}.jsonl`)
    const meta = (id: string, source: unknown = 'cli') => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source } }) + '\n'
    write(codex, meta(A)); write(child, meta(CHILD, { subagent: { thread_spawn: { parent_thread_id: A, depth: 1 } } }))
    for (const id of [B, C]) write(claude(id), JSON.stringify({ type: 'user', cwd: root, sessionId: id, isSidechain: false }) + '\n')
    vi.resetModules()
    const { registry } = await import('./registry.js')
    for (const [index, engine] of (['claude', 'codex', 'terminal'] as const).entries()) {
      const { entry } = registry.openProcessAgent({ engine, tmuxPane: `%${index + 1}`, cwd: root,
        processIdentity: { pid: 4100 + index, startMarker: 'fixture-start', executable: `<${engine}>` } })!
      labels.set(entry.agentId, engine)
    }
    const register = (engine: 'claude' | 'codex', pane: string, id: string, transcriptPath: string, cwd = root) => {
      const result = registry.register({ engine, tmuxPane: pane, sessionId: id, transcriptPath, cwd, source: 'fixture' })
      return result && { ...result, entry: shape(result.entry) }
    }
    check('first', register('claude', '%1', B, claude(B)))
    check('same-preserves-folder', register('claude', '%1', B, claude(B), path('temporary-shell-folder')))
    check('rotation', register('claude', '%1', C, claude(C)))
    check('terminal-promotion', register('codex', '%3', A, codex))
    check('move-active', register('codex', '%2', A, codex))
    check('after-active-move', registry.list().map(shape))
    registry.setActive(registry.byPaneEngine('%2', 'codex')!.agentId, false)
    check('move-dormant', register('codex', '%3', A, codex))
    check('delegated-rejected', register('codex', '%3', CHILD, child))
    check('final-live', registry.list().map(shape))
    check('final-saved', JSON.parse(readFileSync(path('ADAPTER_DATA_DIR', 'registry.json'), 'utf8')).map(shape))
    ;(await import('./engineHomes.js')).resetEngineHomes()
  } finally {
    log.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    Object.defineProperty(process, 'platform', descriptor)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})
