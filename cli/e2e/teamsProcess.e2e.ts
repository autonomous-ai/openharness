/**
 * The teams' prompt scopes in their own process, on the real daemon (`HARNESSD_SERVICES=teams`, here also
 * with search and the viewers). A message written from a tab belongs to that tab's team once its engine
 * takes it; the scopes work that out in their own process, and the team features read it back through the
 * core. Whatever happens to the process costs teams alone. Stopped, hung, killed or crashing on every start:
 * - every message is still written, and agents keep working;
 * - a scope that is not known for sure reads as no team, never a wrong one;
 * - a change made meanwhile reaches the process once it is back, applied once.
 * A core that restarts starts the scopes over, as it always did.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { channelTeamId } from '../src/teams/service.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

/** The teams process the master runs now: the last one it said it started. Read from its log, never
 *  from the process table, where another daemon's services could be. */
const teamsPid = (d: IsolatedDaemon): number | null => {
  const started = [...d.log().matchAll(/\[harnessd\] service teams started \(pid (\d+)\)/g)]
  return started.length ? Number(started[started.length - 1][1]) : null
}
const restarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service teams started .* restart \d+/g)].length
const connected = (d: IsolatedDaemon) => d.log().split('[services] teams connected').length - 1
const ready = (d: IsolatedDaemon) => [...d.log().matchAll(/\[cli\] ready/g)].length

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
/** A message written to the agent, from a tab or not, and its turn taken. */
async function say(client: LocalClient, agentId: string, content: string, tabId?: string): Promise<void> {
  const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content, ...(tabId ? { tabId } : {}) })
  await ended
}
/** The team the agent's current prompt came from, as a team member asks it. */
const scopeOf = async (client: LocalClient, agentId: string): Promise<string | null> => {
  const answer = await client.request('team_delivery', { action: 'prompt_scope', agentId }, 30_000)
  expect(answer.error, JSON.stringify(answer)).toBeUndefined()
  return answer.teamId ?? null
}
const scopeBecomes = (client: LocalClient, agentId: string, teamId: string | null, what: string) =>
  until(what, async () => (await scopeOf(client, agentId)) === teamId || null, 30_000, 200)

