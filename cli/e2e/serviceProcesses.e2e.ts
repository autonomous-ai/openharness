/**
 * Services in their own processes, for Claude Code and Codex, on the real daemon: harnessd's master runs
 * search beside the core (`HARNESSD_SERVICES=search`), the edge host, one process for several light
 * services (`HARNESSD_SERVICES=edge`: workspaces, usage, the monitor and the project readers), and models
 * (`HARNESSD_SERVICES=models`: grid, the Model Manager, the pickers). Whatever happens to any of them —
 * killed outright, hung, leaking memory, crashing on every start — costs that process alone. The core
 * never restarts, every agent keeps working, a request asked while it is down is answered
 * SERVICE_UNAVAILABLE at once (a create on a grid model, GRID_UNAVAILABLE), and the master brings it back
 * (or parks it, when it keeps crashing), every service in it connected again.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
/**
 * This daemon's search service processes: titled `harnessd search` AND started by its own master, by
 * the pid the master logged. The title alone matched every daemon's search on the machine — another
 * file's in a parallel run, another checkout's — and the tests below stop and kill what it returns.
 */
function searchPids(d: IsolatedDaemon): number[] {
  const ours = new Set([...d.log().matchAll(/\[harnessd\] service search started \(pid (\d+)\)/g)].map((match) => Number(match[1])))
  const table = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
  return table.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, pid, command]) => command.trim() === 'harnessd-search' && ours.has(Number(pid))).map(([, pid]) => Number(pid))
}
const finds = async (client: LocalClient, word: string, sessionId: string): Promise<boolean> =>
  JSON.stringify(await client.request('session_search', { query: word }, 30_000)).includes(sessionId)

describe('services in their own processes', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICES: 'search',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }
  const restarts = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => /\[harnessd\] service search started .* restart \d+/.test(line)).length

  it('search runs in its own process and answers through the core, for both engines', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    await until('search to connect to the core', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    expect(searchPids(d).length).toBeGreaterThanOrEqual(1)
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, client, engine, `search-out-${engine}`)
      const word = `axolotl${engine}`
      await turn(client, agent.id, `about the ${word}`)
      await until(`search to find the ${engine} conversation`, () => finds(client, word, agent.sessionId) || null, 60_000, 1_000)
    }
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('search killed outright: asked meanwhile it says so at once, agents go on, and the master brings it back', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'search-killed')
    await turn(client, agent.id, 'remember the pangolin')
    await until('search to find it', () => finds(client, 'pangolin', agent.sessionId) || null, 60_000, 1_000)
    const before = searchPids(d)
    expect(before.length).toBeGreaterThanOrEqual(1)
    for (const pid of before) process.kill(pid, 'SIGKILL')
    // Asked while it is down: an answer, not a hang.
    const answer = await client.request('session_search', { query: 'pangolin' }, 10_000)
    if (answer.error) expect(answer).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
    // The agents never noticed.
    await turn(client, agent.id, 'while search was gone')
    await until('the master to restart search', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('search to answer again', () => finds(client, 'pangolin', agent.sessionId) || null, 60_000, 1_000)
    expect(searchPids(d).some((pid) => !before.includes(pid))).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a hung search is killed by the master\'s heartbeat watch and started again; the core goes on', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'search-hung')
    await until('search to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    // Hung: a stopped process neither beats nor answers, as one stuck in a loop would not.
    for (const pid of searchPids(d)) process.kill(pid, 'SIGSTOP')
    await until('the master to find search hung', () => d.log().includes('[harnessd] service search sent no heartbeat') || null, 30_000, 200)
    await until('search to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await turn(client, agent.id, 'the core never waited on search')
    const answer = await client.request('session_search', { query: 'anything' }, 40_000)
    expect(answer.error === undefined || answer.error === 'SERVICE_UNAVAILABLE', JSON.stringify(answer)).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a leaking search is restarted at its memory budget, before it can hurt anything else', async () => {
    const d = await fresh({ HARNESSD_TEST_FAULTS: 'search.leak', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '128' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'search-leaking')
    await until('the master to restart search for memory', () => /\[harnessd\] service search: (its heap is at|it is using)/.test(d.log()) || null, 60_000, 250)
    await until('search to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await turn(client, agent.id, 'the leak was search\'s alone')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a search that crashes on every start is parked, and asked meanwhile says so; agents go on', async () => {
    const d = await fresh({ HARNESSD_TEST_FAULTS: 'search.crash', HARNESSD_SERVICE_PARK_CRASHES: '3' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'search-crash-loop')
    await until('the master to park search', () => d.log().includes('[harnessd] service search ended 3 times') || null, 60_000, 250)
    expect(await client.request('session_search', { query: 'anything' }, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
    await turn(client, agent.id, 'search is parked and nothing else cares')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a purge while search is down is not forgotten: search forgets the conversation once it is back', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'purge-while-down')
    await turn(client, agent.id, 'remember the quokka')
    await until('search to find it', () => finds(client, 'quokka', agent.sessionId) || null, 60_000, 1_000)
    // Down: killed, and the purge happens before the master has it back.
    for (const pid of searchPids(d)) process.kill(pid, 'SIGSTOP')
    const createdAt = Date.parse(agent.createdAt)
    const review = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'inspect' }, 60_000)
    for (const pid of searchPids(d)) process.kill(pid, 'SIGKILL')
    const deleted = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'delete', reviewId: review.reviewId }, 90_000)
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ deleted: true })
    await until('search to be back', () => restarts(d) >= 1 && d.log().split('[services] search connected').length >= 3 || null, 60_000, 250)
    await until('search to have forgotten it', async () => !(await finds(client, 'quokka', agent.sessionId)) || null, 30_000, 1_000)
    client.close()
  })
})

