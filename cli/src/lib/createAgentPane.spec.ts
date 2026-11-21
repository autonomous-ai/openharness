import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { TerminalActionResult, TerminalCreateRequest, TerminalCreateResult, TmuxRuntimeRef } from './terminalTypes.js'
import { createAndRegisterPane } from './createAgentPane.js'

// A full disk, for the registry's own files only: the save's temporary file cannot be created.
const refuse = vi.hoisted(() => ({ code: undefined as string | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (refuse.code && /\/registry\.json\..*\.tmp$/.test(String(args[0]))) {
      throw Object.assign(new Error(`${refuse.code}: fixture, open '${String(args[0])}'`), { code: refuse.code })
    }
    return actual.open(...args)
  } }
})

let dataDir = ''

// Mirrors lib/registry.spec.ts's loadRegistryModule(): a fresh registry module per test, backed by
// its own temp state dir, so pre-seeded runtimeIndex collisions never leak between tests.
async function loadRegistryModule() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  process.env.CODEX_HOME = dataDir
  process.env.CURSOR_HOME = dataDir
  return import('./registry.js')
}

const succeeded = (paneId: string): TerminalCreateResult<TmuxRuntimeRef> =>
  ({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId } })

/** `results[N]` is what `create()` answers on its (N+1)th call; the last entry repeats past that. */
function fakeTmux(results: Array<TerminalCreateResult<TmuxRuntimeRef>>) {
  let call = 0
  return {
    create: vi.fn(async () => results[Math.min(call++, results.length - 1)]!),
    kill: vi.fn(async (): Promise<TerminalActionResult> => ({ state: 'succeeded', dispatch: 'executed' })),
  }
}

