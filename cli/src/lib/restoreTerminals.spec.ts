import { describe, expect, it, vi } from 'vitest'
import { lookupPaneEngineProcess, resolvePaneEngineProcess } from './paneEngineProcess.js'
import type { RegisteredSession } from './registry.js'
import { restoreTerminals } from './restoreTerminals.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

vi.mock('./paneEngineProcess.js', () => ({
  lookupPaneEngineProcess: vi.fn(async () => ({ ok: false, unknown: false, reason: 'none' })),
  resolvePaneEngineProcess: vi.fn(async () => null),
}))

const tmux: TerminalRuntimeRef = { backend: 'tmux', paneId: '%3' }
const pty: TerminalRuntimeRef = { backend: 'ptyhost', instance: 'p1', paneId: '%3' }

function fakeBackend(name: string, made: TerminalRuntimeRef) {
  return {
    name,
    holdOpen: vi.fn(),
    respawn: vi.fn(async (..._args: unknown[]) => ({ state: 'succeeded' as const, dispatch: 'executed' as const })),
    create: vi.fn(async (..._args: unknown[]) => ({ state: 'succeeded' as const, dispatch: 'executed' as const, runtime: made })),
    isHeld: vi.fn(async (..._args: unknown[]) => true as const),
    inventory: vi.fn(async () => ({ state: 'available' as const, roots: [{ runtime: pty, rootPid: 9, cwd: '/' }] })),
    paneState: vi.fn(async (..._args: unknown[]) => ({ dead: false })),
    releaseHold: vi.fn(async (..._args: unknown[]) => {}),
    kill: vi.fn(async (..._args: unknown[]) => ({ state: 'succeeded' as const, dispatch: 'executed' as const })),
  }
}

function setup() {
  const tmuxBackend = fakeBackend('tmux', { backend: 'tmux', paneId: '%9' })
  const ptyBackend = fakeBackend('ptyhost', { backend: 'ptyhost', instance: 'p1', paneId: '%9' })
  const listTmuxPanes = vi.fn(async () => ({ ok: true as const, panes: [{ tmuxPane: '%3' }] }))
  const backendFor = vi.fn((runtime: TerminalRuntimeRef) => (runtime.backend === 'tmux' ? tmuxBackend : ptyBackend) as unknown as TerminalBackend)
  const terminals = restoreTerminals({ backendFor, listTmuxPanes, cwd: '/home/me', label: (engine) => `harness-${engine}` })
  return { tmuxBackend, ptyBackend, listTmuxPanes, backendFor, terminals }
}

const entry = (runtimes: TerminalRuntimeRef[]) => ({ agentId: 'a1', engine: 'claude', runtimes }) as unknown as RegisteredSession

