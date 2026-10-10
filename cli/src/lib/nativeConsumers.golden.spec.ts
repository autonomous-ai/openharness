/** Former-code healthy history deletion and Change agent handoff, before native authority moves. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import type { AgentEngine } from '../engines/types.js'
import type { RegisteredSession } from './registry.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the native consumers golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const info = fs.lstatSync(...args)
    // Allocation is a declared fixture fact; the host filesystem's block size is not a contract.
    if (info?.isFile()) Object.defineProperty(info, 'blocks', { value: typeof info.size === 'bigint' ? 8n : 8 })
    return info
  } }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/native-consumers.golden.json', import.meta.url))
const RECORD = process.env.RECORD_NATIVE_CONSUMERS_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const AT = Date.parse('2026-10-10T09:00:00Z')

it.each(['linux', 'darwin'])('keeps native history consumer outcomes on %s', async platform => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-consumers-golden-')))
  const path = (...parts: string[]) => join(root, ...parts)
  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o600 })
  }
  const check = (name: string, value: unknown) => {
    const key = `${platform}:${name}`
    captured[key] = JSON.parse(JSON.stringify(value).split(root).join('<root>'))
    if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
  }
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: AT })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'PI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      mkdirSync(path(name), { recursive: true, mode: 0o700 }); vi.stubEnv(name, path(name))
    }
    vi.stubEnv('CLAUDE_PROJECTS_DIR', path('CLAUDE_CONFIG_DIR', 'projects')); vi.stubEnv('TZ', 'UTC')
    const moved = path('moved-codex'), profile = path('profile-codex'), cwd = path('workspace')
    mkdirSync(cwd)
    write(path('ADAPTER_DATA_DIR', 'engine-homes.json'), JSON.stringify({ claude: [], codex: [moved] }))
    const at = '2026-10-10T08:00:00.000Z'
    const lines = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n'
    const codex = lines({ type: 'session_meta', payload: { id: A, cwd, source: 'cli' } },
      { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Keep the native conversation' } },
      { timestamp: at, type: 'event_msg', payload: { type: 'agent_message', message: 'The native conversation is retained.' } },
      { timestamp: at, type: 'event_msg', payload: { type: 'task_complete' } })
    const claude = lines({ type: 'user', sessionId: A, cwd, isSidechain: false, timestamp: at, uuid: 'fixture-user',
      message: { role: 'user', content: 'Keep the native conversation' } },
    { type: 'assistant', timestamp: at, uuid: 'fixture-answer', message: { role: 'assistant',
      content: [{ type: 'text', text: 'The native conversation is retained.' }], stop_reason: 'end_turn' } })
    const fixtures: Array<{ name: string; engine: AgentEngine; file?: string; text?: string; profile?: string; handoff?: boolean }> = [
      { name: 'claude', engine: 'claude', file: path('CLAUDE_CONFIG_DIR', 'projects', 'workspace', `${A}.jsonl`), text: claude, handoff: true },
      { name: 'codex', engine: 'codex', file: path('CODEX_HOME', 'sessions', `rollout-${A}.jsonl`), text: codex, handoff: true },
      { name: 'moved-codex', engine: 'codex', file: join(moved, 'sessions', `rollout-${A}.jsonl`), text: codex, handoff: true },
      { name: 'profile-codex', engine: 'codex', file: join(profile, 'sessions', `rollout-${A}.jsonl`), text: codex, profile, handoff: true },
      { name: 'pi', engine: 'pi', file: path('PI_HOME', 'agent', 'sessions', 'workspace', `2026-10-10T08-00-00-000Z_${A}.jsonl`), text: lines({ type: 'session', version: 3, id: A, cwd }) },
      { name: 'terminal', engine: 'terminal' },
    ]
    vi.resetModules()
    const { inspectNativeHistory, eraseNativeHistory } = await import('./purgeAgentService.js')
    const { prepareAgentHandoff } = await import('./agentHandoff.js')
    const { handoffProviderDeps } = await import('./handoffDiscovery.js')
    const { validTranscriptPath } = await import('./registry.js')
    let change = 0
    for (const fixture of fixtures) {
      if (fixture.file && fixture.text) write(fixture.file, fixture.text)
      const entry = { agentId: `fixture-${fixture.name}`, sessionId: fixture.file ? A : '', engine: fixture.engine,
        cwd, transcriptPath: fixture.file ?? null, registeredAt: AT, boundAt: AT - 60_000,
        codexHome: fixture.profile ?? null, hermesHome: null, processIdentity: null, projectDir: 'workspace',
        runtimes: [{ backend: 'tmux', paneId: '%1' }], tmuxPane: '%1' } as RegisteredSession
      if (fixture.handoff) {
        for (const mode of ['own', ...(fixture.name === 'codex' ? ['fork', 'discovery'] : [])]) {
          const source = mode === 'own' ? entry : { ...entry, agentId: `fixture-${mode}`, sessionId: '', transcriptPath: null,
            ...(mode === 'fork' ? { forkedFrom: { agentId: entry.agentId, name: 'Parent', sessionId: A, transcriptPath: fixture.file } }
              : { processIdentity: { pid: 4242, executable: 'codex', startMarker: '2026-10-10T08:00:00Z' } }) }
          const deps = handoffProviderDeps({
            registry: { resolve: id => id === source.agentId ? source : id === entry.agentId ? entry : undefined,
              byAgent: () => source, bySession: () => undefined },
            stopped: { get: () => null, ids: () => [] }, mirror: { recentAsks: () => [], lastFullText: () => undefined, recent: () => [] },
            databaseHistory: () => undefined, findLiveSession: async () => ({ sessionId: A, transcriptPath: fixture.file }),
            processSession: async () => null, isRecentlyDeleted: () => false, findResumedTranscript: async () => fixture.file!, validTranscriptPath,
          })
          const result = await prepareAgentHandoff(deps, { agentId: source.agentId, targetEngine: 'claude', changeId: (++change).toString(16).padStart(32, '0') })
          check(`${fixture.name}:handoff:${mode}`, { result, files: result.file ? readdirSync(join(cwd, '.harness', 'handoff'))
            .filter(name => name.startsWith(source.agentId + '-')).sort().map(name => ({ name, text: readFileSync(join(cwd, '.harness', 'handoff', name), 'utf8') })) : [] })
        }
      }
      const history = await inspectNativeHistory(entry)
      check(`${fixture.name}:inspect`, { path: history.file?.path, bytes: history.bytes, missing: history.missingFile })
      const erased = await eraseNativeHistory(history)
      check(`${fixture.name}:erase`, { erased, remains: fixture.file ? existsSync(fixture.file) : false, workspaceRemains: existsSync(cwd) })
    }
    const missing = path('CODEX_HOME', 'sessions', `rollout-${B}.jsonl`)
    const absent = await inspectNativeHistory({ engine: 'codex', sessionId: B, transcriptPath: missing } as RegisteredSession)
    check('missing-codex:cleanup', { missing: absent.missingFile, bytes: absent.bytes, erased: await eraseNativeHistory(absent) })
  } finally {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules(); Object.defineProperty(process, 'platform', originalPlatform)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})
