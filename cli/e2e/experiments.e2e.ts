/**
 * The experiments, on the real daemon: each runs in a process of its own that the master starts only once it is
 * on (core/api.ts `EXPERIMENTS`, harnessd/services.ts `onDemand`), the orchestrator first. Off, it has no
 * process: a daemon whose person never used it pays nothing for it. Its first request, or its saved state as
 * the daemon starts, turns it on. Whatever then happens to its process (killed, hung, crashing on every start)
 * costs that process alone: the core never restarts, every agent keeps working, and the window on this
 * computer stays connected and hears every turn.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

/** The orchestrator's process the master runs now: the last one it said it started, read from its log. */
const orchestratorPid = (d: IsolatedDaemon): number | null => {
  const started = [...d.log().matchAll(/\[harnessd\] service orchestrator started \(pid (\d+)\)/g)]
  return started.length ? Number(started[started.length - 1][1]) : null
}
const starts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service orchestrator started/g)].length
const connected = (d: IsolatedDaemon) => d.log().split('[services] orchestrator connected').length - 1

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(d: IsolatedDaemon, client: LocalClient, folder: string, engine = 'claude'): Promise<Record<string, any>> {
  const cwd = join(d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
/** A message to the agent and its whole turn, heard by the window that sent it. */
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
const projects = (client: LocalClient) => client.request('orchestrator', { action: 'list' }, 40_000)

describe('the experiments, each in a process started only when it is on', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}, before?: (d: IsolatedDaemon) => void) => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    before?.(d)
    await d.start()
    return d
  }

  it('off, the orchestrator has no process; its first request starts it, and is answered', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'experiment-off')
    await turn(client, agent.id, 'nothing here uses an experiment')
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    expect(starts(d), 'an experiment no one asked for').toBe(0)
    expect(await projects(client)).toMatchObject({ projects: [] })
    expect(starts(d)).toBe(1)
    expect(connected(d)).toBe(1)
    // On now: asked again, the same process answers.
    expect(await projects(client)).toMatchObject({ projects: [] })
    expect(starts(d)).toBe(1)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a saved project turns it on as the daemon starts, with no request', async () => {
    const id = 'c'.repeat(32)
    const d = await fresh({}, (daemon) => {
      const stateDir = join(daemon.dataDir, 'orchestrator')
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(stateDir, `${id}.json`), JSON.stringify({
        version: 1, id, fingerprint: 'f', prompt: 'Build the robot', engine: 'claude', bypassPermission: false, parallelism: 3,
        root: stateDir, directorId: null, directorWorking: false, state: 'paused', error: null,
        tasks: [], messages: [], revision: 1, createdAt: 1, updatedAt: 1,
      }), { mode: 0o600 })
    })
    await until('the orchestrator to start for its saved project', () => connected(d) >= 1 || null, 30_000, 200)
    const client = await LocalClient.connect(d)
    const answer = await projects(client)
    expect((answer.projects as Array<{ id: string }>).map((project) => project.id)).toEqual([id])
    client.close()
  })

  it('with HARNESSD_SERVICES=none it runs in the core\'s process, as before', async () => {
    const d = await fresh({ HARNESSD_SERVICES: 'none' })
    const client = await LocalClient.connect(d)
    expect(await projects(client)).toMatchObject({ projects: [] })
    expect(starts(d)).toBe(0)
    client.close()
  })

  it('killed outright: the core, the agents and the window go on; it is back for its next request', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'experiment-killed', 'codex')
    expect(await projects(client)).toMatchObject({ projects: [] })
    process.kill(orchestratorPid(d)!, 'SIGKILL')
    await until('the master to see it gone', () => d.log().includes('[harnessd] service orchestrator exited') || null, 30_000, 100)
    // The agent never noticed, and the window that asked heard its whole turn.
    await turn(client, agent.id, 'while the orchestrator was gone')
    await until('the master to start it again', () => starts(d) >= 2 && connected(d) >= 2 || null, 30_000, 200)
    expect(await projects(client)).toMatchObject({ projects: [] })
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('hung: killed at the heartbeat watch and started again; nothing else waited on it', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'experiment-hung')
    expect(await projects(client)).toMatchObject({ projects: [] })
    const first = orchestratorPid(d)!
    process.kill(first, 'SIGSTOP')
    await turn(client, agent.id, 'the core never waits on an experiment')
    await until('the master to find it hung', () => d.log().includes('[harnessd] service orchestrator sent no heartbeat') || null, 30_000, 200)
    await until('it to be started again', () => starts(d) >= 2 && connected(d) >= 2 || null, 30_000, 200)
    expect(orchestratorPid(d)).not.toBe(first)
    expect(await projects(client)).toMatchObject({ projects: [] })
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('crashing on every start, it is parked once turned on, and says so; agents and the window go on', async () => {
    const d = await fresh({ HARNESSD_TEST_FAULTS: 'orchestrator.crash', HARNESSD_SERVICE_PARK_CRASHES: '3' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'experiment-crash-loop', 'codex')
    expect(starts(d)).toBe(0)
    // Its first request turns it on; whatever it is answered, it is an answer.
    await projects(client)
    await until('the master to park it', () => d.log().includes('[harnessd] service orchestrator ended 3 times') || null, 60_000, 250)
    expect(await projects(client)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'orchestrator' })
    await turn(client, agent.id, 'the orchestrator is parked and nothing else cares')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})