describe('restore, on each pane\'s own backend', () => {
  it('restores only on a backend with the restart primitives', () => {
    const { terminals, backendFor, ptyBackend } = setup()
    expect(terminals.restorable(pty)).toBe(true)
    backendFor.mockReturnValueOnce({ name: 'ptyhost', respawn: vi.fn() } as unknown as TerminalBackend)
    expect(terminals.restorable(pty)).toBe(false)
    backendFor.mockReturnValueOnce(undefined as unknown as TerminalBackend)
    expect(terminals.restorable(pty)).toBe(false)
    expect(ptyBackend.create).not.toHaveBeenCalled()
  })

  it('surveys tmux by its pane listing and the pty host by its inventory: `%3` on one is not `%3` on the other', async () => {
    const { terminals, listTmuxPanes, ptyBackend } = setup()
    const survey = terminals.survey()
    expect(await survey.livePane!(tmux)).toBe(true)
    expect(await survey.livePane!(pty)).toBe(true)
    expect(await survey.livePane!({ ...pty, paneId: '%4' })).toBe(false)
    expect(listTmuxPanes).toHaveBeenCalledOnce()
    expect(ptyBackend.inventory).toHaveBeenCalled()
    listTmuxPanes.mockResolvedValueOnce({ ok: false } as never)
    ptyBackend.inventory.mockResolvedValueOnce({ state: 'unavailable', reason: 'down' } as never)
    const fresh = terminals.survey()
    expect(await fresh.livePane!(tmux)).toBe('unknown')
    expect(await fresh.livePane!(pty)).toBe('unknown')
    vi.mocked(lookupPaneEngineProcess).mockResolvedValueOnce({ ok: true, identity: { pid: 1, startMarker: 's' } } as never)
    expect(await terminals.liveProcess(entry([pty]), pty)).toEqual({ pid: 1, startMarker: 's' })
    expect(lookupPaneEngineProcess).toHaveBeenLastCalledWith(ptyBackend, pty, 'claude')
  })

  it('asks a held pane, probes, reads, releases and closes through the pane\'s own backend', async () => {
    const { terminals, tmuxBackend, ptyBackend } = setup()
    expect(await terminals.waitingPane(pty, 'token')).toBe(true)
    expect(ptyBackend.isHeld).toHaveBeenCalledExactlyOnceWith(pty, 'token')
    expect(tmuxBackend.isHeld).not.toHaveBeenCalled()
    await terminals.probeProcess(pty, 'claude')
    expect(resolvePaneEngineProcess).toHaveBeenLastCalledWith(ptyBackend, pty, 'claude')
    expect(await terminals.paneState(pty)).toEqual({ dead: false })
    await terminals.clearRemainOnExit(pty)
    await terminals.killPane(pty)
    expect(ptyBackend.paneState).toHaveBeenCalledWith(pty)
    expect(ptyBackend.releaseHold).toHaveBeenCalledWith(pty)
    expect(ptyBackend.kill).toHaveBeenCalledWith(pty)
    expect(tmuxBackend.kill).not.toHaveBeenCalled()
  })

  it('cannot say a pane holds a launch on a backend that cannot say', async () => {
    const { terminals, backendFor } = setup()
    backendFor.mockReturnValue({ name: 'ptyhost', holdOpen: vi.fn(), respawn: vi.fn() } as unknown as TerminalBackend)
    expect(await terminals.waitingPane(pty, 'token')).toBe('unknown')
  })

  it('opens a rebuilt pane on the backend of the row\'s own pane, tmux\'s first, and says why it could not', async () => {
    const { terminals, tmuxBackend, ptyBackend } = setup()
    const control = { current: () => true, expectedHeldToken: 't' }
    expect(await terminals.createPane(entry([pty]), { argv: ['claude'], env: { K: 'v' } }, control))
      .toEqual({ ok: true, runtime: { backend: 'ptyhost', instance: 'p1', paneId: '%9' } })
    expect(ptyBackend.create).toHaveBeenCalledExactlyOnceWith({ cwd: '/home/me', label: 'harness-claude', command: ['claude'], ...control, env: { K: 'v' } })
    expect(await terminals.createPane(entry([pty, tmux]), { argv: ['claude'] })).toEqual({ ok: true, runtime: { backend: 'tmux', paneId: '%9' } })
    expect(tmuxBackend.create).toHaveBeenCalledExactlyOnceWith({ cwd: '/home/me', label: 'harness-claude', command: ['claude'] })
    ptyBackend.create.mockResolvedValueOnce({ state: 'failed', dispatch: 'not_started', reason: 'host down' } as never)
    expect(await terminals.createPane(entry([pty]), { argv: ['claude'] })).toEqual({ ok: false, reason: 'host down' })
    // Windows: the workspace and the hand-off the launch carries (lib/windows/engineStart.ts).
    const afterExit = { command: ['pwsh.exe'], env: { HARNESS_ENGINE_COMMAND: 'claude' } }
    await terminals.createPane(entry([pty]), { argv: ['claude'], paneLaunch: { cwd: 'C:\\work', afterExit } })
    expect(ptyBackend.create).toHaveBeenLastCalledWith({ cwd: 'C:\\work', label: 'harness-claude', command: ['claude'], afterExit })
  })

  it('respawns in place on the pane\'s own backend with the dispatch control, the held token included', async () => {
    const { terminals, ptyBackend, tmuxBackend } = setup()
    const control = { current: () => true, expectedHeldToken: 't' }
    expect(await terminals.respawn(pty, { argv: ['claude'], env: { K: 'v' } }, control)).toEqual({ ok: true })
    expect(ptyBackend.respawn).toHaveBeenCalledExactlyOnceWith(pty, { command: ['claude'], ...control, cwd: '/home/me', env: { K: 'v' } })
    expect(tmuxBackend.respawn).not.toHaveBeenCalled()
    ptyBackend.respawn.mockResolvedValueOnce({ state: 'failed', dispatch: 'not_started', reason: 'The waiting pane changed' } as never)
    expect(await terminals.respawn(pty, { argv: ['claude'] })).toEqual({ ok: false, reason: 'The waiting pane changed' })
    const afterExit = { command: ['pwsh.exe'] }
    await terminals.respawn(pty, { argv: ['claude'], paneLaunch: { cwd: 'C:\\work', afterExit } })
    expect(ptyBackend.respawn).toHaveBeenLastCalledWith(pty, { command: ['claude'], cwd: 'C:\\work', afterExit })
  })

  it('refuses, never guesses, for a pane whose backend went', async () => {
    const { terminals, backendFor } = setup()
    backendFor.mockReturnValue(undefined as unknown as TerminalBackend)
    await expect(terminals.paneState(pty)).rejects.toThrow('no terminal backend restores ptyhost:p1:%3')
    await expect(terminals.createPane(entry([pty]), { argv: [] })).rejects.toThrow('no terminal backend restores this harness')
  })
})
