import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { registry, type RegisteredSession } from './registry.js'
import { stoppedAgents } from './stoppedAgents.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { CloseAgentService, inspectCloseActivity } from './closeAgentService.js'
import { createStopAgentService } from './stopAgentService.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { processRows } from './tmux.js'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'
import { TmuxBackend } from './tmuxBackend.js'
import { isolatedTmux } from '../testing/isolatedTmux.js'

vi.mock('./tmux.js', async importOriginal => ({
  ...await importOriginal<typeof import('./tmux.js')>(),
  processRows: vi.fn(),
}))
vi.mock('./captureResumeIdentity.js', () => ({ captureResumeIdentity: vi.fn(async session => session) }))
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn() }))

// The old companion TUI shares a profile with a running server but has never
// submitted a turn. Exercise the real Close -> Stop -> Codex lifecycle chain.
const emptyComposer = '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m\n\n  GPT-6-Astra max · /tmp/companions\n  ? for shortcuts'
let row: RegisteredSession
let service: CloseAgentService
let screen: string | null
let checkpointDirectory: string
const killPane = vi.fn<TmuxBackend['kill']>(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const }))

beforeEach(() => {
  vi.clearAllMocks()
  row = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%500' }], cwd: '/tmp/companions' })!
  Object.assign(row, {
    launch: { state: 'ready' },
    dsh: 'autonomous/pair',
    codexHome: join(env.ADAPTER_DATA_DIR, 'unused-codex', row.agentId),
    processIdentity: { pid: 99, executable: 'node', startMarker: 'old companion' },
  })
  mkdirSync(join(row.codexHome!, 'app-server-daemon'), { recursive: true })
  writeFileSync(join(row.codexHome!, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: 78, processStartTime: 'shared server' }))
  vi.mocked(processRows).mockResolvedValue([
    { ...row.processIdentity!, parentPid: 1, args: 'node /bin/codex -c mcp_servers.harnessd.command="harness"' },
    { pid: 78, parentPid: 1, executable: 'codex', startMarker: 'shared server', args: 'codex app-server' },
  ])
  screen = emptyComposer
  vi.mocked(terminateDeletedAgent).mockResolvedValue('terminated')
  const stop = createStopAgentService({
    registry, stoppedAgents, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    tmuxBackend: { kill: killPane },
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: id => registry.removeAgent(id), markDeleted: vi.fn(), clearDeleted: vi.fn(),
  })
  checkpointDirectory = join(env.ADAPTER_DATA_DIR, 'unused-checkpoints', row.agentId)
  const checkpoints = new SessionCheckpointStore(checkpointDirectory)
  service = new CloseAgentService({
    registry, stop, changed: vi.fn(),
    activity: async session => inspectCloseActivity(session, screen, undefined, false),
    checkpoint: (session, phase) => checkpoints.save(session, { screen: phase === 'before' ? screen : null }),
  })
})
afterEach(() => {
  service.dispose()
  vi.restoreAllMocks()
  for (const entry of registry.list()) registry.removeAgent(entry.agentId)
})

it.each(['idle', 'now'] as const)('closes an unused companion with a shared Codex server after saving its terminal (%s)', async mode => {
  const request = { agentId: row.agentId, sessionId: '', createdAt: new Date(row.registeredAt).toISOString() }
  expect(await service.request({ ...request, mode: 'inspect' })).toEqual({ activity: 'idle' })
  expect(await service.request({ ...request, mode })).toEqual({ closed: true })
  expect(terminateDeletedAgent).toHaveBeenCalledOnce()
  expect(vi.mocked(terminateDeletedAgent).mock.calls[0][0].processIdentity?.pid).toBe(99)
  expect(killPane).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%500' })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  const manifest = JSON.parse(readFileSync(join(checkpointDirectory, readdirSync(checkpointDirectory).find(file => /^[a-f0-9]{64}\.json$/.test(file))!), 'utf8'))
  expect(JSON.parse(readFileSync(join(checkpointDirectory, manifest.file), 'utf8')).screen).toBe(emptyComposer)
})

it.each(['working', 'draft', 'unreadable', 'bound', 'resuming'] as const)('does not bypass an unknown shared conversation when %s', async state => {
  // The final check happens after saving, even when Close was explicitly
  // confirmed. No conversation ID must not mean arbitrary work can be stopped.
  const rows = vi.mocked(processRows).getMockImplementation()!
  vi.mocked(processRows).mockImplementation(async () => {
    if (state === 'working') screen = '• Working (4s · esc to interrupt)\n›\n  100% context left'
    if (state === 'draft') screen = '› Keep this draft\n  100% context left'
    if (state === 'unreadable') screen = null
    if (state === 'bound') row.boundAt = 1
    if (state === 'resuming') row.resumeOnly = true
    return rows()
  })
  expect(await service.request({ agentId: row.agentId, sessionId: '', createdAt: new Date(row.registeredAt).toISOString(), mode: 'now' }))
    .toMatchObject({ error: 'CLOSE_FAILED' })
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(killPane).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)).toBe(row)
})

