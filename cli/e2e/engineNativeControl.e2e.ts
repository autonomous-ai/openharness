/**
 * Codex's shared app-server, spoken to from the Codex worker: a real private daemon, tmux and supervised
 * workers, an older fake Codex that shares its server (no --no-daemon), and the server's real loopback
 * WebSocket reached through the fake CLI's raw-byte `app-server proxy` (harness/sharedCodex.ts).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until, type DaemonOptions } from './harness/daemon.js'
import { alive, harnessdProcesses } from './harness/endurance.js'
import { sharedCodex } from './harness/sharedCodex.js'

type Row = Record<string, any>

describe('Codex\'s shared server, from the Codex worker', () => {
  let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined, server: Awaited<ReturnType<typeof sharedCodex>> | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); await server?.close(); client = undefined; daemon = undefined; server = undefined })

  async function fresh(env: DaemonOptions['env'] = {}) {
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100', ...env } })
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`))
    // Older Codex releases share one server per profile and have no --no-daemon flag. Keep the actual CLI probe.
    writeFileSync(join(d.root, 'bin', 'codex'), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(join(CLI_ROOT, 'e2e/harness/fakeEngine.mjs')).href)}).then(m => m.run('codex', ${JSON.stringify({ ...d.engineConfig, without: ['--no-daemon'] })}))\n`, { mode: 0o755 })
    const s = server = await sharedCodex(d.engineConfig.codexHome)
    await d.start()
    const c = client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'codex'); mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent: Row = await until('the shared conversation to bind', async () =>
      (await c.request('agents_list', {})).agents.find((row: Row) => row.id === created.agent.id && row.sessionId) ?? null, 60_000, 200)
    s.state.threadId = agent.sessionId
    const started = c.next(frame => frame.type === 'turn_started' && frame.agentId === agent.id, 30_000, 'the held turn')
    c.send('message', { agentId: agent.id, content: '!hold' })
    await started
    const count = (method: string, since = 0) => s.state.requests.slice(since).filter(frame => frame.method === method).length
    const close = () => c.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode: 'now' }, 90_000)
    return { d, c, s, agent, count, close }
  }

  /** This daemon's `codex app-server proxy` clients, as the process table shows them, with their parents. */
  const proxies = (d: IsolatedDaemon) => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((match): match is RegExpExecArray => !!match)
    .filter(match => match[3].includes(join(d.root, 'bin', 'codex')) && match[3].includes('app-server proxy'))
    .map(match => ({ pid: Number(match[1]), parent: Number(match[2]) }))
  // A replacement process, connected to the core: the worker is back, not merely started.
  const linked = (d: IsolatedDaemon) => d.log().split('[services] engine-codex connected').length - 1
  const replacement = async (d: IsolatedDaemon, before: number, connections: number) => until('a replacement Codex worker', () => {
    const pid = harnessdProcesses(d).get('engine-codex')
    return pid && pid !== before && alive(pid) && linked(d) > connections ? pid : null
  }, 30_000, 100)

  it('reads activity over the worker\'s connection, and a worker killed with it open leaves no second connection, and the next close works', async () => {
    const { d, c, s, agent, count, close } = await fresh()
    await until('the activity read at the shared server', () => count('thread/read') > 0 || null, 45_000, 100)
    await until('verified working activity', async () => (await c.request('agents_list', {})).agents.find((row: Row) => row.id === agent.id)?.activity?.state === 'working' || null, 20_000, 200)
    const core = d.corePid(), worker = harnessdProcesses(d).get('engine-codex')!
    // The connection is the worker's: its proxy client is the worker's child, never the core's.
    expect(proxies(d).map(proxy => proxy.parent)).toEqual([worker])
    expect(s.state.open).toBe(1)
    const initialized = count('initialize'), connections = linked(d)
    process.kill(worker, 'SIGKILL')
    await replacement(d, worker, connections)
    await until('the old connection gone and one new one made', () => count('initialize') > initialized && s.state.open === 1 || null, 45_000, 100)
    await until('the old proxy client gone', () => proxies(d).length === 1 || null, 10_000, 100)
    expect(proxies(d)[0].parent).toBe(harnessdProcesses(d).get('engine-codex'))
    const before = s.state.requests.length
    const result = await close()
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    for (const method of ['thread/goal/set', 'turn/interrupt', 'thread/archive', 'thread/unarchive']) expect(count(method, before), method).toBe(1)
    expect(s.state.loaded).toBe(false)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it('a worker killed in the middle of a stop sends nothing more, leaves the pane, and a second close stops the conversation once', async () => {
    const { d, s, agent, count, close } = await fresh()
    const core = d.corePid(), worker = harnessdProcesses(d).get('engine-codex')!
    const panePid = (await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()
    s.state.hold = 'thread/turns/list'
    const first = close()
    await until('the stop waiting on the server', () => count('thread/turns/list') > 0 || null, 45_000, 50)
    const connections = linked(d)
    process.kill(worker, 'SIGKILL')
    const refused = await first
    expect(refused.error, JSON.stringify(refused)).toBeDefined()
    const killedAt = s.state.requests.length
    s.release()
    await replacement(d, worker, connections)
    // Nothing of the stopped attempt reaches the server after its worker went: no interrupt, no archive.
    for (const method of ['turn/interrupt', 'thread/archive', 'thread/unarchive']) expect(count(method), method).toBe(0)
    expect((await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()).toBe(panePid)
    expect(s.state.loaded).toBe(true)
    const result = await close()
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    for (const method of ['turn/interrupt', 'thread/archive', 'thread/unarchive']) expect(count(method), method).toBe(1)
    expect(count('thread/goal/set', killedAt)).toBe(1)
    expect(s.state.loaded).toBe(false)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it('closes with the control in the core\'s own process in explicit inline mode', async () => {
    const { d, s, count, close } = await fresh({ HARNESSD_SERVICES: 'none' })
    const result = await close()
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    for (const method of ['thread/goal/set', 'turn/interrupt', 'thread/archive', 'thread/unarchive']) expect(count(method), method).toBe(1)
    expect(s.state.loaded).toBe(false)
    expect(harnessdProcesses(d).get('engine-codex')).toBeUndefined()
  })
})
