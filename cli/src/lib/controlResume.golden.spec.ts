/** Healthy resume composition recorded from the former code, with no host engine or terminal. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the resume golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: async () => ({ state: 'gone', reason: 'fixture' }) }))
vi.mock('./tmuxAgentDiscovery.js', () => ({ listTmuxPanes: async () => ({ ok: true, panes: [] }) }))
vi.mock('./tmux.js', () => ({ checkSessionRuntime: async () => ({ state: 'alive' }),
  clearPaneRemainOnExit: async () => {}, tmuxPaneState: async () => ({ dead: false }),
  resolvePaneEngineProcess: async () => ({ pid: 7001, executable: '<engine>', startMarker: 'fixture-start' }),
}))
vi.mock('./engineLaunch.js', async original => ({ ...await original<object>(),
  buildEngineLaunchArgv: (engine: string, options: { resumeSessionId?: string }) => [
    '<engine>', engine, ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
  ],
  dropPermissionFlagIfUnsupported: async (_engine: unknown, choice: unknown) => ({ choice, droppedFlag: null }),
  refusePermissionFlagIfUnsupported: async () => null,
}))
vi.mock('./engineBin.js', async original => ({ ...await original<object>(), enginePathOverride: () => '<engine>' }))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/control-resume.golden.json', import.meta.url))
const RECORD = process.env.RECORD_CONTROL_RESUME_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

it.each(['linux', 'darwin'])('keeps healthy native resume composition on %s', async platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-resume-golden-')))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T08:00:00Z') })
    for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      const path = join(root, key); mkdirSync(path, { recursive: true, mode: 0o700 }); vi.stubEnv(key, path)
    }
    vi.stubEnv('CLAUDE_PROJECTS_DIR', join(root, 'CLAUDE_CONFIG_DIR', 'projects'))
    vi.stubEnv('TZ', 'UTC')
    writeFileSync(join(root, 'ADAPTER_DATA_DIR', 'engine-homes.json'), '{}')
    vi.resetModules()
    const { registry } = await import('./registry.js')
    const { StoppedAgentStore } = await import('./stoppedAgents.js')
    const { AgentRestartCoordinator } = await import('./restartAgent.js')
    const { createResumeAgentService } = await import('./resumeAgentService.js')
    let pane = 0
    for (const engine of ['claude', 'codex', 'terminal'] as const) {
      const directory = join(root, engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR', engine === 'codex' ? 'sessions' : 'projects')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const file = join(directory, `${ID}.jsonl`)
      writeFileSync(file, JSON.stringify(engine === 'codex'
        ? { type: 'session_meta', payload: { id: ID, cwd: root, source: 'cli' } }
        : { type: 'user', sessionId: ID, cwd: root, isSidechain: false }) + '\n')
      const original = registry.openPendingAgent({ engine, cwd: root, runtimes: [{ backend: 'tmux', paneId: `%${++pane}` }] })!
      const saved = { ...original, sessionId: engine === 'terminal' ? '' : ID, transcriptPath: engine === 'terminal' ? null : file,
        processIdentity: { pid: 7000, executable: '<engine>', startMarker: 'prior-process' } }
      registry.removeAgent(saved.agentId)
      const stopped = new StoppedAgentStore(join(root, 'saved', engine)); stopped.save(saved)
      const events: unknown[] = []
      const resume = createResumeAgentService({ registry, stoppedAgents: stopped, restartJobs: new AgentRestartCoordinator(),
        stopJobs: new Map(), pinnedControls: new Set(), tmuxBackend: {
          create: async request => { events.push(['create', request.command]); return { state: 'succeeded', dispatch: 'executed',
            runtime: { backend: 'tmux', paneId: `%${++pane}` } } },
          kill: async () => { throw Error('A healthy resume must not kill a pane') },
        }, retainExitedSession: () => { throw Error('No live session exists in this fixture') },
        announceSession: session => { events.push(['announce', session.engine, session.sessionId, session.launch?.state]) },
        relaunchOverrides: async session => { events.push(['launch-prepare', session.engine, session.sessionId]);
          return { ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } } },
        prepareSessionResume: session => { events.push(['history-prepare', session.sessionId]) },
        refreshGridWebSearch: () => { events.push(['grid']) }, clearDeleted: () => {}, attachDsh: () => {},
        attachSession: async session => { events.push(['attach', session.sessionId]); return true },
      })
      const result = await resume(saved.agentId)
      expect(result.ok).toBe(true)
      if (!result.ok) throw Error('Resume did not produce an observation')
      const key = `${platform}:${engine}`
      captured[key] = { events, result: { ok: result.ok, resumed: result.resumed, engine: result.session.engine,
        sessionId: result.session.sessionId, source: result.session.source, launch: result.session.launch },
      reserved: stopped.resumeReservedAt(saved.agentId) !== null }
      if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
      registry.removeAgent(saved.agentId)
    }
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
