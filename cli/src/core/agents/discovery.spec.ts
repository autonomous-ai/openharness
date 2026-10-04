import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { bypassPermissionActive, permissionModeFromArgv, tmuxPaneState } from '../../lib/tmux.js'
import { createDiscoveryHandlers, type DiscoveryDeps } from './discovery.js'

vi.mock('../../lib/tmux.js', async (real) => ({ ...await real<object>(), tmuxPaneState: vi.fn(async () => null) }))

const row = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', active: true, ...over }) as RegisteredSession
const seen = (over: Partial<DiscoveredTerminalAgent> = {}): DiscoveredTerminalAgent => ({
  engine: 'claude',
  cwd: '/work',
  runtimes: [{ backend: 'tmux', paneId: '%0' }],
  primaryRuntimeKey: 'tmux:%0',
  processIdentity: { pid: 42, startMarker: 'now' },
  args: 'claude',
  ...over,
}) as unknown as DiscoveredTerminalAgent

function setup(over: Partial<DiscoveryDeps> = {}) {
  const rows = new Map<string, RegisteredSession>()
  let restoreDegraded = false
  const deps: DiscoveryDeps = {
    registry: {
      byRuntimeEngine: vi.fn(() => undefined),
      openProcessAgent: vi.fn(() => null),
      adoptEngine: vi.fn(() => row()),
      updateRuntimes: vi.fn(),
      updateProcessIdentity: vi.fn(),
      setBypassPermission: vi.fn(),
      setPermissionMode: vi.fn(),
      setCodexHome: vi.fn(),
      setHermesHome: vi.fn(),
      setDsh: vi.fn(),
      byAgent: vi.fn((agentId: string) => rows.get(agentId)),
      setLaunch: vi.fn(),
      setActive: vi.fn(),
      terminalAvailable: vi.fn(() => false),
      setTerminalAvailable: vi.fn(),
    } as unknown as DiscoveryDeps['registry'],
    attachDsh: vi.fn(),
    forgetSession: vi.fn(),
    announceSession: vi.fn(),
    bindObservedAgent: vi.fn(async () => {}),
    syncRecapPool: vi.fn(),
    attachSession: vi.fn(async () => true),
    invalidateTerminalControl: vi.fn(),
    teams: { forget: vi.fn() },
    input: { forget: vi.fn() },
    deviceInput: { forget: vi.fn() },
    questionWatcher: { stop: vi.fn() },
    stopHeartbeat: vi.fn(),
    retainExitedSession: vi.fn(),
    stoppedAgents: { finishResume: vi.fn() },
    restoreDegraded: () => restoreDegraded,
    ...over,
  }
  return { deps, rows, handlers: createDiscoveryHandlers(deps), degrade: () => { restoreDegraded = true } }
}

const settle = () => new Promise((done) => setTimeout(done, 0))
const grid = (name: string) => ({ grid: name, baseUrl: `http://${name}.local`, model: 'm' })

