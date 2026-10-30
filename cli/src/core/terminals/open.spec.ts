import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createTerminalOpener, type TerminalOpenerDeps } from './open.js'

vi.mock('../../lib/createAgentPane.js', () => ({ createAndRegisterPane: vi.fn() }))

const row = { agentId: 'shell', engine: 'terminal', launch: { state: 'ready' } } as RegisteredSession
function setup(over: Partial<TerminalOpenerDeps> = {}) {
  const deps: TerminalOpenerDeps = {
    createBackend: { create: vi.fn(), kill: vi.fn(), releaseHold: vi.fn(async () => {}) },
    registry: { openPendingAgent: vi.fn(), setLaunch: vi.fn(() => row) },
    announceSession: vi.fn(), blocksFolder: vi.fn(() => false), ...over,
  }
  vi.mocked(createAndRegisterPane).mockResolvedValue({ ok: true, pending: row,
    spawned: { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%42' } },
  })
  return { deps, open: createTerminalOpener(deps).open }
}

describe('the core terminal launch call', () => {
  afterEach(() => vi.clearAllMocks())
  it('registers literal argv in its folder, marks it ready and announces it', async () => {
    const { deps, open } = setup()
    const argv = ['/bin/zsh', '/work/a script', '$(touch injected)', 'a; b', '']
    expect(await open({ argv, cwd: '/work/project' })).toEqual({ ok: true, agentId: 'shell' })
    expect(createAndRegisterPane).toHaveBeenCalledWith({
      tmuxBackend: deps.createBackend, registry: deps.registry, engine: 'terminal', cwd: '/work/project',
      spawnCwd: '/work/project', argv, sessionLabel: expect.stringMatching(/^harness-shell-[\da-f-]+$/), bypassPermission: false,
    })
    expect(vi.mocked(createAndRegisterPane).mock.calls[0]![0].argv).not.toBe(argv)
    expect(deps.createBackend!.releaseHold).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%42' })
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('shell', { state: 'ready' })
    expect(deps.announceSession).toHaveBeenCalledWith(row)
  })
  it('refuses when tmux is unavailable or the folder is being removed', async () => {
    expect(await setup({ createBackend: null }).open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
    expect(await setup({ createBackend: null, noBackendCode: 'PTY_HOST_UNAVAILABLE' }).open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'PTY_HOST_UNAVAILABLE' })
    expect(await setup({ blocksFolder: () => true }).open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'WORKTREE_BUSY' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })
  it('opens on a backend recovered after boot, as an agent\'s create does, and keeps refusing while there is none', async () => {
    const backend = { create: vi.fn(), kill: vi.fn(), releaseHold: vi.fn(async () => {}) }
    const recoverBackend = vi.fn(async () => backend)
    const { open } = setup({ createBackend: null, recoverBackend })
    expect(await open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: true, agentId: 'shell' })
    expect(vi.mocked(createAndRegisterPane).mock.calls[0]![0].tmuxBackend).toBe(backend)
    // Recovered once: the next terminal uses it without asking again.
    await open({ argv: ['/bin/sh'], cwd: '/work' })
    expect(recoverBackend).toHaveBeenCalledOnce()
    const none = setup({ createBackend: null, recoverBackend: async () => null })
    expect(await none.open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
  })
  it('preserves a failed launch and never announces it', async () => {
    const { deps, open } = setup()
    vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: false, error: 'SPAWN_FAILED', detail: 'gone' })
    expect(await open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'gone' })
    expect(deps.createBackend!.releaseHold).not.toHaveBeenCalled()
    expect(deps.announceSession).not.toHaveBeenCalled()
  })
  it('does not announce a terminal that closed before it became ready', async () => {
    const { deps, open } = setup()
    vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
    expect(await open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'TERMINAL_CLOSED' })
    expect(deps.announceSession).not.toHaveBeenCalled()
  })
})
