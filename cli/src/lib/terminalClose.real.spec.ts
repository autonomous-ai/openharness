import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { createTerminalControl } from '../core/terminals/control.js'
import { isolatedTmux } from '../testing/isolatedTmux.js'
import { CloseAgentService, inspectCloseActivity } from './closeAgentService.js'
import { registry } from './registry.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { createStopAgentService } from './stopAgentService.js'
import { stoppedAgents } from './stoppedAgents.js'
import { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import { TmuxBackend } from './tmuxBackend.js'

it.runIf(process.env.RUN_REAL_TMUX_DISCOVERY === '1')('saves and closes an inactive shell without closing its neighboring pane', async () => {
  const server = await isolatedTmux({ PATH: process.env.PATH, TERM: 'xterm-256color' })
  vi.stubEnv('TMUX', undefined)
  vi.stubEnv('TMUX_PANE', undefined)
  vi.stubEnv('TMUX_TMPDIR', server.root)
  let close: CloseAgentService | undefined
  let agentId: string | undefined
  try {
    const neighbor = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'terminal-close', 'sleep', '600')
    const pane = await server.run('split-window', '-h', '-P', '-F', '#{pane_id}', '-t', neighbor, '/bin/sh', '-i')
    await server.run('send-keys', '-t', pane, '-l', "printf 'saved terminal output\\n'")
    await server.run('send-keys', '-t', pane, 'Enter')
    await server.run('send-keys', '-t', pane, '-l', 'keep this unsent draft')
    const backend = new TmuxBackend()
    const terminals = new TerminalBackendCoordinator([backend], ['tmux'])
    const control = createTerminalControl({ resolve: id => registry.resolve(id), terminals })
    const row = registry.openPendingAgent({ engine: 'terminal', cwd: env.ADAPTER_DATA_DIR,
      runtimes: [{ backend: 'tmux', paneId: pane }] })!
    agentId = row.agentId
    // Registry reloads can leave a perfectly live shell inactive: no engine is
    // running to rediscover. Its retained pane is still visible in the app.
    registry.setActive(row.agentId, false)
    await vi.waitFor(async () => {
      const capture = await backend.capture(row.runtimes[0])
      expect(capture).toMatchObject({ state: 'succeeded', value: expect.stringContaining('keep this unsent draft') })
    })
    expect(await control.captureTerminal(row.agentId)).toBeNull()
    const directory = join(env.ADAPTER_DATA_DIR, 'terminal-checkpoints')
    const checkpoints = new SessionCheckpointStore(directory)
    const savedScreen = async () => {
      const files = await readdir(directory)
      const manifest = JSON.parse(await readFile(join(directory, files.find(file => /^[a-f0-9]{64}\.json$/.test(file))!), 'utf8'))
      const file = join(directory, manifest.file)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      const saved = JSON.parse(await readFile(file, 'utf8'))
      expect(saved.agentId).toBe(row.agentId)
      expect(saved.screen).toContain('saved terminal output')
      expect(saved.screen).toContain('keep this unsent draft')
    }
    const actualKill = backend.kill.bind(backend)
    const kill = vi.spyOn(backend, 'kill')
    kill.mockImplementation(async runtime => {
      await savedScreen() // The backup must exist before the pane is killed.
      return actualKill(runtime)
    })
    const stop = createStopAgentService({ registry, stoppedAgents,
      restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(), tmuxBackend: backend,
      agentReconciler: { suppress() {}, holdRoute() {}, releaseRoute() {}, trigger: async () => {} },
      forgetSession: id => registry.removeAgent(id), markDeleted() {}, clearDeleted() {},
    })
    close = new CloseAgentService({ registry, stop, changed() {},
      activity: async session => inspectCloseActivity(session, await control.captureTerminal(session.agentId), undefined, false),
      checkpoint: async (session, phase) => {
        const captured = phase === 'before' ? await terminals.captureRetained(session, { historyLines: 2000 }) : null
        await checkpoints.save(session, { screen: captured?.state === 'succeeded' ? captured.value : null })
      },
    })
    const request = { agentId: row.agentId, sessionId: '', createdAt: new Date(row.registeredAt).toISOString() }
    expect(await close.request({ ...request, mode: 'idle' })).toMatchObject({ error: 'SESSION_NOT_IDLE' })
    expect(kill).not.toHaveBeenCalled()
    expect(await close.request({ ...request, mode: 'now' })).toEqual({ closed: true })
    expect(kill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: pane })
    expect(registry.byAgent(row.agentId)).toBeUndefined()
    await savedScreen()
    expect(await server.run('list-panes', '-t', 'terminal-close', '-F', '#{pane_id}')).toBe(neighbor)
  } finally {
    close?.dispose()
    if (agentId) registry.removeAgent(agentId)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await server.close()
  }
}, 15_000)
