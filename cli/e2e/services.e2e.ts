/**
 * A failing service never takes the core down (core/serviceHost.ts), proven on the real daemon: every
 * service made to fail as it starts, and services made to fail on every call, while a client starts an
 * agent, the agent binds, messages become turns that start and end, and the daemon restarts.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents)
    .find((agent) => agent.id === agentId)

/** Start a Claude Code agent and wait for it to bind its conversation. */
async function boundAgent(daemon: IsolatedDaemon, client: LocalClient, name: string): Promise<string> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  await until('the agent to bind its conversation', async () => (await row(client, agentId))?.sessionId || null, 45_000, 500)
  return agentId
}

/** One message, one turn: it starts and it ends. */
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const isTurn = (type: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
  const started = client.next(isTurn('turn_started'), 30_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended'), 30_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

describe('a failing service never takes the core down', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('with every service failing to start, the core starts, runs an agent through turns and a restart, and says each service is off', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'search,viewers,models,workspaces,store' } })
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-80).join('\n')}`) })
    await daemon.start()
    for (const service of ['search', 'viewers', 'models', 'workspaces', 'store']) {
      expect(daemon.log()).toContain(`[services] ${service} did not start · injected fault: ${service} · the core runs without it`)
    }
    const client = await LocalClient.connect(daemon)
    const agentId = await boundAgent(daemon, client, 'no-services')
    await turn(client, agentId, 'first, with no services')
    // Off, never UNSUPPORTED: the apps read that as "update the CLI".
    expect(await client.request('session_search', { query: 'first' })).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: false })
    for (const type of ['dsh_list', 'dsh_install', 'dsh_update', 'dsh_remove']) {
      expect(await client.request(type, { id: 'acme/thing' }), type).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'store', retryable: false })
    }

    await daemon.restart()
    const again = await LocalClient.connect(daemon)
    await until('the agent to be back after a restart', async () => {
      const agent = await row(again, agentId)
      return agent?.sessionId && agent.status !== 'stopped' ? agent : null
    }, 45_000, 250)
    await turn(again, agentId, 'second, after a restart')
    again.close()
    client.close()
  })

  it('with services failing on every call, they are switched off and every turn still reaches the client', async () => {
    daemon = await IsolatedDaemon.create({
      env: { HARNESSD_TEST_FAULTS: 'search.touch,search.session_search,viewers.frameContext,viewers.attach,workspaces.nameBranches' },
    })
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-120).join('\n')}`) })
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    const agentId = await boundAgent(daemon, client, 'failing-services')

    // Each turn calls search at its start and its end: the fifth failure switches search off, and the
    // turns after it are delivered exactly as the ones before.
    for (let i = 1; i <= 4; i++) await turn(client, agentId, `turn ${i}`)
    await until('search to be switched off', () => daemon!.log().includes('[services] search switched off after 5 failures'), 15_000)
    await until('the viewers to be switched off', () => daemon!.log().includes('[services] viewers switched off after 5 failures'), 15_000)
    expect(daemon.log()).toContain('[services] search.touch failed · injected fault: search.touch')
    expect(daemon.log()).toContain('[services] viewers.frameContext failed · injected fault: viewers.frameContext')

    // Off, search says so; the agent's row still carries everything the core owns.
    expect(await client.request('session_search', { query: 'turn' })).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'search' })
    const agent = await row(client, agentId)
    expect(agent?.sessionId).toBeTruthy()
    expect(agent?.status).not.toBe('stopped')
    await turn(client, agentId, 'after search went off')

    // One core all along: nothing failing in a service restarted it.
    expect(daemon.coresStarted()).toBe(1)
    client.close()
  })

  it('with the teams failing on every call, or not starting at all, messages are written and every turn reaches the client', async () => {
    for (const faults of ['teams.prepare,teams.started,teams.raw,teams.forget', 'teams']) {
      daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: faults } })
      const d = daemon
      onTestFailed(() => { console.log(`---- daemon log (${faults})\n${d.log().split('\n').slice(-80).join('\n')}`) })
      await d.start()
      const client = await LocalClient.connect(d)
      const agentId = await boundAgent(d, client, `teams-${faults.length}`)
      for (let i = 1; i <= 3; i++) await turn(client, agentId, `with the teams failing ${i}`)
      expect(d.log()).toContain(faults === 'teams' ? '[services] teams did not start' : '[services] teams.prepare failed')
      expect(d.coresStarted()).toBe(1)
      client.close()
      await d.close()
      daemon = undefined
    }
  })

  it('a search request that fails before search is switched off answers that request, and the next one too', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'search.session_search' } })
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-80).join('\n')}`) })
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    const answers = []
    for (let i = 0; i < 6; i++) answers.push(await client.request('session_search', { query: `ask ${i}` }))
    // Each failure answers its own request; the fifth switches search off, and from then on the
    // request says search is off. Its other request, and the core's, go on.
    expect(answers.slice(0, 5)).toEqual(Array(5).fill(expect.objectContaining({ error: 'SERVICE_FAILED', service: 'search' })))
    expect(answers[5]).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: false })
    expect(daemon.log()).toContain('[services] search.session_search failed · injected fault: search.session_search')
    expect((await client.request('agents_list', {})).agents).toEqual([])
    client.close()
  })

  it('the store answers from its own service; one of its requests failing leaves its others and the core alone', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'store.dsh_list' } })
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-80).join('\n')}`) })
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    expect(await client.request('dsh_list', {})).toMatchObject({ error: 'SERVICE_FAILED', service: 'store' })
    // Its other requests are still the store's own answers, refusals included.
    expect(await client.request('dsh_remove', { id: '../../etc' })).toMatchObject({ error: 'INVALID_DSH', detail: 'dsh_remove needs an id' })
    expect(await client.request('dsh_install', { url: 'https://example.com/\n' })).toMatchObject({ error: 'INVALID_DSH' })
    const agentId = await boundAgent(daemon, client, 'store-failing')
    await turn(client, agentId, 'with the store failing')
    expect(daemon.coresStarted()).toBe(1)
    client.close()
  })

  it('the store lists what is installed here and what the registry offers', async () => {
    daemon = await IsolatedDaemon.create()
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    const listed = await client.request('dsh_list', {}, 60_000)
    expect(listed.error, JSON.stringify(listed).slice(0, 400)).toBeUndefined()
    expect(Array.isArray(listed.dsh)).toBe(true)
    client.close()
  })
})
