/**
 * harnessd's master over the real daemon: whatever happens to the core, the daemon comes back on its
 * own, the agents keep running in tmux, and a client picks up where it was. Whatever happens to the
 * master, nothing is left behind holding the port.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const ready = /\[cli\] ready/g
const wiredCount = (daemon: IsolatedDaemon) => [...daemon.log().matchAll(ready)].length

async function withAgent(daemon: IsolatedDaemon) {
  const client = await LocalClient.connect(daemon)
  const cwd = join(daemon.projectsDir, 'work')
  mkdirSync(cwd, { recursive: true })
  const agentId: string = (await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)).agent.id
  await until('the conversation to bind', async () => rowOf(client, agentId).then((row) => row?.sessionId), 45_000, 250)
  return { client, agentId }
}

const rowOf = async (client: LocalClient, agentId: string) =>
  ((await client.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>).find((agent) => agent.id === agentId)

/** A full turn on a fresh connection: proof the restarted daemon serves the same agent. */
async function turnWorks(daemon: IsolatedDaemon, agentId: string) {
  const client = await LocalClient.connect(daemon)
  await until('the agent to be live again', async () => {
    const row = await rowOf(client, agentId)
    return row && row.status !== 'stopped' ? row : null
  }, 60_000, 250)
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 30_000, 'a turn after the restart')
  client.send('message', { agentId, content: 'are you still there?' })
  await ended
  client.close()
}