describe('discovery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(tmuxPaneState).mockReset().mockResolvedValue(null)
  })
  afterEach(() => vi.restoreAllMocks())

  describe('a process no row owns', () => {
    it('opens an agent for it, announces it and binds its session', async () => {
      const run = setup()
      const opened = row({ agentId: 'new' })
      vi.mocked(run.deps.registry.openProcessAgent).mockReturnValue({ entry: opened, isNew: true, evicted: null } as never)
      await run.handlers.onDiscovered(seen())
      expect(run.deps.registry.openProcessAgent).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude', primaryRuntimeKey: 'tmux:%0' }))
      expect(run.deps.announceSession).toHaveBeenCalledWith(opened)
      expect(run.deps.bindObservedAgent).toHaveBeenCalled()
      expect(run.deps.attachDsh).not.toHaveBeenCalled()
    })

    it('attaches its DSH, forgets the agent it evicted from the pane, and re-announces a launch still starting', async () => {
      const run = setup()
      const opened = row({ agentId: 'a2', dsh: 'blender' } as Partial<RegisteredSession>)
      vi.mocked(run.deps.registry.byRuntimeEngine).mockReturnValue(row({ launch: { state: 'starting' } } as Partial<RegisteredSession>))
      vi.mocked(run.deps.registry.openProcessAgent).mockReturnValue({ entry: opened, isNew: false, evicted: row({ agentId: 'old', sessionId: '' }) } as never)
      await run.handlers.onDiscovered(seen())
      expect(run.deps.attachDsh).toHaveBeenCalledWith(opened)
      expect(run.deps.forgetSession).toHaveBeenCalledWith('old', { force: true, agentId: 'old' })
      expect(run.deps.announceSession).toHaveBeenCalledWith(opened)
      vi.mocked(run.deps.registry.openProcessAgent).mockReturnValue({ entry: row(), isNew: false, evicted: row({ agentId: 'old', sessionId: 'old-s' }) } as never)
      vi.mocked(run.deps.registry.byRuntimeEngine).mockReturnValue(row({ launch: { state: 'ready' } } as Partial<RegisteredSession>))
      await run.handlers.onDiscovered(seen())
      expect(run.deps.forgetSession).toHaveBeenLastCalledWith('old-s', { force: true, agentId: 'old' })
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    it('does nothing when the registry opens nothing', async () => {
      const run = setup()
      await run.handlers.onDiscovered(seen())
      expect(run.deps.bindObservedAgent).not.toHaveBeenCalled()
    })
  })

  describe('a row\'s own process', () => {
    it('updates the row from the live process, filling only what it does not know', async () => {
      const run = setup()
      const observed = seen({ args: 'claude --dangerously-skip-permissions', codexHome: '/codex', hermesHome: '/hermes', dsh: 'blender' } as Partial<DiscoveredTerminalAgent>)
      run.rows.set('a1', row({ dsh: 'blender' } as Partial<RegisteredSession>))
      await run.handlers.onObserved(observed, row())
      expect(run.deps.registry.updateRuntimes).toHaveBeenCalledWith('a1', observed.runtimes, 'tmux:%0')
      expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('a1', observed.processIdentity, undefined, undefined)
      expect(run.deps.registry.setBypassPermission).toHaveBeenCalledWith('a1', bypassPermissionActive('claude', observed.args))
      const mode = permissionModeFromArgv('claude', observed.args)
      expect(vi.mocked(run.deps.registry.setPermissionMode).mock.calls).toEqual(mode ? [['a1', mode]] : [])
      expect(run.deps.registry.setCodexHome).toHaveBeenCalledWith('a1', '/codex')
      expect(run.deps.registry.setHermesHome).toHaveBeenCalledWith('a1', '/hermes')
      expect(run.deps.registry.setDsh).toHaveBeenCalledWith('a1', 'blender')
      expect(run.deps.attachDsh).toHaveBeenCalled()
      expect(run.deps.bindObservedAgent).toHaveBeenCalledWith(observed)
      // A row that knows them already keeps its own.
      const known = setup()
      await known.handlers.onObserved(observed, row({ permissionMode: 'plan', codexHome: '/mine', hermesHome: '/mine', dsh: 'mine' } as Partial<RegisteredSession>))
      for (const setter of ['setPermissionMode', 'setCodexHome', 'setHermesHome', 'setDsh'] as const) {
        expect(known.deps.registry[setter], setter).not.toHaveBeenCalled()
      }
    })

    it('learns the permission mode from the command line when the row has none', async () => {
      const run = setup()
      await run.handlers.onObserved(seen({ engine: 'codex', args: 'codex --dangerously-bypass-approvals-and-sandbox' } as Partial<DiscoveredTerminalAgent>), row({ engine: 'codex' } as Partial<RegisteredSession>))
      const mode = permissionModeFromArgv('codex', 'codex --dangerously-bypass-approvals-and-sandbox')
      expect(vi.mocked(run.deps.registry.setPermissionMode).mock.calls).toEqual(mode ? [['a1', mode]] : [])
      expect(mode, 'this fixture must name a mode').not.toBeNull()
    })

    it('adopts the engine someone typed into a terminal, and announces it', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup()
      const adopted = row({ engine: 'claude', sessionId: '' })
      run.rows.set('a1', adopted)
      await run.handlers.onObserved(seen(), row({ engine: 'terminal' } as Partial<RegisteredSession>))
      expect(run.deps.registry.adoptEngine).toHaveBeenCalledWith('a1', 'claude', expect.anything())
      expect(run.deps.syncRecapPool).toHaveBeenCalled()
      expect(run.deps.announceSession).toHaveBeenCalledWith(adopted)
      expect(String(log.mock.calls[0][0])).toContain('terminal → claude')
    })

    it('wakes a dormant row and attaches it in the background, or puts it back to sleep if its pane is gone', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup()
      const awake = row()
      run.rows.set('a1', awake)
      await run.handlers.onObserved(seen(), row({ active: false }))
      await settle()
      expect(run.deps.attachSession).toHaveBeenCalledWith(awake)
      expect(run.deps.announceSession).toHaveBeenCalledWith(awake)
      vi.mocked(run.deps.attachSession).mockResolvedValueOnce(false)
      await run.handlers.onObserved(seen(), row({ active: false }))
      await settle()
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', false)
      vi.mocked(run.deps.attachSession).mockRejectedValueOnce(new Error('store locked')).mockRejectedValueOnce('worse')
      await run.handlers.onObserved(seen(), row({ active: false }))
      await run.handlers.onObserved(seen(), row({ active: false }))
      await settle()
      expect(error.mock.calls.map((call) => call[1])).toEqual(['store locked', 'worse'])
      // Gone from the registry by then: nothing to wake.
      run.rows.clear()
      await run.handlers.onObserved(seen(), row({ active: false }))
      expect(run.deps.attachSession).toHaveBeenCalledTimes(4)
    })

    it('marks a launch ready once its process runs, and wakes it', async () => {
      const run = setup()
      run.rows.set('a1', row())
      await run.handlers.onObserved(seen(), row({ launch: { state: 'starting' } } as Partial<RegisteredSession>))
      expect(run.deps.registry.setLaunch).toHaveBeenCalledWith('a1', { state: 'ready' })
      expect(run.deps.attachSession).toHaveBeenCalled()
      await run.handlers.onObserved(seen(), row({ launch: { state: 'ready' } } as Partial<RegisteredSession>))
      expect(run.deps.registry.setLaunch).toHaveBeenCalledTimes(1)
    })

    it('announces an awake agent whose grid moved, and nothing when it did not or could not be read', async () => {
      const run = setup()
      run.rows.set('a1', row())
      await run.handlers.onObserved(seen({ grid: grid('g1') } as Partial<DiscoveredTerminalAgent>), row({ grid: grid('g1') } as Partial<RegisteredSession>))
      await run.handlers.onObserved(seen(), row())
      expect(run.deps.announceSession).not.toHaveBeenCalled()
      await run.handlers.onObserved(seen({ grid: grid('g2') } as Partial<DiscoveredTerminalAgent>), row())
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      run.rows.clear()
      await run.handlers.onObserved(seen({ grid: grid('g3') } as Partial<DiscoveredTerminalAgent>), row())
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })
  })

  describe('a row whose engine exited', () => {
    it('keeps its conversation, letting go of input, questions and the heartbeat', async () => {
      const run = setup()
      const exited = row({ resumeOnly: true } as Partial<RegisteredSession>)
      await run.handlers.onDormant(exited, 'engine exited')
      expect(run.deps.invalidateTerminalControl).toHaveBeenCalledWith('a1')
      expect(run.deps.teams.forget).toHaveBeenCalledWith('a1')
      expect(run.deps.input.forget).toHaveBeenCalledWith('a1')
      expect(run.deps.deviceInput.forget).toHaveBeenCalledWith('a1')
      expect(run.deps.questionWatcher.stop).toHaveBeenCalledWith('s1')
      expect(run.deps.stopHeartbeat).toHaveBeenCalledWith('s1')
      expect(run.deps.retainExitedSession).toHaveBeenCalledWith(exited, true)
      expect(run.deps.stoppedAgents.finishResume).toHaveBeenCalledWith('a1')
    })

    it('keeps the conversation of an agent that was not a resume, with nothing to finish', async () => {
      const run = setup()
      await run.handlers.onDormant(row(), 'engine exited')
      expect(run.deps.retainExitedSession).toHaveBeenCalledWith(row(), true)
      expect(run.deps.stoppedAgents.finishResume).not.toHaveBeenCalled()
    })

    it('leaves a dormant row alone, and puts a launch that is still starting to sleep instead', async () => {
      const run = setup()
      await run.handlers.onDormant(row({ active: false }), 'x')
      expect(run.deps.invalidateTerminalControl).not.toHaveBeenCalled()
      const starting = row({ sessionId: '', launch: { state: 'starting' } } as Partial<RegisteredSession>)
      await run.handlers.onDormant(starting, 'no process yet')
      expect(run.deps.questionWatcher.stop).not.toHaveBeenCalled()
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', false)
      expect(run.deps.announceSession).toHaveBeenCalledWith(starting)
      expect(run.deps.retainExitedSession).not.toHaveBeenCalled()
    })

    it('holds a failed resume while its pane may still be about to launch the engine', async () => {
      const run = setup()
      const failed = row({ resumeOnly: true, tmuxPane: '%0', launch: { state: 'failed' } } as Partial<RegisteredSession>)
      await run.handlers.onDormant(failed, 'x') // no pane state at all
      vi.mocked(tmuxPaneState).mockResolvedValueOnce({ dead: false, engineExit: null } as never)
      await run.handlers.onDormant(failed, 'x') // a live shell, no engine exit
      expect(run.deps.retainExitedSession).not.toHaveBeenCalled()
      vi.mocked(tmuxPaneState).mockResolvedValueOnce({ dead: true, engineExit: null } as never)
      await run.handlers.onDormant(failed, 'pane died')
      vi.mocked(tmuxPaneState).mockResolvedValueOnce({ dead: false, engineExit: 1 } as never)
      await run.handlers.onDormant(failed, 'engine exited 1')
      expect(run.deps.retainExitedSession).toHaveBeenCalledTimes(2)
    })
  })

  it('removes a row whose pane is gone, unless restore never ran this boot', () => {
    const run = setup()
    run.handlers.onRemoved(row(), 'pane gone')
    expect(run.deps.forgetSession).toHaveBeenCalledWith('a1', { force: true })
    run.degrade()
    run.handlers.onRemoved(row(), 'pane gone')
    expect(run.deps.forgetSession).toHaveBeenCalledTimes(1)
    expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', false)
    expect(run.deps.announceSession).toHaveBeenCalled()
  })

  it('records whether a row\'s terminal is available, announcing it when it becomes so', () => {
    const run = setup()
    run.handlers.onTerminalAvailability(row(), true)
    expect(run.deps.registry.setTerminalAvailable).toHaveBeenCalledWith('a1', true)
    expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    vi.mocked(run.deps.registry.terminalAvailable).mockReturnValue(true)
    run.handlers.onTerminalAvailability(row(), true)
    run.handlers.onTerminalAvailability(row(), false)
    expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
  })
})