it('closes the saved shell when an unbound Codex client exits before discovery catches up', async () => {
  screen = '$ codex\n$ '
  vi.mocked(processRows).mockResolvedValue((await processRows())!.filter(process => process.pid !== row.processIdentity!.pid))
  vi.mocked(terminateDeletedAgent).mockResolvedValue('gone')
  const request = { agentId: row.agentId, sessionId: '', createdAt: new Date(row.registeredAt).toISOString() }
  expect(await service.request({ ...request, mode: 'inspect' })).toEqual({ activity: 'unknown' })
  expect(await service.request({ ...request, mode: 'idle' })).toMatchObject({ error: 'SESSION_NOT_IDLE' })
  expect(await service.request({ ...request, mode: 'now' })).toEqual({ closed: true })
  expect(killPane).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%500' })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  const manifest = JSON.parse(readFileSync(join(checkpointDirectory, readdirSync(checkpointDirectory).find(file => /^[a-f0-9]{64}\.json$/.test(file))!), 'utf8'))
  expect(JSON.parse(readFileSync(join(checkpointDirectory, manifest.file), 'utf8')).screen).toBe(screen)
})

it.runIf(process.env.RUN_REAL_TMUX_DISCOVERY === '1')('closes only the exited client pane in a real private tmux server', async () => {
  const server = await isolatedTmux()
  const actualTmux = await vi.importActual<typeof import('./tmux.js')>('./tmux.js')
  const actualStop = await vi.importActual<typeof import('./deleteAgentFallback.js')>('./deleteAgentFallback.js')
  vi.stubEnv('TMUX', undefined)
  vi.stubEnv('TMUX_PANE', undefined)
  vi.stubEnv('TMUX_TMPDIR', server.root)
  vi.mocked(processRows).mockImplementation(actualTmux.processRows)
  vi.mocked(checkPidRuntime).mockImplementation(actualStop.checkPidRuntime)
  vi.mocked(terminateDeletedAgent).mockImplementation(actualStop.terminateDeletedAgent)
  killPane.mockImplementation(runtime => new TmuxBackend().kill(runtime))
  try {
    const sibling = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'close-fixture', 'sleep 600')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const script = 'console.log("fixture Codex client"); setInterval(() => {}, 1000)'
    const pane = await server.run('split-window', '-h', '-P', '-F', '#{pane_id}', '-t', sibling,
      `${quote(process.execPath)} -e ${quote(script)}; exec /bin/sh`)
    const shellPid = Number(await server.run('display-message', '-p', '-t', pane, '#{pane_pid}'))
    await vi.waitFor(async () => {
      const child = (await processRows())?.find(process => process.parentPid === shellPid && process.args.includes('fixture Codex client'))
      expect(child).toBeDefined()
      row.processIdentity = { pid: child!.pid, executable: child!.executable, startMarker: child!.startMarker }
    })
    row.runtimes = [{ backend: 'tmux', paneId: pane }]
    const unrelatedServer = (await processRows())!.find(row => row.pid === process.pid)!
    writeFileSync(join(row.codexHome!, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: unrelatedServer.pid, processStartTime: unrelatedServer.startMarker }))
    // Signal only this fixture child; terminal Ctrl-C also reaches its shell.
    process.kill(row.processIdentity!.pid, 'SIGTERM')
    await vi.waitFor(async () => expect((await processRows())!.some(process => process.pid === row.processIdentity!.pid)).toBe(false))
    screen = await server.run('capture-pane', '-p', '-t', pane)
    const result = await service.request({ agentId: row.agentId, sessionId: '', createdAt: new Date(row.registeredAt).toISOString(), mode: 'now' })
    expect(result).toEqual({ closed: true })
    expect(await server.run('list-panes', '-t', 'close-fixture', '-F', '#{pane_id}')).toBe(sibling)
    expect(await server.run('display-message', '-p', '-t', sibling, '#{pane_dead}')).toBe('0')
    expect((await processRows())!.some(row => row.pid === unrelatedServer.pid)).toBe(true)
  } finally {
    await server.close()
    vi.unstubAllEnvs()
  }
}, 15_000)
