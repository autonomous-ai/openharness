/**
 * Services in their own processes, for Claude Code and Codex, on the real daemon: harnessd's master runs
 * search beside the core (`HARNESSD_SERVICES=search`), and whatever happens to search — killed outright,
 * hung, leaking memory, crashing on every start — costs search alone. The core never restarts, every
 * agent keeps working, a search asked while it is down is answered SERVICE_UNAVAILABLE at once, and the
 * master brings search back (or parks it, when it keeps crashing).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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
/** The search service's own process, from the process table: it is `harnessd search`. */
function searchPids(): number[] {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
  return table.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, , command]) => command.trim() === 'harnessd search').map(([, pid]) => Number(pid))
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
    expect(searchPids().length).toBeGreaterThanOrEqual(1)
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
    const before = searchPids()
    expect(before.length).toBeGreaterThanOrEqual(1)
    for (const pid of before) process.kill(pid, 'SIGKILL')
    // Asked while it is down: an answer, not a hang.
    const answer = await client.request('session_search', { query: 'pangolin' }, 10_000)
    if (answer.error) expect(answer).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
    // The agents never noticed.
    await turn(client, agent.id, 'while search was gone')
    await until('the master to restart search', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('search to answer again', () => finds(client, 'pangolin', agent.sessionId) || null, 60_000, 1_000)
    expect(searchPids().some((pid) => !before.includes(pid))).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('a hung search is killed by the master\'s heartbeat watch and started again; the core goes on', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'search-hung')
    await until('search to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    // Hung: a stopped process neither beats nor answers, as one stuck in a loop would not.
    for (const pid of searchPids()) process.kill(pid, 'SIGSTOP')
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
    for (const pid of searchPids()) process.kill(pid, 'SIGSTOP')
    const createdAt = Date.parse(agent.createdAt)
    const review = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'inspect' }, 60_000)
    for (const pid of searchPids()) process.kill(pid, 'SIGKILL')
    const deleted = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'delete', reviewId: review.reviewId }, 90_000)
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ deleted: true })
    await until('search to be back', () => restarts(d) >= 1 && d.log().split('[services] search connected').length >= 3 || null, 60_000, 250)
    await until('search to have forgotten it', async () => !(await finds(client, 'quokka', agent.sessionId)) || null, 30_000, 1_000)
    client.close()
  })
})
