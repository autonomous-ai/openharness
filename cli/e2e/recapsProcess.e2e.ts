/**
 * The recaps in their own process, the edge host's (`HARNESSD_SERVICES=edge`), for Claude Code and Codex, on
 * the real daemon. The core tells them each turn's lifecycle and never waits on them (core/turns/recaps.ts,
 * core/recapsLink.ts). So whatever happens to their process — killed outright, hung until the master's
 * heartbeat watch kills it, or only slow (stopped, then let go before the watch fires) — every turn still
 * ends on time and every agent goes on; a turn they missed has no recap; and once they are back, the next
 * turn's recap comes as before. The core itself never restarts.
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
const of = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
/** A turn, to its end: how long it took, and the frames this client saw meanwhile. */
async function turn(client: LocalClient, agentId: string, content: string, ms = 45_000): Promise<number> {
  const ended = client.next(of('turn_ended', agentId), ms, `turn_ended (${content})`)
  const at = Date.now()
  client.send('message', { agentId, content })
  await ended
  return Date.now() - at
}
/** A turn, and the recap the recaps cut from its answer: the fake engines answer with the prompt itself. */
async function recapped(client: LocalClient, agentId: string, word: string): Promise<Frame> {
  const summary = client.next((frame) => of('turn_summary', agentId)(frame) && JSON.stringify(frame.payload).includes(word), 45_000, `turn_summary (${word})`)
  await turn(client, agentId, `tell me about the ${word}`)
  return summary
}

/** This daemon's edge host: titled `harnessd-edge` AND started by its own master, by the pid it logged. */
function edgePids(d: IsolatedDaemon): number[] {
  const ours = new Set([...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)].map((match) => Number(match[1])))
  const table = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
  return table.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, pid, command]) => command.trim() === 'harnessd-edge' && ours.has(Number(pid))).map(([, pid]) => Number(pid))
}
const recapsConnections = (d: IsolatedDaemon): number => d.log().split('[services] recaps connected').length - 1
const restarts = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => /\[harnessd\] service edge started .* restart \d+/.test(line)).length

describe('the recaps in their own process', () => {
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
    await until('the recaps to connect to the core', () => recapsConnections(d) >= 1 || null, 30_000, 200)
    return d
  }

  it('cut each turn\'s recap in the edge host, and the core answers what they hold, for both engines', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    expect(edgePids(d)).toHaveLength(1)
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, client, engine, `recaps-${engine}`)
      const summary = await recapped(client, agent.id, `narwhal${engine}`)
      expect(summary.payload).toMatchObject({ sessionId: agent.sessionId, summary: expect.stringContaining(`narwhal${engine}`) })
      // What a device restoring its tiles asks: answered by the core, from what the recaps told it.
      const recent = await until(`${engine}'s recap to reach the core`, async () => {
        const answer = await client.request('agent_recent', { agentId: agent.id }, 10_000)
        return answer.events?.length ? answer : null
      }, 10_000, 200)
      expect(recent).toMatchObject({ agentId: agent.id, asks: [`tell me about the narwhal${engine}`] })
      expect(JSON.stringify(recent.events)).toContain(`narwhal${engine}`)
    }
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('killed outright: turns end on time and agents go on, and the master brings the recaps back', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'recaps-killed')
    await recapped(client, agent.id, 'pangolin')
    const before = edgePids(d)
    for (const pid of before) process.kill(pid, 'SIGKILL')
    // A turn while they are gone ends as any turn does; asked meanwhile, the core answers from what it kept.
    await turn(client, agent.id, 'while the recaps were gone')
    expect(await client.request('agent_recent', { agentId: agent.id }, 10_000)).not.toHaveProperty('error')
    await until('the master to restart the edge host', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('the recaps to connect again', () => recapsConnections(d) >= 2 || null, 30_000, 200)
    await recapped(client, agent.id, 'axolotl')
    expect(edgePids(d).some((pid) => !before.includes(pid))).toBe(true)
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('hung: turns end while they are stopped, the master kills them, and recaps come again', async () => {
    const d = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'recaps-hung')
    await recapped(client, agent.id, 'okapi')
    for (const pid of edgePids(d)) process.kill(pid, 'SIGSTOP')
    // Hung: a stopped process neither beats nor reads. The core told it the turn and did not wait.
    await turn(client, agent.id, 'while the recaps were hung')
    await until('the master to find the edge host hung', () => d.log().includes('[harnessd] service edge sent no heartbeat') || null, 30_000, 200)
    await until('the edge host to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('the recaps to connect again', () => recapsConnections(d) >= 2 || null, 30_000, 200)
    await recapped(client, agent.id, 'quokka')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('slow: a turn ends on time while they are stopped, and once let go they catch up without a restart', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'recaps-slow')
    const usual = await turn(client, agent.id, 'how long does a turn take?')
    await recapped(client, agent.id, 'tapir')
    const pids = edgePids(d)
    for (const pid of pids) process.kill(pid, 'SIGSTOP')
    let late: Frame | null = null
    const recap = client.next((frame) => of('turn_summary', agent.id)(frame) && JSON.stringify(frame.payload).includes('dugong'), 45_000, 'the slow turn\'s recap')
      .then((frame) => { late = frame })
    try {
      // On time: as long as a turn took with the recaps answering, give or take the machine's load, and
      // with no recap yet, since the process that cuts it has not read a thing.
      const slow = await turn(client, agent.id, 'tell me about the dugong')
      expect(slow).toBeLessThan(usual + 10_000)
      expect(late).toBeNull()
    } finally {
      for (const pid of pids) process.kill(pid, 'SIGCONT')
    }
    // Let go before the master's watch: the same process reads what waited and cuts the recap, late.
    await recap
    expect(restarts(d)).toBe(0)
    await recapped(client, agent.id, 'manatee')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})
