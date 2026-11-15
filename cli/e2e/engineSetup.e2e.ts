/** Optional setup cannot hold terminal launches or input; every process/home/socket here is disposable. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
const setupPid = (d: IsolatedDaemon) => harnessdProcesses(d).get('engineSetup')
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
async function fresh(env: Record<string, string> = {}) {
  const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
  onTestFailed(() => console.log(d.log()))
  await d.start(); client = await LocalClient.connect(d)
  return { d, c: client }
}
async function create(d: IsolatedDaemon, c: LocalClient, engine: 'terminal' | 'claude', name: string) {
  const cwd = join(d.projectsDir, name); mkdirSync(cwd, { recursive: true })
  const result = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(result.error, JSON.stringify(result)).toBeUndefined()
  return result.agent
}
async function turn(c: LocalClient, agentId: string, content: string) {
  const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 30_000, content)
  c.send('message', { agentId, content }); await ended
}

it('starts setup only for an engine launch and keeps every private setup route off the client router', async () => {
  const { d, c } = await fresh()
  expect(setupPid(d)).toBeUndefined()
  for (const type of ['setup_capture', 'setup_probe', 'setup_download', 'setup_version', 'setup_status', 'setup_prepare', 'setup_commit']) {
    expect((await c.request(type, { engine: 'claude', allowed: true })).error).toBe('UNSUPPORTED')
  }
  await create(d, c, 'terminal', 'shell')
  expect(setupPid(d)).toBeUndefined()
  const agent = await create(d, c, 'claude', 'native')
  expect(setupPid(d)).toBeGreaterThan(1)
  await turn(c, agent.id, 'setup-on-demand')
  expect(d.coresStarted()).toBe(1)
})

it.each(['kill', 'freeze'] as const)('keeps input and unrelated shell launches working after setup %s', async failure => {
  const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: failure === 'freeze' ? '60000' : '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' })
  const agent = await create(d, c, 'claude', 'already-running')
  await turn(c, agent.id, 'before-setup-failure')
  const core = d.corePid(), before = setupPid(d)!
  process.kill(before, failure === 'kill' ? 'SIGKILL' : 'SIGSTOP')
  try {
    await Promise.all([turn(c, agent.id, 'during-setup-failure'), create(d, c, 'terminal', `shell-${failure}`)])
    expect(d.corePid()).toBe(core)
    if (failure === 'freeze') {
      // Prove both operations completed while setup was still frozen, then request its recovery.
      expect(setupPid(d)).toBe(before)
      process.kill(before, 'SIGKILL')
    }
    await until('setup replacement', () => { const pid = setupPid(d); return pid && pid !== before ? pid : null }, 30_000, 100)
    const next = await create(d, c, 'claude', `after-${failure}`)
    await turn(c, next.id, 'setup-recovered')
    expect(d.coresStarted()).toBe(1)
  } finally {
    // Never signal a reused PID: only resume the still-listed fixture service.
    if (failure === 'freeze' && setupPid(d) === before) process.kill(before, 'SIGCONT')
  }
})

it('keeps the explicit inline compatibility composition working', async () => {
  const { d, c } = await fresh({ HARNESSD_SERVICES: 'none' })
  const agent = await create(d, c, 'claude', 'inline')
  await turn(c, agent.id, 'setup-inline')
  expect(setupPid(d)).toBeUndefined(); expect(d.coresStarted()).toBe(1)
})
