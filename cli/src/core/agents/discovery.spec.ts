import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import type { TerminalBackend } from '../../lib/terminalBackend.js'
import { bypassPermissionActive, permissionModeFromArgv } from '../../lib/processTable.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDiscoveryHandlers, type DiscoveryDeps } from './discovery.js'

// The pane's backend, asked what became of an unconfirmed start's pane.
const paneState = vi.fn<TerminalBackend['paneState']>(async () => 'gone')
const paneBackend = { paneState } as unknown as TerminalBackend

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
  let restoreDegraded: (agentId: string) => boolean = () => false
  const deps: DiscoveryDeps = {
    registry: {
      byRuntimeEngine: vi.fn(() => undefined),
      openProcessAgent: vi.fn(() => null),
      adoptEngine: vi.fn(() => row()),
      reinstateArchived: vi.fn(() => null),
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
    attachBrowser: vi.fn(),
    moveBrowser: vi.fn(),
    forgetSession: vi.fn(),
    announceSession: vi.fn(),
    bindObservedAgent: vi.fn(async () => {}),
    syncRecapPool: vi.fn(),
    attachSession: vi.fn(async () => true),
    invalidateTerminalControl: vi.fn(),
    input: { forget: vi.fn() },
    deviceInput: { forget: vi.fn() },
    questionWatcher: { stop: vi.fn() },
    stopHeartbeat: vi.fn(),
    retainExitedSession: vi.fn(),
    stoppedAgents: { finishResume: vi.fn(), get: vi.fn(() => null), list: vi.fn(() => []), remove: vi.fn(), resumeReservedAt: vi.fn(() => null) },
    send: vi.fn(),
    restoreDegraded: (agentId) => restoreDegraded(agentId),
    terminals: { backendFor: vi.fn(() => paneBackend) },
    ...over,
  }
  return { deps, rows, handlers: createDiscoveryHandlers(deps), degrade: (only?: string) => { restoreDegraded = (agentId) => only === undefined || agentId === only } }
}

const settle = () => new Promise((done) => setTimeout(done, 0))
const grid = (name: string) => ({ grid: name, baseUrl: `http://${name}.local`, model: 'm' })