describe('the teams\' prompt scopes in their own process', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}, waitForTeams = true) => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICES: 'teams',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    if (waitForTeams) await until('teams to connect to the core', () => connected(d) >= 1 || null, 30_000, 100)
    return d
  }

  it('with HARNESSD_SERVICES=none the scopes stay in the core\'s process, as before', async () => {
    const d = await fresh({ HARNESSD_SERVICES: 'none' }, false)
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'scopes-default')
    await say(client, agent.id, 'hello from the alpha tab', 'tab-alpha')
    expect(await scopeOf(client, agent.id)).toBe(channelTeamId('tab-alpha'))
    await say(client, agent.id, 'hello from nowhere in particular')
    expect(await scopeOf(client, agent.id)).toBeNull()
    expect(teamsPid(d)).toBeNull()
    client.close()
  })

  it('stopped, it costs no message its write; the scope reads as no team, and the change made meanwhile lands once it resumes', async () => {
    const d = await fresh({ HARNESSD_SERVICES: 'search,viewers,teams' })
    for (const service of ['search', 'viewers']) {
      await until(`${service} to connect to the core`, () => d.log().includes(`[services] ${service} connected`) || null, 30_000, 200)
    }
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'scopes-stopped')
    await say(client, agent.id, 'hello from the alpha tab', 'tab-alpha')
    await scopeBecomes(client, agent.id, channelTeamId('tab-alpha'), 'the alpha team, through the teams process')
    const pid = teamsPid(d)!
    process.kill(pid, 'SIGSTOP')
    try {
      await say(client, agent.id, 'hello from the beta tab', 'tab-beta')
      // Not yet known for sure: no team, never the alpha team it had.
      expect(await scopeOf(client, agent.id)).toBeNull()
    } finally {
      process.kill(pid, 'SIGCONT')
    }
    // The beta message's write and start were made while it was stopped; applied twice, they would match
    // nothing (two equal pending messages read as no team).
    await scopeBecomes(client, agent.id, channelTeamId('tab-beta'), 'the beta team, once the process resumes')
    expect(restarts(d)).toBe(0)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('hung, it is killed at the heartbeat watch and started again; the message written meanwhile keeps its team', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'scopes-hung', 'codex')
    await say(client, agent.id, 'hello from the alpha tab', 'tab-alpha')
    await scopeBecomes(client, agent.id, channelTeamId('tab-alpha'), 'the alpha team')
    const first = teamsPid(d)!
    process.kill(first, 'SIGSTOP')
    await say(client, agent.id, 'hello from the beta tab', 'tab-beta')
    await until('the master to find teams hung', () => d.log().includes('[harnessd] service teams sent no heartbeat') || null, 30_000, 200)
    await until('teams to be started again', () => restarts(d) >= 1 && connected(d) >= 2 || null, 30_000, 200)
    expect(teamsPid(d)).not.toBe(first)
    // Lost with the hung process, kept by the core, and given to the new one.
    await scopeBecomes(client, agent.id, channelTeamId('tab-beta'), 'the beta team, from the new process')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('killed outright, messages are written while it is down; what it is told then lands once, and what it knew goes', async () => {
    // Kept down for thirty seconds: the reads below must happen while it is, however loaded the machine.
    const d = await fresh({ HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '30000' })
    const client = await LocalClient.connect(d)
    const [moving, still] = [await create(d, client, 'scopes-moving'), await create(d, client, 'scopes-still')]
    await say(client, moving.id, 'hello from the alpha tab', 'tab-alpha')
    await say(client, still.id, 'hello from the gamma tab', 'tab-gamma')
    // A message's prompt hook can be heard after its turn: the hook gives the daemon 500 ms and the engine
    // goes on (hook/notify.mjs). A start still on its way to the teams process when it dies is a change on
    // its way, and its scope rightly reads as no team. The claim below is about a scope with nothing on its
    // way, so both hooks are heard and delivered first.
    for (const agent of [moving, still]) {
      const sid = agent.sessionId.slice(0, 8)
      await until(`${sid}'s prompt hook to be heard`, () => d.log().includes(`[hooks] ${sid} UserPromptSubmit `) || null, 30_000, 100)
    }
    await scopeBecomes(client, still.id, channelTeamId('tab-gamma'), 'the gamma team')
    await scopeBecomes(client, moving.id, channelTeamId('tab-alpha'), 'the alpha team')
    process.kill(teamsPid(d)!, 'SIGKILL')
    await until('the master to see teams gone', () => d.log().includes('[harnessd] service teams exited') || null, 30_000, 100)
    await say(client, moving.id, 'hello from the beta tab', 'tab-beta')
    // Down: a scope with a change on its way reads as no team; one without, as it last was.
    expect(await scopeOf(client, moving.id)).toBeNull()
    expect(await scopeOf(client, still.id)).toBe(channelTeamId('tab-gamma'))
    expect(restarts(d), 'read while teams was still down').toBe(0)
    await until('teams to be back', () => restarts(d) >= 1 && connected(d) >= 2 || null, 60_000, 200)
    await scopeBecomes(client, moving.id, channelTeamId('tab-beta'), 'the beta team, from the new process')
    // What only the old process knew went with it: no team, not the gamma team.
    await scopeBecomes(client, still.id, null, 'the old process\'s scope to be gone')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('crashing on every start, it is parked; every message is still written, and reads as no team', async () => {
    const d = await fresh({ HARNESSD_TEST_FAULTS: 'teams.crash', HARNESSD_SERVICE_PARK_CRASHES: '3' }, false)
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'scopes-parked')
    await until('the master to park teams', () => d.log().includes('[harnessd] service teams ended 3 times') || null, 60_000, 250)
    await say(client, agent.id, 'hello from the alpha tab', 'tab-alpha')
    await say(client, agent.id, 'and once more', 'tab-alpha')
    expect(await scopeOf(client, agent.id)).toBeNull()
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a core that restarts leaves the teams process running, and the scopes start over with it, as they always did', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, 'scopes-core')
    await say(client, agent.id, 'hello from the alpha tab', 'tab-alpha')
    await scopeBecomes(client, agent.id, channelTeamId('tab-alpha'), 'the alpha team')
    const teams = teamsPid(d)
    const wired = ready(d)
    process.kill(d.corePid()!, 'SIGKILL')
    await until('a new core to finish starting', () => ready(d) > wired || null, 60_000, 200)
    await until('teams to reach the new core', () => connected(d) >= 2 || null, 30_000, 200)
    client.close()
    client = await LocalClient.connect(d)
    await until('the agent to be live again', async () => (await row(client, agent.id))?.status === 'active' || null, 60_000, 250)
    expect(await scopeOf(client, agent.id)).toBeNull()
    await say(client, agent.id, 'hello from the delta tab', 'tab-delta')
    await scopeBecomes(client, agent.id, channelTeamId('tab-delta'), 'the delta team, with the new core')
    expect(teamsPid(d)).toBe(teams)
    expect(restarts(d)).toBe(0)
    client.close()
  })
})
