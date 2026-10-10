/** Healthy capture and Close checkpoints recorded on main before the legacy path checks move. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { AgentEngine } from '../engines/types.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the control transcript golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/control-transcript.golden.json', import.meta.url))
const RECORD = process.env.RECORD_CONTROL_TRANSCRIPT_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

it.each(['linux', 'darwin'])('keeps complete native capture and checkpoint behavior on %s', async platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-transcript-golden-')))
  const path = (...parts: string[]) => join(root, ...parts)
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, text, { mode: 0o600 })
  }
  const check = (name: string, value: unknown) => {
    const key = `${platform}:${name}`
    captured[key] = JSON.parse(JSON.stringify(value).split(root).join('<root>'))
    if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T08:00:00Z') })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'PI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      mkdirSync(path(name), { recursive: true, mode: 0o700 }); vi.stubEnv(name, path(name))
    }
    vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects'))
    vi.stubEnv('TZ', 'UTC')
    const moved = path('moved-codex'), profile = path('profile')
    write(path('ADAPTER_DATA_DIR', 'engine-homes.json'), JSON.stringify({ claude: [], codex: [moved] }))
    const codex = JSON.stringify({ type: 'session_meta', payload: { id: A, cwd: root, source: 'cli' } }) + '\n'
    const claude = JSON.stringify({ type: 'user', cwd: root, sessionId: A, isSidechain: false }) + '\n'
    const pi = JSON.stringify({ type: 'session', version: 3, id: A, cwd: root }) + '\n'
    const cases: Array<{ name: string; engine: AgentEngine; file?: string; text?: string; profile?: string; id?: string }> = [
      { name: 'claude', engine: 'claude', file: path('CLAUDE_CONFIG_DIR', 'projects', 'project', `${A}.jsonl`), text: claude },
      { name: 'codex', engine: 'codex', file: path('CODEX_HOME', 'sessions', `rollout-${A}.jsonl`), text: codex },
      { name: 'moved-codex', engine: 'codex', file: join(moved, 'sessions', `rollout-${A}.jsonl`), text: codex },
      { name: 'profile-codex', engine: 'codex', file: join(profile, 'sessions', `rollout-${A}.jsonl`), text: codex, profile },
      { name: 'alias-codex', engine: 'codex', file: path('alias.jsonl') },
      { name: 'pi', engine: 'pi', file: path('PI_HOME', 'agent', 'sessions', 'workspace', `2026-10-10T08-00-00-000Z_${A}.jsonl`), text: pi },
      { name: 'unwritten-pi', engine: 'pi', id: B },
      { name: 'terminal', engine: 'terminal', id: '' },
    ]
    for (const fixture of cases) if (fixture.file && fixture.text) write(fixture.file, fixture.text)
    symlinkSync(cases[1].file!, path('alias.jsonl'))
    vi.resetModules()
    const { registry } = await import('./registry.js')
    const { captureResumeIdentity } = await import('./captureResumeIdentity.js')
    const { SessionCheckpointStore } = await import('./sessionCheckpoint.js')
    let pane = 0
    for (const fixture of cases) {
      const entry = registry.openPendingAgent({ engine: fixture.engine, cwd: root,
        codexHome: fixture.profile, runtimes: [{ backend: 'tmux', paneId: `%${++pane}` }] })!
      Object.assign(entry, { sessionId: fixture.id ?? A, transcriptPath: fixture.file ?? null, source: 'fixture' })
      const found = await captureResumeIdentity(entry)
      check(`${fixture.name}:capture`, { engine: found.engine, sessionId: found.sessionId,
        transcriptPath: found.transcriptPath, cwd: found.cwd, profile: found.codexHome, source: found.source })
      const directory = path('checkpoints', fixture.name), store = new SessionCheckpointStore(directory)
      await store.save(found, { screen: 'Unsent fixture draft' })
      const manifestFile = () => readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))!
      const first = JSON.parse(readFileSync(join(directory, manifestFile()), 'utf8'))
      await store.save(found, { screen: null })
      const again = JSON.parse(readFileSync(join(directory, manifestFile()), 'utf8'))
      const saved = readFileSync(join(directory, first.file), 'utf8')
      const contents = fixture.file ? saved : (() => {
        const snapshot = JSON.parse(saved); delete snapshot.agentId; return snapshot
      })()
      check(`${fixture.name}:checkpoint`, { engine: first.engine, sessionId: first.sessionId,
        source: first.source, profile: first.codexHome, savedAt: first.savedAt, contents,
        unchanged: JSON.stringify(first) === JSON.stringify(again),
        files: readdirSync(directory).map(name => name.endsWith('.screen.json') ? 'screen' : name.endsWith('.history') ? 'history' : 'manifest').sort() })
    }
    ;(await import('./engineHomes.js')).resetEngineHomes()
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