describe('discovery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    paneState.mockReset().mockResolvedValue('gone')
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

    // Decision 19: the browser moves with its pane. Told after the forget, so the evicted browser's stop is ahead of the
    // move in the agent browser's queue.
    it('a process that takes a bound agent\'s pane takes its browser: the move is told after the evicted agent is forgotten, with the flag the evicted row had', async () => {
      const run = setup()
      const opened = row({ agentId: 'new', sessionId: '' })
      vi.mocked(run.deps.registry.openProcessAgent).mockReturnValue({ entry: opened, isNew: true,
        evicted: { agentId: 'old', sessionId: 'old-s', browser: true } } as never)
      await run.handlers.onDiscovered(seen())
      expect(run.deps.forgetSession).toHaveBeenCalledWith('old-s', { force: true, agentId: 'old' })
      expect(vi.mocked(run.deps.moveBrowser).mock.calls).toEqual([['old', opened, true]])
      expect(vi.mocked(run.deps.forgetSession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(run.deps.moveBrowser).mock.invocationCallOrder[0]!)
      expect(run.deps.attachBrowser).not.toHaveBeenCalled()
      // An evicted agent whose Browser was off still gives its settings and its profile to the pane.
      vi.mocked(run.deps.registry.openProcessAgent).mockReturnValue({ entry: opened, isNew: true,
        evicted: { agentId: 'off', sessionId: '' } } as never)
      await run.handlers.onDiscovered(seen())
      expect(vi.mocked(run.deps.moveBrowser).mock.calls.at(-1)).toEqual(['off', opened, false])
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

    // A Swarm agent's mode is the one on its row (Auto-approve since 2026-11-12), never read back. An agent Harness once started in
    // full mode still runs with that flag until it relaunches; read back, the relaunch would skip permissions again.
    it('never reads a Swarm agent\'s permissions off its process', async () => {
      const run = setup()
      const swarm = row({ swarmSkill: { role: 'coordinator', key: 'swarm-lead' } } as Partial<RegisteredSession>)
      await run.handlers.onObserved(seen({ args: 'claude --dangerously-skip-permissions' } as Partial<DiscoveredTerminalAgent>), swarm)
      expect(run.deps.registry.setPermissionMode).not.toHaveBeenCalled()
      expect(run.deps.registry.setBypassPermission).not.toHaveBeenCalled()
    })

    it('reads an engine launched in full mode back as full (task #2832)', () => {
      expect(permissionModeFromArgv('codex', 'codex --dangerously-bypass-approvals-and-sandbox -c tui.fullscreen_transcript=false')).toBe('full')
      expect(permissionModeFromArgv('claude', 'claude --dangerously-skip-permissions')).toBe('full')
      expect(permissionModeFromArgv('codex', 'codex --sandbox read-only')).toBe('readOnly')
    })

    it('takes a pane for OpenClaw only once it shows the TUI: `openclaw onboard` renames itself `openclaw` too', async () => {
      // What `openclaw onboard` draws (OpenClaw's clack wizard, 2026.11.2): no title, no footer. Not recorded: written
      // from its intro and first prompt.
      const onboard = '│\n◇\n\nOpenClaw 2026.11.2 (b556fdf) — tagline\n\n┌  OpenClaw setup\n│\n◆  I understand this is personal-by-default. Continue?\n│  ● Yes / ○ No\n└\n'
      const tui = readFileSync(join(import.meta.dirname, '../../engines/openclaw/__fixtures__/screen-plain.txt'), 'utf8')
      let screen = onboard
      const capture = vi.fn(async () => ({ state: 'succeeded' as const, value: screen }))
      const run = setup({ terminals: { backendFor: vi.fn(() => ({ paneState, capture }) as unknown as TerminalBackend) } })
      run.rows.set('a1', row({ engine: 'openclaw', sessionId: '' }))
      const openclaw = seen({ engine: 'openclaw', args: 'openclaw' })
      vi.mocked(run.deps.registry.openProcessAgent).mockReturnValue({ entry: row({ agentId: 'new', engine: 'openclaw' }), isNew: true, evicted: null } as never)
      await run.handlers.onObserved(openclaw, row({ engine: 'terminal' } as Partial<RegisteredSession>))
      await run.handlers.onDiscovered(openclaw)
      expect(capture).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%0' })
      expect(run.deps.registry.adoptEngine).not.toHaveBeenCalled()
      expect(run.deps.registry.openProcessAgent).not.toHaveBeenCalled()
      expect(run.deps.bindObservedAgent).not.toHaveBeenCalled()
      // The TUI, drawn: taken.
      screen = tui
      await run.handlers.onObserved(openclaw, row({ engine: 'terminal' } as Partial<RegisteredSession>))
      expect(run.deps.registry.adoptEngine).toHaveBeenCalledWith('a1', 'openclaw', expect.anything())
      await run.handlers.onDiscovered(openclaw)
      expect(run.deps.registry.openProcessAgent).toHaveBeenCalled()
      // A row OpenClaw already has is never asked again: an overlay over its footer does not make it look gone.
      capture.mockClear()
      screen = onboard
      await run.handlers.onObserved(openclaw, row({ engine: 'openclaw' }))
      expect(capture).not.toHaveBeenCalled()
      expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalled()
    })

    it('never takes an `openclaw` process for OpenClaw while its screen cannot be read', async () => {
      const capture = vi.fn(async () => { throw new Error('pane host gone') })
      const run = setup({ terminals: { backendFor: vi.fn(() => ({ paneState, capture }) as unknown as TerminalBackend) } })
      // Its pane's backend failed the read, or it shows in no pane at all.
      for (const openclaw of [seen({ engine: 'openclaw', args: 'openclaw' }), seen({ engine: 'openclaw', args: 'openclaw', runtimes: [] })]) {
        await run.handlers.onDiscovered(openclaw)
      }
      expect(capture).toHaveBeenCalledOnce()
      expect(run.deps.registry.openProcessAgent).not.toHaveBeenCalled()
      expect(run.deps.bindObservedAgent).not.toHaveBeenCalled()
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

    // Decision 14: whatever brought an agent back to running, the look at it gives a browser left on back to it.
    it('tells the browser of a running agent whose Browser is on, on every scan, and of no agent whose Browser is off', async () => {
      const run = setup()
      const on = row({ browser: true })
      run.rows.set('a1', on)
      await run.handlers.onObserved(seen(), on)
      await run.handlers.onObserved(seen(), on)
      expect(vi.mocked(run.deps.attachBrowser).mock.calls).toEqual([[on], [on]])
      // Off by the registry's row now: a look that began before its person's Stop attaches nothing.
      const off = row()
      run.rows.set('a1', off)
      await run.handlers.onObserved(seen(), on)
      await run.handlers.onObserved(seen(), off)
      expect(run.deps.attachBrowser).toHaveBeenCalledTimes(2)
    })

    it('a terminal that kept its id and its flag is told once an engine runs in it again', async () => {
      const run = setup()
      const agent = row({ sessionId: '', browser: true })
      run.rows.set('a1', agent)
      vi.mocked(run.deps.registry.adoptEngine).mockReturnValue(agent)
      await run.handlers.onObserved(seen(), row({ engine: 'terminal', sessionId: '', browser: true } as Partial<RegisteredSession>))
      expect(run.deps.registry.adoptEngine).toHaveBeenCalledWith('a1', 'claude', expect.anything())
      expect(vi.mocked(run.deps.attachBrowser).mock.calls).toEqual([[agent]])
    })

    // Decision 19: the browser moves with its pane. The shell names the agent that ended there (registry.ts
    // `previousAgentId`), which the adopt takes off the row: read before it.
    describe('the shell an exit left', () => {
      const shellOf = (over: Partial<RegisteredSession> = {}) =>
        row({ agentId: 'shell', engine: 'terminal', sessionId: '', previousAgentId: 'ended', ...over } as Partial<RegisteredSession>)
      const typed = (saved: RegisteredSession | null, over: Partial<DiscoveryDeps['stoppedAgents']> = {}) => {
        const run = setup()
        const adopted = row({ agentId: 'shell', sessionId: '' })
        const shell = shellOf()
        run.rows.set('shell', adopted)
        // As the registry does to its live row.
        vi.mocked(run.deps.registry.adoptEngine).mockImplementation(() => { delete shell.previousAgentId; return adopted })
        vi.mocked(run.deps.stoppedAgents.get).mockImplementation((agentId: string) => (agentId === 'ended' ? saved : null))
        Object.assign(run.deps.stoppedAgents, over)
        return { ...run, adopted, shell }
      }

      it.each([
        ['on', 'claude', true],
        ['off', 'codex', false],
      ] as const)('an engine typed into the shell an exit left takes the browser of the agent that ended there: the browser\'s move is told the previous agent, the adopted row, and the flag its record kept (%s, %s)', async (_flag, engine, on) => {
        const run = typed(row({ agentId: 'ended', ...(on ? { browser: true as const } : {}) }))
        // Any engine typed there takes it, not only the one that left.
        await run.handlers.onObserved(seen({ engine }), run.shell)
        expect(run.deps.registry.adoptEngine).toHaveBeenCalledWith('shell', engine, expect.anything())
        expect(run.deps.stoppedAgents.get).toHaveBeenCalledWith('ended')
        expect(vi.mocked(run.deps.moveBrowser).mock.calls).toEqual([['ended', run.adopted, on]])
        // Nothing is attached here: the flag moves when the agent browser asks for it.
        expect(run.deps.attachBrowser).not.toHaveBeenCalled()
      })

      it('nothing moves for a shell that names nobody, for a previous agent with no saved record, while its resume is under way, or when the saved agents cannot be read', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const nobody = typed(row({ agentId: 'ended', browser: true }))
        await nobody.handlers.onObserved(seen(), shellOf({ previousAgentId: undefined }))
        expect(nobody.deps.registry.adoptEngine).toHaveBeenCalled()
        expect(nobody.deps.stoppedAgents.get).not.toHaveBeenCalled()
        // Purged since.
        const purged = typed(null)
        await purged.handlers.onObserved(seen(), purged.shell)
        expect(purged.deps.stoppedAgents.get).toHaveBeenCalledWith('ended')
        // A resume of it under way: its browser comes back with it (decision 14).
        const resuming = typed(row({ agentId: 'ended', browser: true }), { resumeReservedAt: vi.fn((agentId: string) => (agentId === 'ended' ? 1 : null)) })
        await resuming.handlers.onObserved(seen(), resuming.shell)
        expect(resuming.deps.registry.adoptEngine).toHaveBeenCalled()
        // Unreadable, whatever was thrown: said once, and the engine is the shell's agent all the same.
        for (const thrown of [new Error('EACCES'), 'EIO']) {
          const unreadable = typed(null, { get: vi.fn(() => { throw thrown }) })
          await unreadable.handlers.onObserved(seen(), unreadable.shell)
          expect(unreadable.deps.registry.adoptEngine).toHaveBeenCalled()
          expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/saved harnesses unreadable; .* takes no browser: (EACCES|EIO)$/))
        }
        expect(warn).toHaveBeenCalledTimes(2)
        for (const run of [nobody, purged, resuming]) expect(run.deps.moveBrowser).not.toHaveBeenCalled()
      })
    })

    it('an agent back from the archive, and a row re-observed in place, move nothing', async () => {
      // Back from the archive under its own id, in the shell that named it.
      const PANE = { backend: 'tmux', paneId: '%0' } as const
      const saved = row({ agentId: 'ended', sessionId: '', active: false, browser: true, runtimes: [PANE],
        processIdentity: { pid: 42, startMarker: 'now' } } as Partial<RegisteredSession>)
      const back = setup()
      vi.mocked(back.deps.stoppedAgents.list).mockReturnValue([saved])
      vi.mocked(back.deps.stoppedAgents.get).mockReturnValue(saved)
      vi.mocked(back.deps.registry.reinstateArchived).mockReturnValue({ ...saved, active: true } as RegisteredSession)
      await back.handlers.onObserved(seen(), row({ agentId: 'shell', engine: 'terminal', sessionId: '', runtimes: [PANE],
        previousAgentId: 'ended' } as Partial<RegisteredSession>))
      expect(back.deps.registry.reinstateArchived).toHaveBeenCalled()
      expect(back.deps.moveBrowser).not.toHaveBeenCalled()
      // A running agent seen again, and a terminal that kept its id.
      const inPlace = setup()
      await inPlace.handlers.onObserved(seen(), row({ browser: true }))
      await inPlace.handlers.onObserved(seen(), row({ engine: 'terminal', sessionId: '' } as Partial<RegisteredSession>))
      // A row a scan opens again in its own pane, evicting another from it, is not a new agent taking that pane.
      vi.mocked(inPlace.deps.registry.openProcessAgent).mockReturnValue({ entry: row(), isNew: false,
        evicted: { agentId: 'old', sessionId: 'old-s', browser: true } } as never)
      await inPlace.handlers.onDiscovered(seen())
      expect(inPlace.deps.forgetSession).toHaveBeenCalled()
      expect(inPlace.deps.moveBrowser).not.toHaveBeenCalled()
    })

    // CLI 0.5.97 could not see Hermes in its panes on Windows: its restore archived "Hermes harness 11-9 20:28" as exited,
    // gave pane %2007 to a new terminal row, and the harness answered Enter with AGENT_BUSY while its own Hermes (pid
    // 25492) ran on (DESKTOP-0TFH0OJ, 2026-11-10). Seen again, that same process brings the harness back.
    describe('an archived harness whose own engine never stopped', () => {
      const PANE = { backend: 'ptyhost', instance: 'p2-0.5.80', paneId: '%2007' } as const
      const HERMES = { pid: 25492, executable: 'python.exe', startMarker: 'w:134387585146660684' }
      const archived = (over: Partial<RegisteredSession> = {}) => row({ agentId: 'bcdaa2eb', engine: 'hermes', sessionId: '', active: false,
        defaultName: 'Hermes harness 11-9 20:28', runtimes: [PANE], processIdentity: HERMES, ...over } as Partial<RegisteredSession>)
      const shell = row({ agentId: '0e375534', engine: 'terminal', sessionId: '', runtimes: [PANE] } as Partial<RegisteredSession>)
      const hermesSeen = (over: Partial<DiscoveredTerminalAgent> = {}) => seen({ engine: 'hermes', runtimes: [PANE],
        primaryRuntimeKey: 'ptyhost:p2-0.5.80:%2007', processIdentity: HERMES, args: 'python.exe -I hermes-boot.py', ...over })

      it('comes back under its own id on its pane, the terminal tile moving to it, nothing restarted', async () => {
        const run = setup()
        const saved = archived()
        const live = { ...saved, active: true, processIdentity: HERMES }
        vi.mocked(run.deps.stoppedAgents.list).mockReturnValue([archived({ agentId: 'other', runtimes: [{ ...PANE, paneId: '%2009' }] }), saved])
        vi.mocked(run.deps.registry.reinstateArchived).mockReturnValue(live as RegisteredSession)
        run.rows.set('bcdaa2eb', live as RegisteredSession)
        await run.handlers.onObserved(hermesSeen(), shell)
        expect(run.deps.registry.reinstateArchived).toHaveBeenCalledWith('0e375534', saved, HERMES)
        expect(run.deps.stoppedAgents.remove).toHaveBeenCalledWith('bcdaa2eb')
        expect(run.deps.send).toHaveBeenCalledWith({ type: 'agent_deleted', payload: { agentId: '0e375534', successor: 'bcdaa2eb' } })
        expect(run.deps.announceSession).toHaveBeenCalledWith(live)
        expect(run.deps.registry.adoptEngine).not.toHaveBeenCalled()
        expect(run.deps.registry.updateProcessIdentity).toHaveBeenCalledWith('bcdaa2eb', HERMES, undefined, undefined)
      })

      // Review Focus 9: archived as exited, its browser stopped by that end, then seen again with nothing restarted.
      it('comes back with its browser: the flag its archive kept is handed to the browser\'s attach, with the row that came back', async () => {
        const run = setup()
        const saved = archived({ browser: true })
        const live = { ...saved, active: true } as RegisteredSession
        vi.mocked(run.deps.stoppedAgents.list).mockReturnValue([saved])
        vi.mocked(run.deps.registry.reinstateArchived).mockReturnValue(live)
        run.rows.set('bcdaa2eb', live)
        await run.handlers.onObserved(hermesSeen(), shell)
        expect(vi.mocked(run.deps.attachBrowser).mock.calls).toEqual([[live]])
      })

      it.each([
        ['another process typed into that shell', hermesSeen({ processIdentity: { ...HERMES, startMarker: 'w:1' } }), archived()],
        ['the same process number in another pane', hermesSeen(), archived({ runtimes: [{ ...PANE, paneId: '%2008' }] })],
        ['another engine', hermesSeen({ engine: 'codex' }), archived()],
      ])('is not what %s is: the terminal adopts its engine as before', async (_name, observed, saved) => {
        const run = setup()
        vi.mocked(run.deps.stoppedAgents.list).mockReturnValue([saved])
        await run.handlers.onObserved(observed, shell)
        expect(run.deps.registry.reinstateArchived).not.toHaveBeenCalled()
        expect(run.deps.registry.adoptEngine).toHaveBeenCalledWith('0e375534', observed.engine, observed.processIdentity)
      })

      it('waits for a resume already under way, and adopts when the archive cannot be read or the registry refuses', async () => {
        const reserved = setup()
        vi.mocked(reserved.deps.stoppedAgents.list).mockReturnValue([archived()])
        vi.mocked(reserved.deps.stoppedAgents.resumeReservedAt).mockReturnValue(1)
        await reserved.handlers.onObserved(hermesSeen(), shell)
        expect(reserved.deps.registry.reinstateArchived).not.toHaveBeenCalled()

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const unreadable = setup()
        vi.mocked(unreadable.deps.stoppedAgents.list).mockImplementation(() => { throw new Error('EACCES') })
        await unreadable.handlers.onObserved(hermesSeen(), shell)
        expect(unreadable.deps.registry.adoptEngine).toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('saved harnesses unreadable'))

        const refused = setup()
        vi.mocked(refused.deps.stoppedAgents.list).mockReturnValue([archived()])
        await refused.handlers.onObserved(hermesSeen(), shell)
        expect(refused.deps.stoppedAgents.remove).not.toHaveBeenCalled()
        expect(refused.deps.registry.adoptEngine).toHaveBeenCalled()
      })

      it('also from a terminal row that adopted that engine already, while no conversation is bound to it; looked up once', async () => {
        const run = setup()
        const saved = archived()
        vi.mocked(run.deps.stoppedAgents.list).mockReturnValue([saved])
        const adopted = row({ agentId: '0e375534', engine: 'hermes', terminalHost: true, sessionId: '', runtimes: [PANE],
          processIdentity: HERMES } as Partial<RegisteredSession>)
        vi.mocked(run.deps.registry.reinstateArchived).mockReturnValue({ ...saved, active: true } as RegisteredSession)
        await run.handlers.onObserved(hermesSeen(), adopted)
        expect(run.deps.registry.reinstateArchived).toHaveBeenCalledWith('0e375534', saved, HERMES)

        const bound = setup()
        vi.mocked(bound.deps.stoppedAgents.list).mockReturnValue([saved])
        await bound.handlers.onObserved(hermesSeen(), { ...adopted, sessionId: 'local-61' })
        expect(bound.deps.stoppedAgents.list).not.toHaveBeenCalled()

        const twice = setup()
        await twice.handlers.onObserved(hermesSeen(), adopted)
        await twice.handlers.onObserved(hermesSeen(), adopted)
        expect(twice.deps.stoppedAgents.list).toHaveBeenCalledTimes(1)
      })

      it('forgets what it looked at once it has looked at 4096, and looks again', async () => {
        const run = setup()
        for (let i = 0; i < 4096; i++) {
          await run.handlers.onObserved(hermesSeen(), { ...shell, agentId: `t${i}` } as RegisteredSession)
        }
        expect(run.deps.stoppedAgents.list).toHaveBeenCalledTimes(4096)
        await run.handlers.onObserved(hermesSeen(), { ...shell, agentId: 't0' } as RegisteredSession)
        expect(run.deps.stoppedAgents.list).toHaveBeenCalledTimes(4096)
        // The 4097th row starts over; the first is looked at again.
        await run.handlers.onObserved(hermesSeen(), { ...shell, agentId: 't4096' } as RegisteredSession)
        await run.handlers.onObserved(hermesSeen(), { ...shell, agentId: 't0' } as RegisteredSession)
        expect(run.deps.stoppedAgents.list).toHaveBeenCalledTimes(4098)
      })

      it('names what it could not read or remove, whatever was thrown', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const unreadable = setup()
        vi.mocked(unreadable.deps.stoppedAgents.list).mockImplementation(() => { throw 'EACCES' })
        await unreadable.handlers.onObserved(hermesSeen(), shell)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('adopts its engine as new: EACCES'))
        const busy = setup()
        vi.mocked(busy.deps.stoppedAgents.list).mockReturnValue([archived()])
        vi.mocked(busy.deps.stoppedAgents.remove).mockImplementation(() => { throw 'EBUSY' })
        vi.mocked(busy.deps.registry.reinstateArchived).mockReturnValue({ ...archived(), active: true } as RegisteredSession)
        await busy.handlers.onObserved(hermesSeen(), shell)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive could not be removed: EBUSY'))
      })

      it('says so, and stays back, when its archive cannot be removed', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const run = setup()
        vi.mocked(run.deps.stoppedAgents.list).mockReturnValue([archived()])
        vi.mocked(run.deps.stoppedAgents.remove).mockImplementation(() => { throw new Error('EBUSY') })
        vi.mocked(run.deps.registry.reinstateArchived).mockReturnValue({ ...archived(), active: true } as RegisteredSession)
        await run.handlers.onObserved(hermesSeen(), shell)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('archive could not be removed'))
        expect(run.deps.send).toHaveBeenCalled()
      })
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

    it('a start that went dormant and wakes, and a launch that turns ready, are told too', async () => {
      const run = setup()
      const awake = row({ browser: true })
      run.rows.set('a1', awake)
      await run.handlers.onObserved(seen(), row({ active: false, browser: true }))
      await run.handlers.onObserved(seen(), row({ launch: { state: 'starting' }, browser: true } as Partial<RegisteredSession>))
      await settle()
      expect(vi.mocked(run.deps.attachBrowser).mock.calls).toEqual([[awake], [awake]])
    })

    it.each(['held', 'removed', 'rebound'] as const)('cannot retire or announce an attachment whose binding became %s', async state => {
      const run = setup(), awake = row()
      run.rows.set('a1', awake)
      vi.mocked(run.deps.attachSession).mockImplementationOnce(async () => {
        if (state === 'held') awake.identityHold = 'waiting for native evidence'
        if (state === 'removed') run.rows.clear()
        if (state === 'rebound') awake.sessionId = 'replacement'
        return false
      })
      await run.handlers.onObserved(seen(), row({ active: false }))
      await settle()
      expect(run.deps.registry.setActive).not.toHaveBeenCalled()
      expect(run.deps.announceSession).not.toHaveBeenCalled()
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
      const failed = row({ resumeOnly: true, tmuxPane: '%0', runtimes: [{ backend: 'tmux', paneId: '%0' }], launch: { state: 'failed' } } as Partial<RegisteredSession>)
      await run.handlers.onDormant(failed, 'x') // the pane is gone: the reconciler's to remove
      // tmux could not be asked, as when the daemon's event loop was held: no news either way.
      paneState.mockResolvedValueOnce('unknown')
      await run.handlers.onDormant(failed, 'x')
      paneState.mockResolvedValueOnce({ dead: false, engineExit: null } as never)
      await run.handlers.onDormant(failed, 'x') // a live shell, no engine exit
      expect(run.deps.retainExitedSession).not.toHaveBeenCalled()
      paneState.mockResolvedValueOnce({ dead: true, engineExit: null } as never)
      await run.handlers.onDormant(failed, 'pane died')
      paneState.mockResolvedValueOnce({ dead: false, engineExit: 1 } as never)
      await run.handlers.onDormant(failed, 'engine exited 1')
      expect(run.deps.retainExitedSession).toHaveBeenCalledTimes(2)
      expect(run.deps.terminals.backendFor).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%0' })
      expect(paneState).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%0' })
    })

    it('asks a failed resume\'s own backend about its pane, never tmux about a ptyhost pane\'s id', async () => {
      const run = setup({ terminals: { backendFor: vi.fn(() => undefined) } })
      const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%0' }
      await run.handlers.onDormant(row({ resumeOnly: true, tmuxPane: '%0', runtimes: [pty], launch: { state: 'failed' } } as Partial<RegisteredSession>), 'x')
      expect(run.deps.terminals.backendFor).toHaveBeenCalledExactlyOnceWith(pty)
      expect(paneState).not.toHaveBeenCalled()
      expect(run.deps.retainExitedSession).not.toHaveBeenCalled()
    })

    it('holds a failed resume whose pane no configured backend can read', async () => {
      const run = setup({ terminals: { backendFor: vi.fn(() => undefined) } })
      await run.handlers.onDormant(row({ resumeOnly: true, tmuxPane: '%0', runtimes: [{ backend: 'tmux', paneId: '%0' }], launch: { state: 'failed' } } as Partial<RegisteredSession>), 'x')
      expect(run.deps.retainExitedSession).not.toHaveBeenCalled()
      expect(paneState).not.toHaveBeenCalled()
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

  it('keeps only the rows restore could not look at, and retires any other whose pane is gone', () => {
    // One row restore could not survey (a `ps` that timed out at boot) used to stop every pane closed
    // outside the app from being retired, for as long as the core ran.
    const run = setup()
    run.degrade('a2')
    run.handlers.onRemoved(row(), 'pane gone')
    expect(run.deps.forgetSession).toHaveBeenCalledWith('a1', { force: true })
    run.handlers.onRemoved({ ...row(), agentId: 'a2' }, 'pane gone')
    expect(run.deps.forgetSession).toHaveBeenCalledTimes(1)
    expect(run.deps.registry.setActive).toHaveBeenCalledWith('a2', false)
  })

  it('never archives a held conversation when its waiting shell or engine is absent', async () => {
    const run = setup()
    const held = row({ launch: { state: 'held', service: 'store', detail: 'Waiting for preparation.' } })
    await run.handlers.onDormant(held, 'two engine misses')
    run.handlers.onRemoved(held, 'two missing-pane scans')
    expect(run.deps.retainExitedSession).not.toHaveBeenCalled()
    expect(run.deps.forgetSession).not.toHaveBeenCalled()
    expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', false)
    expect(run.deps.announceSession).toHaveBeenCalledWith(held)
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

  describe('a shell row whose pane is live', () => {
    const shell = (over: Partial<RegisteredSession> = {}) => row({ engine: 'terminal', active: false, ...over } as Partial<RegisteredSession>)

    // A shell has no engine process, so no observation ever reactivates it after the core's start marks every row dormant:
    // its live pane, on whichever pty host serves it, is the only evidence there is.
    it('is active again, and announced as such', () => {
      const run = setup()
      const dormant = shell()
      run.rows.set(dormant.agentId, dormant)
      vi.mocked(run.deps.registry.terminalAvailable).mockReturnValue(true)
      run.handlers.onTerminalAvailability(dormant, true)
      expect(run.deps.registry.setActive).toHaveBeenCalledWith('a1', true)
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    it('is left alone when already active, held or failed, or when its pane is not live', () => {
      const run = setup()
      for (const over of [{ active: true }, { launch: { state: 'held' } }, { launch: { state: 'failed' } }]) {
        const r = shell(over as Partial<RegisteredSession>)
        run.rows.set(r.agentId, r)
        run.handlers.onTerminalAvailability(r, true)
      }
      run.handlers.onTerminalAvailability(shell(), false)
      expect(run.deps.registry.setActive).not.toHaveBeenCalled()
    })

    it('is not reactivated for an engine row, which its process observation owns', () => {
      const run = setup()
      const engine = row({ active: false })
      run.rows.set(engine.agentId, engine)
      run.handlers.onTerminalAvailability(engine, true)
      expect(run.deps.registry.setActive).not.toHaveBeenCalled()
    })
  })
})

it('cannot promote an unadmitted external waiting pane into a live engine', async () => {
  const test = setup()
  const pending = row({ active: false, sessionId: '', externalResume: { phase: 'waiting' } as RegisteredSession['externalResume'] })
  test.rows.set(pending.agentId, pending)
  await test.handlers.onObserved(seen(), pending)
  expect(test.deps.registry.updateRuntimes).not.toHaveBeenCalled()
  expect(test.deps.registry.updateProcessIdentity).not.toHaveBeenCalled()
  expect(test.deps.registry.setLaunch).not.toHaveBeenCalled()
  expect(test.deps.bindObservedAgent).not.toHaveBeenCalled()
})