describe('createAndRegisterPane', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-'))
  })

  afterEach(() => {
    refuse.code = undefined
    rmSync(dataDir, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
    delete process.env.CLAUDE_PROJECTS_DIR
    delete process.env.CODEX_HOME
    delete process.env.CURSOR_HOME
  })

  it('registers on the first attempt when the pane is unclaimed', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const tmuxBackend = fakeTmux([succeeded('%1')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: () => ['claude'],
    })

    expect(result.ok).toBe(true)
    expect(tmuxBackend.create).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.create).toHaveBeenCalledWith(expect.objectContaining({ label: 'harness-claude-1', cwd: homedir() }))
    expect(tmuxBackend.kill).not.toHaveBeenCalled()
  })

  it('starts an explicit-argv terminal in its folder without evaluating its arguments', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const tmuxBackend = fakeTmux([succeeded('%1')])
    const argv = ['/bin/zsh', '/work/a script', '$(touch injected)', 'a; echo b', '']
    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'terminal', cwd: '/work/project with spaces',
      spawnCwd: '/work/project with spaces', sessionLabel: 'harness-shell-1', argv: () => argv,
    })
    expect(result.ok).toBe(true)
    expect(tmuxBackend.create).toHaveBeenCalledWith({ label: 'harness-shell-1', cwd: '/work/project with spaces', command: argv })
  })

  it('starts a Windows engine in its workspace with its hand-off, and an explicit folder still wins', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const tmuxBackend = fakeTmux([succeeded('%1'), succeeded('%2'), succeeded('%3')])
    const afterExit = { command: ['pwsh.exe', '-NoLogo'], env: { HARNESS_ENGINE_COMMAND: 'claude' } }
    await createAndRegisterPane({ tmuxBackend, registry, engine: 'claude', cwd: 'C:\\work', sessionLabel: 'harness-claude-1', argv: () => ['claude.exe'],
      paneLaunch: { cwd: 'C:\\work', afterExit, clearInherited: ['ANTHROPIC_API_KEY'] } })
    expect(tmuxBackend.create).toHaveBeenLastCalledWith({ label: 'harness-claude-1', cwd: 'C:\\work', command: ['claude.exe'], afterExit, clearInherited: ['ANTHROPIC_API_KEY'] })
    await createAndRegisterPane({ tmuxBackend, registry, engine: 'claude', cwd: '/w', spawnCwd: '/elsewhere', sessionLabel: 'harness-claude-2', argv: () => ['claude'],
      paneLaunch: { cwd: '/w' } })
    expect(tmuxBackend.create).toHaveBeenLastCalledWith({ label: 'harness-claude-2', cwd: '/elsewhere', command: ['claude'] })
    await createAndRegisterPane({ tmuxBackend, registry, engine: 'claude', cwd: '/w', sessionLabel: 'harness-claude-3', argv: () => ['claude'], paneLaunch: {} })
    expect(tmuxBackend.create).toHaveBeenLastCalledWith({ label: 'harness-claude-3', cwd: homedir(), command: ['claude'] })
  })

  it('retries past a stale registration collision and succeeds on the next pane', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    // Simulates a stale entry from a previous tmux-server generation already holding %1.
    ;(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/other' }))
    const tmuxBackend = fakeTmux([succeeded('%1'), succeeded('%2')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: () => ['claude'],
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.spawned.runtime.paneId).toBe('%2')
    expect(tmuxBackend.create).toHaveBeenCalledTimes(2)
    expect(tmuxBackend.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ label: 'harness-claude-1-r2' }))
    expect(tmuxBackend.kill).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' })
  })

  it('gives the retry pane a launch file of its own, as the first pane\'s shell removed its file on reading it', async () => {
    const { registry } = await loadRegistryModule()
    // Loaded after the reset, so its one-time launch files land in this test's data folder.
    const { buildEngineLaunchArgv, launchAttempts } = await import('./engineLaunch.js')
    registry.load()
    ;(await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/other' }))
    const panes = fakeTmux([succeeded('%1'), succeeded('%2')])
    // Each pane's POSIX shell sources its launch file, whose first line removes it (engineLaunch.ts `sourcedOnce`). The
    // retry once got the same file and its shell said "no such file or directory" (CI, cli/e2e/scale.e2e.ts, 2026-11-19).
    const sourced: boolean[] = []
    const tmuxBackend = { ...panes, create: async (request: TerminalCreateRequest) => {
      const file = request.command?.map(arg => /^\. '(.+)'$/s.exec(arg)?.[1]).find(Boolean)
      sourced.push(!!file && existsSync(file))
      if (file) rmSync(file, { force: true })
      return panes.create()
    } }

    const build = () => buildEngineLaunchArgv('codex', { cwd: '/tmp/demo' }, '/bin/sh', undefined, 'grid', null)
    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'codex', cwd: '/tmp/demo', sessionLabel: 'harness-codex-1',
      argv: launchAttempts(build(), build),
    })

    expect(result.ok && result.spawned.runtime.paneId).toBe('%2')
    expect(sourced).toEqual([true, true])
  })

  it('gives up with REGISTRATION_FAILED after 3 attempts when every pane collides', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    for (const paneId of ['%1', '%2', '%3']) {
      ;(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId }], cwd: '/tmp/other' }))
    }
    const tmuxBackend = fakeTmux([succeeded('%1'), succeeded('%2'), succeeded('%3')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: () => ['claude'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('REGISTRATION_FAILED')
      expect(result.detail).toContain('3 attempts')
    }
    expect(tmuxBackend.create).toHaveBeenCalledTimes(3)
    expect(tmuxBackend.kill).toHaveBeenCalledTimes(3)
  })

  it('a create whose pending row cannot be saved closes its one pane and says the registry could not be written', async () => {
    const { registry } = await loadRegistryModule()
    // Loaded after the reset, so it tells a storage refusal by the registry's own copy of the error classes.
    const { createAndRegisterPane } = await import('./createAgentPane.js')
    registry.load()
    refuse.code = 'ENOSPC'
    const tmuxBackend = fakeTmux([succeeded('%1'), succeeded('%2'), succeeded('%3')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: () => ['claude'],
    })

    expect(result).toEqual({ ok: false, error: 'PERSISTENCE_UNCONFIRMED',
      detail: 'Registry persistence unavailable: registry storage has no available space (ENOSPC)' })
    expect(tmuxBackend.create).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' })
  })

  it('a create whose pending row cannot be saved says whether its pane closed', async () => {
    const { registry } = await loadRegistryModule()
    const { createAndRegisterPane } = await import('./createAgentPane.js')
    registry.load()
    refuse.code = 'ENOSPC'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const said = () => warn.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('[agent] create claude not saved'))
    const create = (tmuxBackend: ReturnType<typeof fakeTmux>) => createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: () => ['claude'],
    })
    try {
      await create(fakeTmux([succeeded('%1')]))
      const stuck = fakeTmux([succeeded('%2')])
      stuck.kill.mockResolvedValueOnce({ state: 'failed', dispatch: 'rejected', reason: 'tmux pane close' })
      await create(stuck)
      // The pane left open is one the person sees with no harness in it: the line must not say it closed.
      expect(said()).toEqual([
        '[agent] create claude not saved · pane %1 closed · RegistryPersistenceUnavailable ENOSPC',
        '[agent] create claude not saved · pane %2 close failed · RegistryPersistenceUnavailable ENOSPC',
      ])
    } finally {
      warn.mockRestore()
    }
  })

  it('a pending admission the storage refuses rejects with the storage category, and a taken route still answers null', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    expect(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/other' })).not.toBeNull()
    expect(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }] })).toBeNull()
    refuse.code = 'ENOSPC'
    await expect(registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%2' }] }))
      .rejects.toThrow('registry storage has no available space (ENOSPC)')
  })

  it('a pending or resumed admission that fails says what kind of error it was, and nothing the error carries', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      refuse.code = 'ENOSPC'
      await expect(registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }] })).rejects.toThrow()
      refuse.code = undefined
      const naming = vi.spyOn(registry as unknown as { automaticName(): string }, 'automaticName')
        .mockImplementation(() => { throw Object.assign(new Error('/Users/someone/secret'), { code: 'EBUSY' }) })
      expect(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%2' }] })).toBeNull()
      // A code or a name that is free text is not a kind: it can quote what the message would.
      naming.mockImplementation(() => { throw Object.assign(new Error('x'), { name: 'open /Users/someone/secret', code: 'open /Users/someone/secret' }) })
      expect(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%3' }] })).toBeNull()
      // Nor is one word that is not a class name or a code's shape: a file's or a person's name.
      naming.mockImplementation(() => { throw Object.assign(new Error('x'), { name: 'someone', code: 'notes.md' }) })
      expect(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%6' }] })).toBeNull()
      naming.mockRestore()
      const saved = { ...(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%4' }] }))!, agentId: 'stopped-1', sessionId: '' }
      vi.spyOn(registry as unknown as { ownerGuard(): unknown }, 'ownerGuard')
        .mockImplementation(() => { throw Object.assign(new Error('/Users/someone/secret'), { code: 'EBUSY' }) })
      expect(await registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%5' }])).toBeNull()
      // A retried create logged only "failed", and nothing said why its first pane was not admitted (CI, 2026-11-19).
      expect(said.mock.calls.map(([line]) => String(line)).filter(line => / admission failed/.test(line))).toEqual([
        '[registry] pending admission failed · RegistryPersistenceUnavailable ENOSPC', '[registry] pending admission failed · EBUSY',
        '[registry] pending admission failed · Error', '[registry] pending admission failed · Error',
        '[registry] resume admission failed · EBUSY',
      ])
    } finally {
      said.mockRestore()
    }
  })

  it('records the named agent and the requested name on the row it opens', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const tmuxBackend = fakeTmux([succeeded('%1')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'opencode', cwd: '/home/someone', sessionLabel: 'harness-opencode-1',
      argv: () => ['opencode', '--agent', 'harness-compute'], agent: 'harness-compute', defaultName: 'Local model',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pending).toMatchObject({ engine: 'opencode', agent: 'harness-compute', defaultName: 'Local model' })
    expect(registry.byAgent(result.pending.agentId)).toMatchObject({ agent: 'harness-compute' })
  })

  it('records which harness here started it, only when another agent did', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const started = await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%1')]), registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1',
      argv: () => ['claude'], startedBy: 'agent', parentAgentId: 'lead-1',
    })
    expect(started.ok && started.pending).toMatchObject({ startedBy: 'agent', parentAgentId: 'lead-1' })
    const person = await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%2')]), registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-2',
      argv: () => ['claude'], parentAgentId: 'lead-1',
    })
    expect(person.ok && person.pending).not.toHaveProperty('parentAgentId')
  })

  it('records a Browser on from the start on the row it opens', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const ticked = await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%1')]), registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1',
      argv: () => ['claude'], browser: true,
    })
    expect(ticked.ok && ticked.pending).toMatchObject({ browser: true })
    const plain = await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%2')]), registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-2', argv: () => ['claude'],
    })
    expect(plain.ok && plain.pending).not.toHaveProperty('browser')
  })

  it('a first task goes onto the row the pane is registered as', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const openPendingAgent = vi.spyOn(registry, 'openPendingAgent')
    await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%1')]), registry, engine: 'openclaw', cwd: '/tmp/demo', sessionLabel: 'harness-openclaw-1',
      argv: () => ['openclaw', 'tui'], firstTask: 'Fix the parser',
    })
    expect(openPendingAgent).toHaveBeenCalledWith(expect.objectContaining({ firstTask: 'Fix the parser' }))
    await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%2')]), registry, engine: 'openclaw', cwd: '/tmp/demo', sessionLabel: 'harness-openclaw-2',
      argv: () => ['openclaw', 'tui'],
    })
    expect(openPendingAgent.mock.calls[1]![0]).not.toHaveProperty('firstTask')
  })

  it('a local launch\'s folder goes on its row', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const openPendingAgent = vi.spyOn(registry, 'openPendingAgent')
    const local = await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%1')]), registry, engine: 'openclaw', cwd: '/tmp/demo', sessionLabel: 'harness-openclaw-1',
      argv: () => ['openclaw', 'tui', '--local'], openclawLocal: '/runs/one',
    })
    expect(openPendingAgent).toHaveBeenCalledWith(expect.objectContaining({ openclawLocal: '/runs/one' }))
    expect(local.ok && local.pending).toMatchObject({ openclawLocal: '/runs/one', openclawStateDir: '/runs/one' })
    await createAndRegisterPane({
      tmuxBackend: fakeTmux([succeeded('%2')]), registry, engine: 'openclaw', cwd: '/tmp/demo', sessionLabel: 'harness-openclaw-2',
      argv: () => ['openclaw', 'tui'],
    })
    expect(openPendingAgent.mock.calls[1]![0]).not.toHaveProperty('openclawLocal')
  })

  it('does not retry a tmux spawn failure', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const openPendingAgent = vi.spyOn(registry, 'openPendingAgent')
    const tmuxBackend = fakeTmux([{ state: 'failed', dispatch: 'not_started', reason: 'tmux is unavailable' }])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: () => ['claude'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('TMUX_UNAVAILABLE')
    expect(tmuxBackend.create).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).not.toHaveBeenCalled()
    expect(openPendingAgent).not.toHaveBeenCalled()
  })

  it('logs a tmux spawn failure by the code it answers with, and still answers with its words', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tmuxBackend = fakeTmux([
      { state: 'failed', dispatch: 'not_started', reason: 'no server running on /Users/sentinel/tmux' },
      { state: 'failed', dispatch: 'not_started', reason: 'tmux is unavailable' },
    ])
    try {
      const create = () => createAndRegisterPane({
        tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: () => ['claude'],
      })
      expect(await create()).toMatchObject({ ok: false, error: 'SPAWN_FAILED', detail: 'no server running on /Users/sentinel/tmux' })
      expect(await create()).toMatchObject({ ok: false, error: 'TMUX_UNAVAILABLE' })
      const lines = warn.mock.calls.map(call => call.map(String).join(' '))
      expect(lines.join('\n')).not.toContain('sentinel')
      expect(lines).toEqual([
        '[agent] create claude failed · tmux could not open a pane · SPAWN_FAILED',
        '[agent] create claude failed · tmux could not open a pane · TMUX_UNAVAILABLE',
      ])
    } finally {
      warn.mockRestore()
    }
  })
})
