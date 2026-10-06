/**
 * The experiments, on the real daemon: each runs in a process of its own that the master starts only once it is
 * on (core/api.ts `EXPERIMENTS`, harnessd/services.ts `onDemand`), the orchestrator first. Off, it has no
 * process: a daemon whose person never used it pays nothing for it. Its first request, or its saved state as
 * the daemon starts, turns it on. Whatever then happens to its process (killed, hung, crashing on every start)
 * costs that process alone: the core never restarts, every agent keeps working, and the window on this
 * computer stays connected and hears every turn.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const teamsStarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service teams started/g)].length

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

  it('Tab collaboration: off, the teams have no process; a team request starts it, the scopes and the teams beside them', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    expect(teamsStarts(d), 'an experiment no one asked for').toBe(0)
    expect(await client.request('team', { action: 'capabilities' }, 40_000)).toMatchObject({ protocol: expect.any(String) })
    expect(teamsStarts(d)).toBe(1)
    await until('the scopes and the teams to connect', () => (d.log().includes('[services] teams connected') && d.log().includes('[services] collaboration connected')) || null, 30_000, 200)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a team in its own process introduces its members and delivers a question into the other agent, through the core', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const [alpha, beta] = [await create(d, client, 'team-alpha'), await create(d, client, 'team-beta', 'codex')]
    const teamId = '1'.repeat(32), questionId = '2'.repeat(32)
    const member = (agent: Record<string, any>, name: string) => ({ machineId: d.computerId, agentId: agent.id, name })
    const created = await client.request('team', { action: 'create', id: teamId, name: 'End to end', members: [member(alpha, 'alpha'), member(beta, 'beta')] }, 40_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const team = async () => (await client.request('team', { action: 'get', teamId }, 40_000)).team as { members: Array<{ name: string; introduction: { state: string } }>; exchanges: Array<{ delivery: { state: string } }> }
    // Each member is told it is in the team: written into its pane by the core, its turn heard back.
    await until('both introductions to start their turns', async () => (await team()).members.every((m) => m.introduction.state === 'started') || null, 90_000, 500)
    const keys = JSON.parse(readFileSync(join(d.dataDir, 'teams', 'ledgers', `${teamId}.json`), 'utf8')).members as Array<{ name: string; key: string }>
    const asked = await client.request('team', { action: 'ask', teamId, id: questionId, memberKey: keys.find((m) => m.name === 'alpha')!.key, to: 'beta', text: 'Which port does the daemon serve?' }, 40_000)
    expect(asked.error, JSON.stringify(asked)).toBeUndefined()
    await until('the question to start beta\'s turn', async () => (await team()).exchanges[0]?.delivery.state === 'started' || null, 90_000, 500)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a team\'s saved state turns Tab collaboration on as the daemon starts', async () => {
    const d = await fresh({}, (daemon) => mkdirSync(join(daemon.dataDir, 'teams', 'ledgers'), { recursive: true }))
    await until('the teams to start for their saved state', () => d.log().includes('[services] collaboration connected') || null, 30_000, 200)
    expect(teamsStarts(d)).toBe(1)
  })
})
