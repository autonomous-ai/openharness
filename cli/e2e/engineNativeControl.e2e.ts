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
const SUPERVISION = { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
  HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' }
const PARKING = { HARNESSD_SERVICE_PARK_CRASHES: '3', HARNESSD_SERVICE_PARK_RETRY_MS: '120000' }

describe('Codex\'s shared server, from the Codex worker', () => {
  let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined, server: Awaited<ReturnType<typeof sharedCodex>> | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); await server?.close(); client = undefined; daemon = undefined; server = undefined })

  /** A Codex agent in a held turn. `shared`: an older Codex with no --no-daemon, whose conversation lives on the
   *  fake shared server; otherwise today's, which Harness launches with --no-daemon to own its conversation. */
  async function fresh(env: DaemonOptions['env'] = {}, shared = true) {
    const d = daemon = await IsolatedDaemon.create({ env: { ...SUPERVISION, ...env } })
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`))
    if (shared) writeFileSync(join(d.root, 'bin', 'codex'), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(join(CLI_ROOT, 'e2e/harness/fakeEngine.mjs')).href)}).then(m => m.run('codex', ${JSON.stringify({ ...d.engineConfig, without: ['--no-daemon'] })}))\n`, { mode: 0o755 })
    const s = server = await sharedCodex(d.engineConfig.codexHome)
    await d.start()
    const c = client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'codex'); mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent: Row = await until('the conversation to bind', async () =>
      (await c.request('agents_list', {})).agents.find((row: Row) => row.id === created.agent.id && row.sessionId) ?? null, 60_000, 200)
    s.state.threadId = agent.sessionId
    const started = c.next(frame => frame.type === 'turn_started' && frame.agentId === agent.id, 30_000, 'the held turn')
    c.send('message', { agentId: agent.id, content: '!hold' })
    await started
    const count = (method: string, since = 0) => s.state.requests.slice(since).filter(frame => frame.method === method).length
    const close = () => c.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode: 'now' }, 90_000)
    const pane = async () => (await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()
    return { d, c, s, agent, count, close, pane }
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
  /** Killed until the master parks it, as a worker crashing on every start would be. */
  async function park(d: IsolatedDaemon) {
    for (let index = 0; index < 3; index++) {
      const before = harnessdProcesses(d).get('engine-codex')!
      process.kill(before, 'SIGKILL')
      if (index < 2) await until('a replacement Codex worker', () => {
        const pid = harnessdProcesses(d).get('engine-codex')
        return pid && pid !== before && alive(pid) ? pid : null
      }, 15_000, 100)
    }
    await until('the Codex worker parked', () => d.log().includes('service engine-codex ended 3 times') || null, 60_000, 200)
  }

  it('reads activity over the worker\'s connection; with that worker killed, a close sent at once still stops the conversation once', async () => {
    const { d, c, s, agent, count, close } = await fresh()
    await until('the activity read at the shared server', () => count('thread/read') > 0 || null, 45_000, 100)
    await until('verified working activity', async () => (await c.request('agents_list', {})).agents.find((row: Row) => row.id === agent.id)?.activity?.state === 'working' || null, 20_000, 200)
    const core = d.corePid(), worker = harnessdProcesses(d).get('engine-codex')!
    // The connection is the worker's: its proxy client is the worker's child, never the core's.
    expect(proxies(d).map(proxy => proxy.parent)).toEqual([worker])
    expect(s.state.open).toBe(1)
    process.kill(worker, 'SIGKILL')
    // Sent before the worker is back: the close's read refused by the restart waits for it and reads again.
    const before = s.state.requests.length
    const result = await close()
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    for (const method of ['thread/goal/set', 'turn/interrupt', 'thread/archive', 'thread/unarchive']) expect(count(method, before), method).toBe(1)
    expect(s.state.loaded).toBe(false)
    expect(s.state.archived).toBe(false)
    await until('no client of the killed worker left', () => proxies(d).every(proxy => proxy.parent === harnessdProcesses(d).get('engine-codex')) || null, 10_000, 100)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it('a worker killed while a stop waits on the server sends nothing more, leaves the pane, and a second close stops it once', async () => {
    const { d, s, count, close, pane } = await fresh()
    const core = d.corePid(), worker = harnessdProcesses(d).get('engine-codex')!, panePid = await pane()
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
    expect(await pane()).toBe(panePid)
    const result = await close()
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    for (const method of ['turn/interrupt', 'thread/archive', 'thread/unarchive']) expect(count(method), method).toBe(1)
    expect(count('thread/goal/set', killedAt)).toBe(1)
    expect(s.state.loaded).toBe(false)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it('a worker killed between archive and unarchive: the next worker returns the thread\'s history, once', async () => {
    const { d, s, count, close, pane } = await fresh()
    const worker = harnessdProcesses(d).get('engine-codex')!, panePid = await pane()
    s.state.hold = 'thread/archive'
    const first = close()
    await until('the archive sent', () => s.state.archived || null, 45_000, 50)
    const connections = linked(d)
    process.kill(worker, 'SIGKILL')
    const refused = await first
    expect(refused.error, JSON.stringify(refused)).toBeDefined()
    expect(await pane()).toBe(panePid)
    await replacement(d, worker, connections)
    await until('the archived history returned', () => !s.state.archived || null, 30_000, 100)
    expect(count('thread/unarchive')).toBe(1)
    await until('the repair logged', () => d.log().includes('restored the history of codex conversation') || null, 10_000, 100)
    // Forgotten once done: another restart repairs nothing more.
    const again = harnessdProcesses(d).get('engine-codex')!, more = linked(d)
    process.kill(again, 'SIGKILL')
    await replacement(d, again, more)
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(count('thread/unarchive')).toBe(1)
  })

  it('with the Codex worker parked, Stop still stops an agent that owns its conversation, needing no worker', async () => {
    const { d, c, agent, pane } = await fresh(PARKING, false)
    const core = d.corePid(), panePid = Number(await pane())
    await park(d)
    const stopped = await c.request('agent_delete', { agentId: agent.id }, 90_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
    await until('the agent gone', async () => !(await c.request('agents_list', {})).agents.some((row: Row) => row.id === agent.id) || null, 30_000, 200)
    await until('its process ended', () => !alive(panePid) || null, 30_000, 100)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it('with the Codex worker parked, a conversation on the shared server is not reported stopped: the pane stays, and it is logged', async () => {
    const { d, c, s, agent, count, pane } = await fresh(PARKING)
    const panePid = await pane()
    await park(d)
    const before = s.state.requests.length
    const refused = await c.request('agent_delete', { agentId: agent.id }, 90_000)
    expect(refused.error, JSON.stringify(refused)).toBeDefined()
    expect(d.log()).toContain('the codex worker did not answer the stop')
    expect(await pane()).toBe(panePid)
    expect((await c.request('agents_list', {})).agents.some((row: Row) => row.id === agent.id)).toBe(true)
    expect(count('thread/archive', before)).toBe(0)
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