/** This daemon's edge host: titled `harnessd-edge` AND started by its own master, by the pid it logged. */
function edgePids(d: IsolatedDaemon): number[] {
  const ours = new Set([...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)].map((match) => Number(match[1])))
  const table = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
  return table.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, pid, command]) => command.trim() === 'harnessd-edge' && ours.has(Number(pid))).map(([, pid]) => Number(pid))
}
/** The services the edge host runs, each on its own link to the core. */
const EDGE = ['workspaces', 'usage', 'monitor', 'projects', 'handoff', 'recaps']
/** How many times each of the edge host's services has connected to the core. */
const edgeConnections = (d: IsolatedDaemon): number => Math.min(...EDGE.map((service) => d.log().split(`[services] ${service} connected`).length - 1))
/** The edge host answers, through the core: the home folder's subfolders, and the machine's own totals. */
async function edgeAnswers(client: LocalClient): Promise<boolean> {
  const listed = await client.request('fs_list_dir', {}, 30_000)
  const machine = await client.request('machine_resources', {}, 30_000)
  return listed.error === undefined && machine.error === undefined
}
/** Asked while the edge host is down: an answer at once, not a hang, and the Monitor's list still lists. */
async function edgeDown(client: LocalClient, agentId: string): Promise<void> {
  const listed = await client.request('fs_list_dir', {}, 40_000)
  if (listed.error) expect(listed).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'projects', retryable: true })
  const row = (await client.request('agents_list', { monitor: true }, 40_000)).agents.find((agent: Record<string, any>) => agent.id === agentId)
  expect(row?.monitor).toBeDefined()
}

