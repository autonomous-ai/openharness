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
import { b64e, newEphemeral } from '../src/lib/e2ee/core.js'
import { recipientHandshake } from '../src/sharing/crypto.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

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
const sharingStarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service sharing started/g)].length
/** Share publishes its links through the account and reaches its observers through the relay: signed in, to the fake. */
const SHARER: FakeMachine = { machineId: 'd4'.repeat(16), computerId: 'e2e-computer-0000-0000-00000000000d', name: 'sharer', token: 'e2e-token-sharer' }
const signIn = (d: IsolatedDaemon) => writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
  version: 1, accessToken: SHARER.token, autonomousEnv: 'prod', computerId: SHARER.computerId,
  machineId: SHARER.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
}), { mode: 0o600 })

describe('the experiments, each in a process started only when it is on', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await backend?.close(); backend = undefined
  })
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
  const sharer = async (before?: (d: IsolatedDaemon) => void) => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(SHARER)
    const d = await fresh({ BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: SHARER.computerId }, (daemon) => { signIn(daemon); before?.(daemon) })
    return { d, relay }
  }

  it('Share: off, it has no process; a link starts it, and the link\'s observer is welcomed under its key and watches the terminal, sealed', async () => {
    const { d, relay } = await sharer()
    // Signed in, the daemon serves as the account's machine.
    const client = await LocalClient.connect(d, { machineId: SHARER.machineId })
    const agent = await create(d, client, 'shared')
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    await until('the relay', () => relay.nodeUp(SHARER.machineId) || null, 30_000, 200)
    expect(sharingStarts(d), 'an experiment no one asked for').toBe(0)
    const linked = await client.request('harness_share_link', { agentId: agent.id, visibility: 'public' }, 40_000)
    expect(linked.error, JSON.stringify(linked)).toBeUndefined()
    expect(sharingStarts(d)).toBe(1)
    const link = linked.link as { id: string; url: string; error: string | null }
    expect(link.error).toBeNull()
    expect(relay.seen).toContain(`PUT /api/harness-links/${link.id}`)
    // An observer of the link, through the relay: its welcome is signed by the key the link names.
    const observer = 'observer:e2e-ken'
    const ephemeral = newEphemeral()
    relay.injectDown(SHARER.machineId, observer, { type: 'observer_open', payload: { linkId: link.id, ephemeral: b64e(ephemeral.pub), authorId: 'e2e-ken', authorName: 'Ken' } })
    const welcome = await until('the observer\'s welcome', () => relay.targeted.get(observer)?.find((frame) => frame.type === 'observer_welcome') ?? null, 30_000, 100)
    const key = new URLSearchParams(new URL(link.url).hash.slice(1)).get('key')!
    const cipher = recipientHandshake(ephemeral, SHARER.machineId, link.id, key, welcome.payload as Record<string, unknown>)
    relay.injectDown(SHARER.machineId, observer, { type: 'observer_frame', payload: cipher.seal({ type: 'terminal_open', payload: { protocolVersion: 3, agentId: agent.id, cols: 80, rows: 24, requestId: 'e2e-open' } }) as never })
    // Each sealed frame opens once, in order.
    const shown: Array<Record<string, any>> = []
    const read = () => {
      const frames = (relay.targeted.get(observer) ?? []).filter((frame) => frame.type === 'observer_frame')
      for (const frame of frames.slice(shown.length)) shown.push(cipher.open(frame.payload) ?? { type: 'unopened' })
      return shown
    }
    const ready = await until('the terminal, read-only', () => read().find((frame) => frame.type === 'terminal_ready') ?? null, 30_000, 100)
    expect(ready.payload).toMatchObject({ requestId: 'e2e-open', agentId: agent.id, readOnly: true })
    await until('its bytes', () => read().some((frame) => frame.type === 'observer_binary') || null, 30_000, 100)
    expect(shown.map((frame) => frame.type)).not.toContain('unopened')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a saved link turns Share on as the daemon starts', async () => {
    const { d } = await sharer((daemon) => writeFileSync(join(daemon.dataDir, 'harness-collaboration.json'), JSON.stringify({ links: [], comments: [] }), { mode: 0o600 }))
    await until('Share to start for its saved links', () => d.log().includes('[services] sharing connected') || null, 30_000, 200)
    expect(sharingStarts(d)).toBe(1)
  })
})
