/**
 * A failing service never takes the core down, proven on the real daemon: every service made to fail as
 * it starts, and services made to fail on every call, while a client starts an agent, the agent binds,
 * messages become turns that start and end, and the daemon restarts. Both ways a service runs: in a
 * process of its own (the default for search, the viewers with the Store, the teams, models and the edge
 * host's workspaces, usage, monitor and project readers, harnessd/services.ts), and inside the core's
 * process (`HARNESSD_SERVICES=none`, and always for the fleet), where the core's host guards it
 * (core/serviceHost.ts).
 */
import { randomUUID } from 'node:crypto'
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

/** ⌘K's pick for a typed task: `route_task` answers as `route_result`, under the asker's request id. */
async function routeTask(client: LocalClient, text: string): Promise<Record<string, any>> {
  const requestId = randomUUID()
  const answered = client.next((frame) => frame.type === 'route_result' && frame.payload?.requestId === requestId, 30_000, 'route_result')
  client.send('route_task', { requestId, text })
  return (await answered).payload as Record<string, any>
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

/** Every service inside the core's process, where the core's host guards it. */
const IN_THE_CORE = { HARNESSD_SERVICES: 'none' }
/** A master quick to give up on a service that keeps failing as it starts. */
const QUICK_TO_PARK = { HARNESSD_SERVICE_PARK_CRASHES: '3', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000' }
/** The processes the services run in by default, and what makes every one of them fail as it starts. The
 *  experiments' (the teams', the orchestrator's) start only once they are on: e2e/experiments.e2e.ts. */
const SERVICE_PROCESSES = ['search', 'viewers', 'edge', 'models'] as const
const EVERY_PROCESS_FAILING = 'search,viewers,store,workspaces,usage,monitor,projects,models'

describe('a failing service never takes the core down', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('with every service failing to start, in its own process or in the core, the core starts, runs an agent through turns and a restart, and says each one is unavailable', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: EVERY_PROCESS_FAILING, ...QUICK_TO_PARK } })
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    // Each process fails as it starts, again and again, until the master parks it; the core never waits for one.
    for (const service of SERVICE_PROCESSES) {
      await until(`the master to park ${service}`, () => d.log().includes(`[harnessd] service ${service} ended 3 times`) || null, 60_000, 250)
    }
    const client = await LocalClient.connect(d)
    const agentId = await boundAgent(d, client, 'no-service-processes')
    await turn(client, agentId, 'first, with every service down')
    expect(await client.request('session_search', { query: 'first' })).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'search' })
    expect(await client.request('dsh_list', {})).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'store', retryable: true })
    expect(await client.request('fs_list_dir', { path: d.projectsDir })).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'projects', retryable: true })
    expect(await client.request('machine_resources', {})).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'monitor', retryable: true })
    expect(await client.request('grid_fleet_models_list', {})).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    // A create on a grid model, with models parked, is refused as the grid being unavailable, at once.
    const onGrid = await client.request('agent_create', { engine: 'codex', cwd: d.projectsDir, gridModel: 'Qwen-35B', gridName: 'mine', bypassPermission: true }, 30_000)
    expect(onGrid).toMatchObject({ error: 'GRID_UNAVAILABLE' })
    // With the monitor's process parked, the Monitor's list is still the list: its rows, without readings.
    const monitored = (await client.request('agents_list', { monitor: true })).agents.find((agent: Record<string, any>) => agent.id === agentId)
    expect(monitored.monitor).toMatchObject({ rssBytes: null, cpu: null, processes: [], sampledAt: null })
    expect(d.coresStarted()).toBe(1)

    await d.restart()
    const again = await LocalClient.connect(d)
    await until('the agent to be back after a restart', async () => {
      const agent = await row(again, agentId)
      return agent?.sessionId && agent.status !== 'stopped' ? agent : null
    }, 45_000, 250)
    await turn(again, agentId, 'second, after a restart')
    again.close()
    client.close()
  })

  it('with services in their own processes failing on every request and event, each request is answered failed, every turn reaches the client, and nothing restarts', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'search.touch,search.session_search,workspaces.nameBranches,workspaces.sweep,monitor.resources,projects.fs_list_dir' } })
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const agentId = await boundAgent(d, client, 'failing-processes')
    for (let i = 1; i <= 4; i++) await turn(client, agentId, `turn ${i}`)
    // (The viewers hear only of agents that have a viewer: e2e/viewersProcess.e2e.ts runs one.)
    // In its own process a failing service costs only what failed: nothing is switched off, and each
    // request is answered for itself, as often as it is asked.
    for (let i = 0; i < 6; i++) {
      expect(await client.request('session_search', { query: `ask ${i}` }), `ask ${i}`).toMatchObject({ error: 'SERVICE_FAILED', service: 'search' })
      expect(await client.request('fs_list_dir', { path: d.projectsDir }), `list ${i}`).toMatchObject({ error: 'SERVICE_FAILED', service: 'projects' })
      // The core's own call into the monitor's process fails each time, and the list is its rows without readings.
      const monitored = (await client.request('agents_list', { monitor: true })).agents.find((agent: Record<string, any>) => agent.id === agentId)
      expect(monitored.monitor, `monitor ${i}`).toMatchObject({ rssBytes: null, cpu: null, processes: [], sampledAt: null })
    }
    // The edge host's other answers are its own: one reader failing costs that reader.
    expect(await client.request('project_preview', { path: '/no/such/folder' })).not.toHaveProperty('service')
    expect(await client.request('machine_resources', {})).not.toHaveProperty('error')
    for (const line of [
      '[service search] touch failed · injected fault: search.touch',
      '[service search] session_search failed · injected fault: search.session_search',
      '[service workspaces] nameBranches failed · injected fault: workspaces.nameBranches',
    ]) await until(line, () => d.log().includes(line) || null, 15_000, 250)
    const agent = await row(client, agentId)
    expect(agent?.sessionId).toBeTruthy()
    expect(agent?.status).not.toBe('stopped')
    await turn(client, agentId, 'after six failed searches')
    expect(d.log()).not.toMatch(/\[harnessd\] service \w+ started .* restart \d+/)
    expect(d.log()).not.toContain('switched off')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('with every service in the core failing to start, the core starts, runs an agent through turns and a restart, and says each service is off', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'search,viewers,models,workspaces,store,usage,monitor,projects', ...IN_THE_CORE } })
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-80).join('\n')}`) })
    await daemon.start()
    for (const service of ['search', 'viewers', 'models', 'workspaces', 'store', 'usage', 'monitor', 'projects']) {
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
    for (const type of ['grid_models_list', 'models_list', 'grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop',
      'grid_fleet_run', 'grid_fleet_cancel', 'api_connections', 'codex_profiles_list', 'codex_profile_link']) {
      expect(await client.request(type, { modelId: 'org/Model-GGUF' }), type).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: false })
    }
    // The services that came out of the socket's switch (docs/design/2026-10-06-core-boundary-next.md, step 4).
    // usage_read is asked only here, with its service off: on, it reads the vendors' credentials.
    expect(await client.request('usage_read', {})).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'usage', retryable: false })
    expect(await client.request('machine_resources', {})).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'monitor', retryable: false })
    for (const type of ['git_pull_request', 'git_project_info', 'project_preview', 'fs_list_dir', 'agent_read_file']) {
      expect(await client.request(type, { agentId, path: daemon.projectsDir }), type).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'projects', retryable: false })
    }
    // With the monitor off, the Monitor's list is still the list: its rows, without readings.
    const monitored = (await client.request('agents_list', { monitor: true })).agents.find((agent: Record<string, any>) => agent.id === agentId)
    expect(monitored.monitor).toMatchObject({ rssBytes: null, cpu: null, processes: [] })
    // The Model Manager's grid commands' handshake is still the socket's: models being off does not tell
    // the Grid harness to update Harness.
    expect(await client.request('grid_fleet_capabilities', {})).toMatchObject({ protocol: 1, thinkingControl: true })

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

  it('with services in the core failing on every call, they are switched off and every turn still reaches the client', async () => {
    daemon = await IsolatedDaemon.create({
      env: { HARNESSD_TEST_FAULTS: 'search.touch,search.session_search,viewers.frameContext,viewers.attach,workspaces.nameBranches', ...IN_THE_CORE },
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

  it('with the teams in the core failing on every call, or not starting at all, messages are written and every turn reaches the client', async () => {
    for (const faults of ['teams.prepare,teams.started,teams.raw,teams.forget', 'teams']) {
      daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: faults, ...IN_THE_CORE } })
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

  it('a search request that fails in the core before search is switched off answers that request, and the next one too', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'search.session_search', ...IN_THE_CORE } })
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
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    await d.start()
    // In the viewers' process: asked before it has connected, it is answered SERVICE_UNAVAILABLE, retryable.
    await until('the store to connect', () => d.log().includes('[services] store connected') || null, 30_000, 200)
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

  it('one service of the edge host failing to start leaves the others in it running, and the core', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'workspaces' } })
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    await d.start()
    for (const service of ['usage', 'monitor', 'projects']) {
      await until(`${service} to connect`, () => d.log().includes(`[services] ${service} connected`) || null, 30_000, 200)
    }
    expect(d.log()).toContain('[service workspaces] did not start · injected fault: workspaces')
    const client = await LocalClient.connect(d)
    const agentId = await boundAgent(d, client, 'edge-without-workspaces')
    expect((await client.request('fs_list_dir', {})).error).toBeUndefined()
    expect(await client.request('machine_resources', {})).not.toHaveProperty('error')
    // The core's own call into the monitor's process: the Monitor's rows carry their sample.
    const monitored = (await client.request('agents_list', { monitor: true })).agents.find((agent: Record<string, any>) => agent.id === agentId)
    expect(monitored.monitor.sampledAt).toEqual(expect.any(String))
    await turn(client, agentId, 'with workspaces off in the edge host')
    expect(d.log()).not.toMatch(/\[harnessd\] service edge (exited|ended)/)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('the monitor\'s readings failing on every call in the core leave the list its rows, then switch the monitor off; the core runs on', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'monitor.resources,projects.fs_list_dir', ...IN_THE_CORE } })
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-80).join('\n')}`) })
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    const agentId = await boundAgent(daemon, client, 'monitor-failing')
    // Each failed sample is a row without readings, as a failed `ps` always was; five in a minute switch it off.
    for (let i = 0; i < 6; i++) {
      const listed = (await client.request('agents_list', { monitor: true })).agents.find((agent: Record<string, any>) => agent.id === agentId)
      expect(listed.monitor).toMatchObject({ rssBytes: null, cpu: null, processes: [] })
    }
    expect(daemon.log()).toContain('[services] monitor switched off after 5 failures')
    expect(await client.request('machine_resources', {})).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'monitor' })
    // One of the project readers failing leaves the others their own answers.
    expect(await client.request('fs_list_dir', {})).toMatchObject({ error: 'SERVICE_FAILED', service: 'projects' })
    expect(await client.request('project_preview', { path: '/no/such/folder' })).not.toHaveProperty('service')
    await turn(client, agentId, 'with the monitor off')
    expect(daemon.coresStarted()).toBe(1)
    client.close()
  })

  it('models answers from its own service; one of its requests failing leaves its others and the core alone', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'models.grid_models_list' } })
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    await d.start()
    // In its own process: asked before it has connected, it is answered SERVICE_UNAVAILABLE, retryable.
    await until('models to connect', () => d.log().includes('[services] models connected') || null, 30_000, 200)
    const client = await LocalClient.connect(daemon)
    expect(await client.request('grid_models_list', {})).toMatchObject({ error: 'SERVICE_FAILED', service: 'models' })
    expect(daemon.log()).toContain('[service models] grid_models_list failed · injected fault: models.grid_models_list')
    // Its other requests are still its own answers: with no agent here, no Model/Effort choices.
    expect(await client.request('models_list', {})).toMatchObject({ models: [] })
    expect(await client.request('grid_fleet_capabilities', {})).toMatchObject({ protocol: 1 })
    expect((await client.request('agents_list', {})).agents).toEqual([])
    expect(daemon.coresStarted()).toBe(1)
    client.close()
  })

  it('⌘K picks and delivers through the fleet, with the dial and the window bridges failing on every call', async () => {
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: 'dial,window' } })
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-80).join('\n')}`) })
    await daemon.start()
    const client = await LocalClient.connect(daemon)
    const agentId = await boundAgent(daemon, client, 'routed-by-cmd-k')
    // The only agent on this computer, picked without asking any model, on this computer's own id.
    expect(await routeTask(client, 'fix the parser')).toMatchObject({ agentId, machineId: daemon.computerId, confidence: 1, weighed: 1, machines: 1 })
    const isTurn = (type: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
    const started = client.next(isTurn('turn_started'), 30_000, 'turn_started (route_send)')
    const ended = client.next(isTurn('turn_ended'), 30_000, 'turn_ended (route_send)')
    expect(await client.request('route_send', { agentId, text: 'sent by cmd-k' })).toMatchObject({ ok: true })
    expect((await started).payload?.userMessage).toBe('sent by cmd-k')
    await ended
    expect(daemon.log()).toContain('[devices] dial failed · injected fault: dial')
    expect(daemon.coresStarted()).toBe(1)
    client.close()
  })

  it('with the fleet not starting, or failing on every call, ⌘K says so and the core runs its agents on', async () => {
    for (const [faults, reason, said] of [
      ['fleet', 'no agent list yet', '[devices] fleet did not start · injected fault: fleet · the devices run without it'],
      ['fleet.routeTask,fleet.routeSend', 'the fleet service is unavailable', '[devices] fleet.routeSend failed · injected fault: fleet.routeSend'],
    ]) {
      daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: faults } })
      const d = daemon
      onTestFailed(() => { console.log(`---- daemon log (${faults})\n${d.log().split('\n').slice(-80).join('\n')}`) })
      await d.start()
      const client = await LocalClient.connect(d)
      const agentId = await boundAgent(d, client, `fleet-${faults.length}`)
      expect(await routeTask(client, 'fix the parser')).toMatchObject({ agentId: '', reason, candidates: [] })
      expect(await client.request('route_send', { agentId, text: 'not delivered' })).toMatchObject({ ok: false, machine: '', reason })
      await turn(client, agentId, `the core runs on (${faults})`)
      expect(d.log()).toContain(said)
      expect(d.coresStarted()).toBe(1)
      client.close()
      await d.close()
      daemon = undefined
    }
  })

  it('with the devices not starting in the core\'s process, or the Devices tab failing, ⌘K and the tab say so and the core runs on', async () => {
    // In their own process this is e2e/devicesProcess.e2e.ts's crash loop; here, the service host's guard.
    for (const [faults, said] of [
      ['devices', '[services] devices did not start · injected fault: devices · the core runs without it'],
      ['devices.harness_devices_list', '[services] devices.harness_devices_list failed · injected fault: devices.harness_devices_list'],
    ]) {
      daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: faults, ...IN_THE_CORE } })
      const d = daemon
      onTestFailed(() => { console.log(`---- daemon log (${faults})\n${d.log().split('\n').slice(-80).join('\n')}`) })
      await d.start()
      const client = await LocalClient.connect(d)
      const agentId = await boundAgent(d, client, `devices-${faults.length}`)
      if (faults === 'devices') {
        // ⌘K has no router without the devices: it says so, and sends nothing.
        expect(await routeTask(client, 'fix the parser')).toMatchObject({ agentId: '', reason: 'the devices service is unavailable', candidates: [] })
        expect(await client.request('route_send', { agentId, text: 'not delivered' })).toMatchObject({ ok: false, reason: 'the devices service is unavailable' })
        expect(await client.request('harness_devices_list', {})).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'devices' })
      } else {
        expect(await client.request('harness_devices_list', {})).toMatchObject({ error: 'SERVICE_FAILED', service: 'devices' })
        // Its other request, and ⌘K, are the devices' own answers still.
        expect(await client.request('harness_device_settings', { id: 'dial-1', patch: { brightness: 3 } })).toMatchObject({ error: 'DEVICE_OFFLINE' })
        expect(await routeTask(client, 'fix the parser')).toMatchObject({ agentId, confidence: 1 })
      }
      await turn(client, agentId, `the core runs on (${faults})`)
      expect(d.log()).toContain(said)
      expect(d.coresStarted()).toBe(1)
      client.close()
      await d.close()
      daemon = undefined
    }
  })

  it('the store lists what is installed here and what the registry offers', async () => {
    daemon = await IsolatedDaemon.create()
    const d = daemon
    await d.start()
    await until('the store to connect', () => d.log().includes('[services] store connected') || null, 30_000, 200)
    const client = await LocalClient.connect(daemon)
    const listed = await client.request('dsh_list', {}, 60_000)
    expect(listed.error, JSON.stringify(listed).slice(0, 400)).toBeUndefined()
    expect(Array.isArray(listed.dsh)).toBe(true)
    client.close()
  })
})
