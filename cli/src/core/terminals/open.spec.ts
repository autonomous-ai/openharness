import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { clearPaneRemainOnExit } from '../../lib/tmux.js'
import { createTerminalOpener, type TerminalOpenerDeps } from './open.js'

vi.mock('../../lib/createAgentPane.js', () => ({ createAndRegisterPane: vi.fn() }))
vi.mock('../../lib/tmux.js', () => ({ clearPaneRemainOnExit: vi.fn(async () => {}) }))

const row = { agentId: 'shell', engine: 'terminal', launch: { state: 'ready' } } as RegisteredSession
function setup(over: Partial<TerminalOpenerDeps> = {}) {
  const deps: TerminalOpenerDeps = {
    tmuxBackend: { create: vi.fn(), kill: vi.fn() },
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
      tmuxBackend: deps.tmuxBackend, registry: deps.registry, engine: 'terminal', cwd: '/work/project',
      spawnCwd: '/work/project', argv, sessionLabel: expect.stringMatching(/^harness-shell-[\da-f-]+$/), bypassPermission: false,
    })
    expect(vi.mocked(createAndRegisterPane).mock.calls[0]![0].argv).not.toBe(argv)
    expect(clearPaneRemainOnExit).toHaveBeenCalledWith('%42')
    expect(deps.registry.setLaunch).toHaveBeenCalledWith('shell', { state: 'ready' })
    expect(deps.announceSession).toHaveBeenCalledWith(row)
  })
  it('refuses when tmux is unavailable or the folder is being removed', async () => {
    expect(await setup({ tmuxBackend: null }).open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'TMUX_UNAVAILABLE' })
    expect(await setup({ blocksFolder: () => true }).open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'WORKTREE_BUSY' })
    expect(createAndRegisterPane).not.toHaveBeenCalled()
  })
  it('preserves a failed launch and never announces it', async () => {
    const { deps, open } = setup()
    vi.mocked(createAndRegisterPane).mockResolvedValueOnce({ ok: false, error: 'SPAWN_FAILED', detail: 'gone' })
    expect(await open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'gone' })
    expect(clearPaneRemainOnExit).not.toHaveBeenCalled()
    expect(deps.announceSession).not.toHaveBeenCalled()
  })
  it('does not announce a terminal that closed before it became ready', async () => {
    const { deps, open } = setup()
    vi.mocked(deps.registry.setLaunch).mockReturnValueOnce(null)
    expect(await open({ argv: ['/bin/sh'], cwd: '/work' })).toEqual({ ok: false, error: 'TERMINAL_CLOSED' })
    expect(deps.announceSession).not.toHaveBeenCalled()
  })
})
