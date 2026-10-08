/** Private daemon/home/tmux; real supervised reader processes and the engines' recorded wire format. */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { alive, harnessdProcesses } from './harness/endurance.js'

type Engine = 'claude' | 'codex'
type Agent = { id: string; sessionId: string; engine: Engine; processIdentity: unknown }
const rows = async (client: LocalClient) => (await client.request('agents_list', {})).agents as Agent[]
const history = (client: LocalClient, agent: Agent) => client.request('session_get', { sessionId: agent.id, limit: 10 }, 15_000)

async function create(d: IsolatedDaemon, client: LocalClient, engine: Engine): Promise<Agent> {
  const cwd = join(d.projectsDir, engine); mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  return until(`${engine} conversation`, async () => (await rows(client)).find(row => row.id === created.agent.id && row.sessionId) ?? null, 60_000, 200)
}

async function turn(client: LocalClient, agent: Agent, text: string, recap = false) {
  const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 30_000, text)
  const summary = recap ? client.next(frame => frame.type === 'turn_summary' && frame.agentId === agent.id
    && JSON.stringify(frame.payload).includes(text), 30_000, `recap ${text}`) : null
  client.send('message', { agentId: agent.id, content: text })
  await ended
  if (summary) await summary
}

describe('Claude Code and Codex readers in their own processes', () => {
  let daemon: IsolatedDaemon | undefined
  let client: LocalClient | undefined
  afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })
  async function fresh(env: Record<string, string> = {}) {
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000', ...env } })
    onTestFailed(() => console.log(d.log()))
    await d.start()
    client = await LocalClient.connect(d)
    return { d, c: client }
  }
  const readerPid = (d: IsolatedDaemon, engine: Engine) => harnessdProcesses(d).get(`engine-${engine}`)
  const linked = (d: IsolatedDaemon, engine: Engine) => d.log().split(`[services] engine-${engine} connected`).length - 1

  it('starts no reader for an empty core, reads pages and recap text on demand, and keeps private requests off the client router', async () => {
    const { d, c } = await fresh()
    expect(readerPid(d, 'claude')).toBeUndefined()
    expect(readerPid(d, 'codex')).toBeUndefined()
    for (const type of ['engine_history_page', 'engine_last_turn']) {
      const answer = await c.request(type, { version: 1, session: { transcriptPath: '/etc/passwd' } })
      expect(answer.error).toBe('UNSUPPORTED')
    }
    for (const engine of ['claude', 'codex'] as const) {
      const agent = await create(d, c, engine)
      await turn(c, agent, `reader-cold-${engine}`, true)
      const first = await history(c, agent)
      expect(first.error, JSON.stringify(first)).toBeUndefined()
      expect(JSON.stringify(first.events)).toContain(`reader-cold-${engine}`)
      const pid = readerPid(d, engine)!
      expect(alive(pid)).toBe(true)
      const second = await history(c, agent)
      expect(second).toMatchObject({ events: first.events, oldestCursor: first.oldestCursor })
      expect(readerPid(d, engine)).toBe(pid)
    }
    expect(d.coresStarted()).toBe(1)
  })

  it('contains a killed or frozen reader, bounds failed reads, and recovers without restarting core or either CLI', async () => {
    const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' })
    const agents = await Promise.all((['claude', 'codex'] as const).map(engine => create(d, c, engine)))
    for (const agent of agents) { await turn(c, agent, `before-${agent.engine}`, true); await history(c, agent) }
    const corePid = d.corePid()
    const identities = () => {
      const rows = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8'))
      return agents.map(agent => rows.find((row: any) => row.agentId === agent.id)?.processIdentity)
    }
    const identitiesBefore = identities()
    for (const identity of identitiesBefore) expect(identity?.pid).toBeGreaterThan(0)
    const panePids = await Promise.all(agents.map(async agent => {
      const row = (await c.request('agents_list', {})).agents.find((row: any) => row.id === agent.id)
      return { pane: row.tmuxPane, pid: (await d.tmux.run('display-message', '-p', '-t', row.tmuxPane, '#{pane_pid}')).trim() }
    }))
    for (const [index, signal] of (['SIGKILL', 'SIGSTOP'] as const).entries()) {
      const agent = agents[index]
      const other = agents[1 - index]
      const before = readerPid(d, agent.engine)!
      const connections = linked(d, agent.engine)
      process.kill(before, signal)
      const at = Date.now()
      const pending = history(c, agent)
      // Both the affected engine's live turn and the other engine's reader continue independently.
      await Promise.all([turn(c, agent, `during-${signal}`), turn(c, other, `other-${signal}`, true)])
      const answer = await pending
      if (answer.error) expect(['ENGINE_UNAVAILABLE', 'ENGINE_STALE_REPLY']).toContain(answer.error)
      expect(Date.now() - at).toBeLessThan(15_000)
      expect((await history(c, other)).error).toBeUndefined()
      await until(`${agent.engine} reader recovery`, () => linked(d, agent.engine) > connections && readerPid(d, agent.engine) !== before || null, 30_000, 100)
      const recovered = await history(c, agent)
      expect(recovered.error, JSON.stringify(recovered)).toBeUndefined()
      expect(JSON.stringify(recovered.events)).toContain(`during-${signal}`)
      await turn(c, agent, `recovered-${signal}`, true)
      if (signal === 'SIGSTOP') expect(d.log()).toContain(`service engine-${agent.engine} sent no heartbeat`)
    }
    expect(identities()).toEqual(identitiesBefore)
    for (const identity of identitiesBefore) expect(alive(identity.pid)).toBe(true)
    expect(d.corePid()).toBe(corePid)
    expect(d.coresStarted()).toBe(1)
    for (const { pane, pid } of panePids) expect((await d.tmux.run('display-message', '-p', '-t', pane, '#{pane_pid}')).trim()).toBe(pid)
  })

  it('restarts a leaking reader at its memory budget while the agent continues', async () => {
    const { d, c } = await fresh({ HARNESSD_TEST_FAULTS: 'engine-claude.leak', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '128' })
    const agent = await create(d, c, 'claude')
    await history(c, agent)
    await until('reader memory containment', () => /\[harnessd\] service engine-claude: (its heap is at|it is using)/.test(d.log()) || null, 60_000, 200)
    await until('reader memory restart', () => linked(d, 'claude') >= 2 || null, 30_000, 200)
    await turn(c, agent, 'reader-memory-contained')
    expect(d.coresStarted()).toBe(1)
  })

  it('parks a crashing engine worker while the CLI continues, then delivers its queued turn once after recovery', async () => {
    const { d, c } = await fresh({ HARNESSD_SERVICE_PARK_CRASHES: '3', HARNESSD_SERVICE_PARK_RETRY_MS: '20000' })
    const agent = await create(d, c, 'codex')
    await turn(c, agent, 'before parking')
    const corePid = d.corePid()
    const registered = () => JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((row: any) => row.agentId === agent.id)
    const identity = registered().processIdentity
    for (let index = 0; index < 3; index++) {
      const before = readerPid(d, 'codex')!
      process.kill(before, 'SIGKILL')
      if (index < 2) await until('replacement worker', () => {
        const pid = readerPid(d, 'codex')
        return pid && pid !== before && alive(pid) ? pid : null
      }, 15_000, 100)
    }
    await until('reader parked', () => d.log().includes('service engine-codex ended 3 times') || null, 60_000, 200)
    expect(await history(c, agent)).toMatchObject({ error: 'ENGINE_UNAVAILABLE', retryable: true })
    const first = c.frames.length
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 45_000, 'queued turn after worker recovery')
    c.send('message', { agentId: agent.id, content: 'worker-is-parked' })
    await until('the independent CLI to finish writing its turn', () => {
      const file = registered().transcriptPath
      return file && readFileSync(file, 'utf8').split('\n').some(line => {
        try { const row = JSON.parse(line); return row.payload?.type === 'task_complete' && row.payload?.last_agent_message?.includes('worker-is-parked') } catch { return false }
      }) || null
    }, 30_000, 100)
    await ended
    expect(c.frames.slice(first).filter(frame => frame.type === 'turn_started' && frame.agentId === agent.id)).toHaveLength(1)
    expect(c.frames.slice(first).filter(frame => frame.type === 'turn_ended' && frame.agentId === agent.id)).toHaveLength(1)
    expect(registered().processIdentity).toEqual(identity)
    expect(alive(identity.pid)).toBe(true)
    expect(d.corePid()).toBe(corePid)
    expect(d.coresStarted()).toBe(1)
  })
})