describe('harnessd', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const make = async (env: Record<string, string> = {}, { start = true } = {}) => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_INITIAL_BACKOFF_MS: '100', ...env } })
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    if (start) await d.start()
    return d
  }

  it('runs the core under a master that claims the pid file for itself', async () => {
    const d = await make()
    expect(d.corePid()).not.toBe(d.pid)
    expect(readFileSync(join(d.dataDir, 'adapter.pid'), 'utf8').trim()).toBe(String(d.pid))
  })

  it('restarts a core that crashes; the agent and its client carry on', async () => {
    const d = await make()
    const { client, agentId } = await withAgent(d)
    const first = d.corePid()!
    const wired = wiredCount(d)
    process.kill(first, 'SIGKILL')
    await until('a new core to finish starting', () => wiredCount(d) > wired, 60_000)
    expect(d.corePid()).not.toBe(first)
    expect(IsolatedDaemon.alive(d.pid)).toBe(true)
    await until('the old connection to close', () => client.closed, 10_000)
    await turnWorks(d, agentId)
  })

  it('kills and restarts a core that hangs', async () => {
    const d = await make({ HARNESSD_HEARTBEAT_TIMEOUT_MS: '3000' })
    const { agentId } = await withAgent(d)
    const hung = d.corePid()!
    const wired = wiredCount(d)
    process.kill(hung, 'SIGSTOP')
    await until('the master to notice', () => d.log().includes('it is hung'), 20_000)
    await until('a new core to finish starting', () => wiredCount(d) > wired, 60_000)
    expect(IsolatedDaemon.alive(hung)).toBe(false)
    await turnWorks(d, agentId)
  })

  it('takes the core down with it when the master is killed, and starts clean again', async () => {
    const d = await make()
    const { agentId } = await withAgent(d)
    const core = d.corePid()!
    await d.kill()
    await until('the core to follow its master', () => !IsolatedDaemon.alive(core), 10_000)
    await d.start()
    await turnWorks(d, agentId)
  })

  it('stops core and master within the grace harness stop gives them, removing the pid file', async () => {
    const d = await make()
    const core = d.corePid()!
    const master = d.pid!
    const started = Date.now()
    process.kill(master, 'SIGTERM')
    await until('both to exit', () => !IsolatedDaemon.alive(master) && !IsolatedDaemon.alive(core), 10_000, 25)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(existsSync(join(d.dataDir, 'adapter.pid'))).toBe(false)
  })

  it('restarts a core that outgrows its memory budget, backing off while it keeps doing so', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_INITIAL_BACKOFF_MS: '200', HARNESSD_RSS_LIMIT_MIB: '1' } })
    const d = daemon
    await d.start({ ready: 'none' })
    await until('the master to restart it for its memory', () => /over its 1 MiB budget — restarting it/.test(d.log()), 30_000)
    await until('another core', () => d.coresStarted() >= 2, 30_000)
    // 200, 400, 800, 1600 ms… — never as fast as a core can bind.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(d.coresStarted()).toBeLessThanOrEqual(6)
  })

  it('restarts a core that something other than its master stops — it does not take the daemon down', async () => {
    const d = await make()
    const { agentId } = await withAgent(d)
    const first = d.corePid()!
    const wired = wiredCount(d)
    process.kill(first, 'SIGTERM')
    await until('a new core to finish starting', () => wiredCount(d) > wired, 60_000)
    expect(IsolatedDaemon.alive(d.pid)).toBe(true)
    expect(d.log()).toMatch(/core exited \(code 0, crashed\) — restarting/)
    await turnWorks(d, agentId)
  })

  it('records what the master knows where `harness status` reads it, the core alive or not', async () => {
    const d = await make()
    const statusFile = join(d.dataDir, 'harnessd-status.json')
    const read = () => JSON.parse(readFileSync(statusFile, 'utf8'))
    await until('the status file to say running', () => existsSync(statusFile) && read().state === 'running', 10_000)
    expect(read()).toMatchObject({ masterPid: d.pid, corePid: d.corePid(), restarts: 0, safeMode: null, protocol: 2 })
    const core = d.corePid()!
    process.kill(core, 'SIGKILL')
    await until('the status file to name the crash', () => read().restarts === 1 && read().lastExitReason === 'crashed', 10_000)
    await until('the status file to say running again', () => read().state === 'running', 60_000)
  })

  it('puts a core that keeps crashing in safe mode, and tries a normal one once safe mode runs out', async () => {
    const d = await make({ HARNESSD_CRASH_LOOP_WINDOW_MS: '120000', ADAPTER_SAFE_MODE_MS: '6000' })
    const statusFile = join(d.dataDir, 'harnessd-status.json')
    const read = () => JSON.parse(readFileSync(statusFile, 'utf8'))
    for (let crash = 1; crash <= 3; crash++) {
      const core = d.corePid()!
      process.kill(core, 'SIGKILL')
      await until(`core ${crash + 1} to start`, () => d.coresStarted() > crash, 30_000)
      await until(`core ${crash + 1} to bind`, () => d.corePid() !== core && read().state !== 'restarting', 60_000)
    }
    expect(d.log()).toMatch(/core crashed 3 times in 2 min — starting it in safe mode/)
    await until('the safe-mode core to say so', () => read().safeMode !== null && read().state === 'running', 30_000)
    expect(read().safeMode).toMatch(/crash again and again/)
    // Its time runs out with no fix: a normal core starts and finishes starting.
    const wired = wiredCount(d)
    await until('a normal core again', () => wiredCount(d) > wired, 60_000)
    await until('the status file to drop safe mode', () => read().safeMode === null && read().state === 'running', 30_000)
  })

  it('kills a core that binds but never finishes starting, and keeps doing so into safe mode', async () => {
    const d = await make({ HARNESSD_TEST_HOLD_READY: '1', HARNESSD_READY_TIMEOUT_MS: '3000', HARNESSD_CRASH_LOOP_WINDOW_MS: '120000' }, { start: false })
    await d.start({ ready: 'none' })
    await until('the master to give up on a start-up', () => /core bound but not ready within 3000 ms — killing it/.test(d.log()), 30_000)
    await until('safe mode', () => /starting it in safe mode/.test(d.log()), 60_000)
    const statusFile = join(d.dataDir, 'harnessd-status.json')
    await until('the safe-mode core to be up', () => {
      const status = JSON.parse(readFileSync(statusFile, 'utf8'))
      return status.state === 'running' && status.safeMode !== null
    }, 30_000)
  })
})