describe('the edge host: several services in one process of their own', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}) => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICES: 'edge',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }
  const restarts = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => /\[harnessd\] service edge started .* restart \d+/.test(line)).length

  it('runs its services in one process, each on its own link, and answers through the core for both engines', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    await until('every edge service to connect to the core', () => edgeConnections(d) >= 1 || null, 30_000, 200)
    expect(edgePids(d)).toHaveLength(1)
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, client, engine, `edge-${engine}`)
      await turn(client, agent.id, `with the edge host (${engine})`)
      // The Monitor's rows carry the sample the core asked the monitor's process for.
      const row = (await client.request('agents_list', { monitor: true }, 30_000)).agents.find((one: Record<string, any>) => one.id === agent.id)
      expect(row.monitor.sampledAt).toEqual(expect.any(String))
      expect(await client.request('git_project_info', { path: join(d.projectsDir, `edge-${engine}`) }, 30_000)).not.toHaveProperty('service')
    }
    expect(await edgeAnswers(client)).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('killed outright: asked meanwhile it says so at once, agents go on, and the master brings it back with every service', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'edge-killed')
    await until('every edge service to connect', () => edgeConnections(d) >= 1 || null, 30_000, 200)
    const before = edgePids(d)
    expect(before).toHaveLength(1)
    for (const pid of before) process.kill(pid, 'SIGKILL')
    await edgeDown(client, agent.id)
    await turn(client, agent.id, 'while the edge host was gone')
    await until('the master to restart the edge host', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('every edge service to connect again', () => edgeConnections(d) >= 2 || null, 30_000, 200)
    await until('the edge host to answer again', () => edgeAnswers(client).then((ok) => ok || null), 30_000, 500)
    expect(edgePids(d).some((pid) => !before.includes(pid))).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('hung, it is killed by the master\'s heartbeat watch and started again; the core goes on', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'edge-hung')
    await until('every edge service to connect', () => edgeConnections(d) >= 1 || null, 30_000, 200)
    for (const pid of edgePids(d)) process.kill(pid, 'SIGSTOP')
    // Asked while it is stopped: answered when the link gives up on it or the master kills it, never a hang.
    await edgeDown(client, agent.id)
    await until('the master to find the edge host hung', () => d.log().includes('[harnessd] service edge sent no heartbeat') || null, 30_000, 200)
    await until('the edge host to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await turn(client, agent.id, 'the core never waited on the edge host')
    await until('the edge host to answer again', () => edgeAnswers(client).then((ok) => ok || null), 30_000, 500)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('leaking, it is restarted at its memory budget, before it can hurt anything else', async () => {
    const d = await fresh({ HARNESSD_TEST_FAULTS: 'edge.leak', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '128' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'edge-leaking')
    await until('the master to restart the edge host for memory', () => /\[harnessd\] service edge: (its heap is at|it is using)/.test(d.log()) || null, 60_000, 250)
    await until('the edge host to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await turn(client, agent.id, 'the leak was the edge host\'s alone')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('crashing on every start, it is parked, and asked meanwhile says so; agents go on', async () => {
    const d = await fresh({ HARNESSD_TEST_FAULTS: 'edge.crash', HARNESSD_SERVICE_PARK_CRASHES: '3' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'edge-crash-loop')
    await until('the master to park the edge host', () => d.log().includes('[harnessd] service edge ended 3 times') || null, 60_000, 250)
    expect(await client.request('fs_list_dir', {}, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'projects', retryable: true })
    expect(await client.request('machine_resources', {}, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'monitor', retryable: true })
    const row = (await client.request('agents_list', { monitor: true }, 30_000)).agents.find((one: Record<string, any>) => one.id === agent.id)
    expect(row.monitor).toMatchObject({ rssBytes: null, cpu: null, processes: [], sampledAt: null })
    await turn(client, agent.id, 'the edge host is parked and nothing else cares')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})

/** This daemon's models process: titled `harnessd-models` AND started by its own master, by the pid it logged. */
function modelsPids(d: IsolatedDaemon): number[] {
  const ours = new Set([...d.log().matchAll(/\[harnessd\] service models started \(pid (\d+)\)/g)].map((match) => Number(match[1])))
  const table = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
  return table.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, pid, command]) => command.trim() === 'harnessd-models' && ours.has(Number(pid))).map(([, pid]) => Number(pid))
}
/** A create on a grid the desktop already resolved (`grid`), bound to its conversation like any other. */
async function createOn(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string, grid: Record<string, unknown>): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, grid, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}
/** A create on a grid model: what the models picker sends, a model and the grid serving it. */
const createOnGrid = (client: LocalClient, d: IsolatedDaemon): Promise<Record<string, any>> =>
  client.request('agent_create', { engine: 'codex', cwd: join(d.projectsDir, 'on-a-grid'), gridModel: 'Qwen3-Coder-30B', gridName: 'mine', bypassPermission: true }, 30_000)
/** Models answers, through the core: the Model Manager's list, signed out, says to sign in. */
async function modelsAnswers(client: LocalClient): Promise<boolean> {
  const manager = await client.request('grid_fleet_models_list', {}, 30_000)
  return manager.error === undefined && Array.isArray(manager.models)
}

describe('models in its own process', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}, preserveProcessArgs = false) => {
    const d = await IsolatedDaemon.create({ preserveProcessArgs, env: {
      HARNESSD_SERVICES: 'models',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      // No `grid` on this machine as far as the daemon can tell: never the developer's own.
      HARNESS_GRID_BIN: '/nonexistent/harness-e2e/grid',
      ...env,
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    await until('models to connect to the core', () => d.log().includes('[services] models connected') || null, 30_000, 200)
    return d
  }
  const restarts = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => /\[harnessd\] service models started .* restart \d+/.test(line)).length

  it('answers the pickers, the Model Manager and its grid commands through the core, and each agent\'s Model/Effort choices, for both engines', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    expect(modelsPids(d)).toHaveLength(1)
    expect(await client.request('grid_models_list', {}, 30_000)).toMatchObject({ gridName: null, models: [], grids: [], gridCli: 'missing' })
    expect(await client.request('grid_fleet_models_list', {}, 30_000)).toMatchObject({ models: [], notice: 'Sign in to find models for this computer.' })
    // The commands' handshake is the core's own; the command runs in models' process, as this connection's job.
    expect(await client.request('grid_fleet_capabilities', {})).toMatchObject({ protocol: 1, gridCli: 'missing' })
    expect(await client.request('grid_fleet_run', { args: ['--remote', 'ls', '--json'], timeoutMs: 5_000 }, 30_000))
      .toMatchObject({ ok: false, code: 127, error: 'Grid could not start on this machine. Check its Grid installation.' })
    expect(await client.request('grid_fleet_run', { args: [] }, 30_000)).toMatchObject({ error: 'INVALID_GRID_COMMAND' })
    expect(await client.request('grid_fleet_cancel', { commandId: 'not-running' }, 30_000)).toMatchObject({ cancelled: false })
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, client, engine, `models-${engine}`)
      await turn(client, agent.id, `with models apart (${engine})`)
      const offered = await client.request('models_list', { agentId: agent.id }, 30_000)
      expect(offered.error, JSON.stringify(offered)).toBeUndefined()
      expect(Array.isArray(offered.models)).toBe(true)
    }
    // A create on a grid model that this machine's grid does not serve is refused, as in the core's process.
    expect(await createOnGrid(client, d)).toMatchObject({ error: 'GRID_UNAVAILABLE' })
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('killed outright: the Model Manager says so at once, a create on a grid model answers GRID_UNAVAILABLE, every agent goes on, and the master brings it back', async () => {
    // Slow to come back, so what is asked meanwhile finds it down.
    const d = await fresh({ HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '8000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '8000' })
    const client = await LocalClient.connect(d)
    const agents = [await create(d, client, 'claude', 'models-killed-claude'), await create(d, client, 'codex', 'models-killed-codex')]
    const before = modelsPids(d)
    expect(before).toHaveLength(1)
    for (const pid of before) process.kill(pid, 'SIGKILL')
    await until('the core to see models gone', () => d.log().includes('[services] models disconnected') || null, 15_000, 100)
    const asked = Date.now()
    expect(await client.request('grid_fleet_models_list', {}, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    expect(await client.request('grid_models_list', {}, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    expect(await createOnGrid(client, d)).toMatchObject({ error: 'GRID_UNAVAILABLE' })
    expect(Date.now() - asked).toBeLessThan(5_000)
    // The agents never noticed, and their rows are as they were.
    for (const agent of agents) await turn(client, agent.id, `while models was gone (${agent.engine})`)
    expect((await client.request('agents_list', {}, 30_000)).agents.map((one: Record<string, any>) => one.id).sort()).toEqual(agents.map((one) => one.id).sort())
    await until('the master to restart models', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('models to answer again', () => modelsAnswers(client).then((ok) => ok || null), 30_000, 500)
    expect(modelsPids(d).some((pid) => !before.includes(pid))).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('models killed during discovery: existing assignments stay, new marked processes bind without waiting, and later learn their grid', async () => {
    const holdDir = mkdtempSync(join(tmpdir(), 'assignment-hold-'))
    const hold = join(holdDir, 'hold')
    try {
      const d = await fresh({ HARNESSD_TEST_HOLD_CONNECT: `models:${hold}` }, true)
      const client = await LocalClient.connect(d)
      const grid = { networkId: 'assignment-e2e', networkName: 'Assignment', baseUrl: 'https://fixture.invalid/g/assignment/relay/v1', apiKey: 'fixture-key', model: 'Small-Q4' }
      const known = await createOn(d, client, 'claude', 'assignment-known', grid)
      const knownAssignment = { baseUrl: grid.baseUrl.replace(/\/v1$/, ''), model: grid.model }
      await until('the existing Claude assignment to reflect its real endpoint', async () => {
        const now = await row(client, known.id)
        return now?.grid?.baseUrl === knownAssignment.baseUrl ? now : null
      }, 15_000, 200)
      writeFileSync(hold, '')
      for (const pid of modelsPids(d)) process.kill(pid, 'SIGKILL')
      await until('models disconnected', () => d.log().includes('[services] models disconnected') || null, 15_000, 100)
      const discovered: Array<Record<string, any>> = []
      for (const engine of ['claude', 'codex'] as const) {
        const cwd = join(d.projectsDir, `assignment-external-${engine}`)
        mkdirSync(cwd)
        const environment = ['HOME', 'ZDOTDIR', 'PATH', 'CLAUDE_PATH', 'CODEX_PATH', 'CODEX_HOME', 'CLAUDE_PROJECTS_DIR', 'ADAPTER_DATA_DIR', 'PORT']
          .flatMap(name => ['-e', `${name}=${d.env[name]}`])
        if (engine === 'claude') environment.push('-e', `ANTHROPIC_BASE_URL=${grid.baseUrl}`, '-e', `ANTHROPIC_MODEL=${grid.model}`)
        const args = engine === 'codex' ? ['-c', `model_providers.grid.base_url="${grid.baseUrl}"`, '-m', grid.model] : []
        const asked = Date.now()
        const tile = await client.request('agent_create', { engine: 'terminal', cwd }, 15_000)
        expect(tile.error).toBeUndefined()
        const pane = tile.agent.tmuxPane as string
        // Start an engine in a Harness-owned terminal; unrelated user tmux sessions are intentionally ignored.
        await d.tmux.run('respawn-pane', '-k', '-t', pane, '-c', cwd,
          ...environment, d.env[engine === 'claude' ? 'CLAUDE_PATH' : 'CODEX_PATH']!, ...args)
        const agent = await until(`${engine} discovered and bound while models is unavailable`, async () => {
          const agents = (await client.request('agents_list', {}, 5_000)).agents as Array<Record<string, any>>
          return agents.find(agent => agent.tmuxPane === pane && agent.sessionId && agent.status === 'active') ?? null
        }, 15_000, 200)
        expect(Date.now() - asked).toBeLessThan(15_000)
        discovered.push(agent)
        await turn(client, agent.id, `bound without models ${engine}`)
      }
      expect((await row(client, known.id))?.grid).toMatchObject(knownAssignment)
      for (const agent of discovered) expect((await row(client, agent.id))?.grid ?? null).toBeNull()
      rmSync(hold)
      for (const agent of discovered) await until(`${agent.engine} classified after models returns`, async () => {
        const now = await row(client, agent.id)
        return now?.sessionId === agent.sessionId && now.grid?.baseUrl === grid.baseUrl && now.grid?.model === grid.model ? now : null
      }, 45_000, 250)
      expect(d.coresStarted()).toBe(1)
      client.close()
    } finally { rmSync(holdDir, { recursive: true, force: true }) }
  })

  it('down at launch time: Claude Code and Codex on their own login launch as ever, a launch on a grid or a saved API is refused at once, and builds again once models is back', async () => {
    const holdDir = mkdtempSync(join(tmpdir(), 'models-launch-hold-'))
    const hold = join(holdDir, 'hold')
    try {
      // Hold the replacement until every outage assertion has finished, regardless of host load.
      const d = await fresh({ HARNESSD_TEST_HOLD_CONNECT: `models:${hold}` })
      const client = await LocalClient.connect(d)
      // The launch the desktop sends for a grid it already resolved: models builds it (ModelsPort.gridLaunch).
      const grid = { networkId: 'net-e2e', networkName: 'e2e-grid', baseUrl: 'https://fixture.invalid/g/net-e2e/relay/v1', apiKey: 'fixture-key', model: 'Small-Q4' }
      const onGrid = await createOn(d, client, 'claude', 'launch-grid-claude', grid)
      expect(onGrid.grid).toMatchObject({ baseUrl: grid.baseUrl, model: 'Small-Q4' })
      const before = modelsPids(d)
      writeFileSync(hold, '')
      for (const pid of before) process.kill(pid, 'SIGKILL')
      await until('the core to see models gone', () => d.log().includes('[services] models disconnected') || null, 15_000, 100)
      // Their own login asks models nothing: both launch, and take a turn, while it is down.
      const plain = [await create(d, client, 'claude', 'launch-plain-claude'), await create(d, client, 'codex', 'launch-plain-codex')]
      for (const agent of plain) await turn(client, agent.id, `launched while models was down (${agent.engine})`)
      // A launch that needs it is refused at once, saying why, and nothing is started or stopped.
      const asked = Date.now()
      const down = (engine: string, name: string) => `The models service is not running, so ${engine} cannot be put on ${name}. Try again in a moment.`
      mkdirSync(join(d.projectsDir, 'launch-grid-refused'), { recursive: true })
      expect(await client.request('agent_create', { engine: 'codex', cwd: join(d.projectsDir, 'launch-grid-refused'), grid, bypassPermission: true }, 30_000))
        .toMatchObject({ error: 'GRID_UNAVAILABLE', detail: down('codex', 'e2e-grid') })
      expect(await client.request('agent_restart', { agentId: onGrid.id }, 30_000)).toMatchObject({ error: 'GRID_UNAVAILABLE', detail: down('claude', 'e2e-grid') })
      expect(await client.request('agent_retarget', { agentId: plain[0].id, grid }, 30_000)).toMatchObject({ error: 'GRID_UNAVAILABLE', detail: down('claude', 'e2e-grid') })
      expect(await client.request('agent_retarget', { agentId: plain[1].id, apiConnection: 'openrouter', apiModel: 'z-ai/glm-5' }, 30_000))
        .toMatchObject({ error: 'API_UNAVAILABLE', detail: 'The models service is not running, so this API cannot be used now. Try again in a moment.' })
      expect(Date.now() - asked).toBeLessThan(5_000)
      // The agent on the grid was left running as it was, and every agent goes on.
      await turn(client, onGrid.id, 'its restart was refused, and it is still here')
      for (const agent of plain) expect((await row(client, agent.id))?.grid ?? null).toBeNull()
      expect((await row(client, onGrid.id))?.grid).toMatchObject({ baseUrl: grid.baseUrl })
      // Back, it builds the launch again.
      rmSync(hold)
      await until('the master to restart models', () => restarts(d) >= 1 || null, 30_000, 200)
      await until('models to answer again', () => modelsAnswers(client).then((ok) => ok || null), 30_000, 500)
      expect(await client.request('agent_restart', { agentId: onGrid.id }, 90_000)).not.toHaveProperty('error')
      await until('the agent on the grid to come back', async () => {
        const agent = await row(client, onGrid.id)
        return agent?.status === 'active' && agent.grid?.baseUrl === grid.baseUrl ? agent : null
      }, 60_000, 500)
      expect(d.coresStarted()).toBe(1)
      client.close()
    } finally { rmSync(holdDir, { recursive: true, force: true }) }
  })

  /**
   * Two grid agents, then a reboot with models held off the core (`HARNESSD_TEST_HOLD_CONNECT`): running, and not
   * there. `meanwhile` does to its process what the test is about. The core comes up ready at once, both agents wait
   * held in panes that say why, never failed and never archived, and both come back once models is there.
   */
  async function heldAtBoot(meanwhile: (d: IsolatedDaemon) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
    const holdDir = mkdtempSync(join(tmpdir(), 'models-hold-'))
    const hold = join(holdDir, 'hold')
    try {
      const d = await fresh({ HARNESSD_TEST_HOLD_CONNECT: `models:${hold}`, HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '500', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env })
      let client = await LocalClient.connect(d)
      const grid = { networkId: 'net-e2e', networkName: 'e2e-grid', baseUrl: 'https://fixture.invalid/g/net-e2e/relay/v1', apiKey: 'fixture-key', model: 'Small-Q4' }
      const agents = [await createOn(d, client, 'claude', 'held-claude', grid), await createOn(d, client, 'codex', 'held-codex', grid)]
      client.close()
      // A reboot, with models up but held off the core this time.
      writeFileSync(hold, '')
      await d.stop()
      await d.tmux.run('kill-server')
      const asked = Date.now()
      await d.start()
      // Ready without asking models anything: the old restore waited on it before saying so.
      expect(Date.now() - asked).toBeLessThan(15_000)
      client = await LocalClient.connect(d)
      for (const agent of agents) {
        const held = await until(`${agent.engine} held`, async () => {
          const now = await row(client, agent.id)
          return now?.launch?.state === 'held' ? now : null
        }, 30_000, 250)
        expect(held).toMatchObject({ status: 'offline', launch: { state: 'held', service: 'models', detail: expect.stringContaining('Waiting for the models service') } })
      }
      await meanwhile(d)
      // The pass after ready could not ask models (it is not there): both still held, neither failed nor archived.
      await until('the held pass to give up on models', () => /\[restore\] held · every service · launched 0 of 2 · 2 still waiting/.test(d.log()) || null, 60_000, 250)
      for (const agent of agents) expect((await row(client, agent.id))?.launch).toMatchObject({ state: 'held' })
      expect(d.log()).not.toContain('could not build its launch')
      // Models there at last: both come back, on their grid, with their conversations.
      rmSync(hold)
      for (const agent of agents) {
        await until(`${agent.engine} back on its grid`, async () => {
          const now = await row(client, agent.id)
          return now?.status === 'active' && now.sessionId === agent.sessionId && now.launch?.state === 'ready' ? now : null
        }, 90_000, 500)
      }
      await turn(client, agents[0]!.id, 'back once models was there')
      expect(d.log()).not.toContain('[safe-mode]')
      client.close()
    } finally { rmSync(holdDir, { recursive: true, force: true }) }
  }

  it('killed at boot: the core is ready at once, both grid agents wait held, never failed or archived, and come back once models is up', async () => {
    await heldAtBoot(async (d) => {
      const before = await until('models to be running, held off', () => modelsPids(d).length ? modelsPids(d) : null, 30_000, 200)
      for (const pid of before) process.kill(pid, 'SIGKILL')
      await until('the master to start models again', () => modelsPids(d).some((pid) => !before.includes(pid)) || null, 30_000, 200)
    })
  })

  it('hung at boot: the core is ready within its deadline all the same, and the agents come back once models is', async () => {
    await heldAtBoot(async (d) => {
      const before = await until('models to be running, held off', () => modelsPids(d).length ? modelsPids(d) : null, 30_000, 200)
      for (const pid of before) process.kill(pid, 'SIGSTOP')
      await until('the master to find models hung and start it again', () => modelsPids(d).some((pid) => !before.includes(pid)) || null, 60_000, 200)
    }, { HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '3000' })
  })

  it('hung, it is killed by the master\'s heartbeat watch and started again; the core never waits on it', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'models-hung')
    for (const pid of modelsPids(d)) process.kill(pid, 'SIGSTOP')
    // Frames read what models last said, and turns never ask it: neither waits.
    const listed = Date.now()
    expect((await client.request('agents_list', {}, 30_000)).agents.some((one: Record<string, any>) => one.id === agent.id)).toBe(true)
    expect(Date.now() - listed).toBeLessThan(5_000)
    await turn(client, agent.id, 'the core never waited on models')
    // Asked while it is stopped: answered when the master kills it and the link lets go, never a hang.
    const answer = await client.request('grid_fleet_models_list', {}, 40_000)
    if (answer.error) expect(answer).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models' })
    await until('the master to find models hung', () => d.log().includes('[harnessd] service models sent no heartbeat') || null, 30_000, 200)
    await until('models to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('models to answer again', () => modelsAnswers(client).then((ok) => ok || null), 30_000, 500)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('leaking, it is restarted at its memory budget, before it can hurt anything else', async () => {
    const d = await fresh({ HARNESSD_TEST_FAULTS: 'models.leak', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '128' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'models-leaking')
    await until('the master to restart models for memory', () => /\[harnessd\] service models: (its heap is at|it is using)/.test(d.log()) || null, 60_000, 250)
    await until('models to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await turn(client, agent.id, 'the leak was models\' alone')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('crashing on every start, it is parked, and asked meanwhile says so; a create on a grid model is refused, and agents go on', async () => {
    const d = await IsolatedDaemon.create({ env: {
      HARNESSD_SERVICES: 'models', HARNESSD_TEST_FAULTS: 'models.crash', HARNESSD_SERVICE_PARK_CRASHES: '3',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', HARNESS_GRID_BIN: '/nonexistent/harness-e2e/grid',
    } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'models-crash-loop')
    await until('the master to park models', () => d.log().includes('[harnessd] service models ended 3 times') || null, 60_000, 250)
    expect(await client.request('grid_fleet_models_list', {}, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    expect(await client.request('models_list', { agentId: agent.id }, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    expect(await createOnGrid(client, d)).toMatchObject({ error: 'GRID_UNAVAILABLE' })
    // The handshake is the core's: the Grid harness is told its command was refused, not to update Harness.
    expect(await client.request('grid_fleet_capabilities', {})).toMatchObject({ protocol: 1 })
    await turn(client, agent.id, 'models is parked and nothing else cares')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})
