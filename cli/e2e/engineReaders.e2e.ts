/** Private daemon/home/tmux; real supervised reader processes and the engines' recorded wire format. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { alive, harnessdProcesses } from './harness/endurance.js'

type Engine = 'claude' | 'codex'
type Agent = { id: string; sessionId: string; engine: Engine; processIdentity: unknown; selectedModel: string | null }
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

  it.each(['claude', 'codex'] as const)('%s keeps native runtime profiles in explicit inline mode', async engine => {
    const { d, c } = await fresh({ HARNESSD_SERVICES: 'none' })
    const agent = await create(d, c, engine)
    await turn(c, agent, `inline-profile-${engine}`)
    const selected = await until('the inline runtime profile', async () => (await rows(c)).find(row => row.id === agent.id)?.selectedModel || null)
    expect(selected.startsWith(`runtime-v1:${agent.id}:${engine}:`)).toBe(true)
    const catalog = await c.request('models_list', { agentId: agent.id }, 15_000)
    expect(catalog.error, JSON.stringify(catalog)).toBeUndefined()
    expect(catalog.models.some((option: { id: string }) => option.id === selected)).toBe(true)
    expect(readerPid(d, engine)).toBeUndefined()
    expect(d.coresStarted()).toBe(1)
  })

  it('starts no reader for an empty core, reads pages and recap text on demand, and keeps private requests off the client router', async () => {
    const { d, c } = await fresh()
    expect(readerPid(d, 'claude')).toBeUndefined()
    expect(readerPid(d, 'codex')).toBeUndefined()
    for (const type of ['engine_history_page', 'engine_last_turn', 'engine_live_capabilities', 'engine_live_prepare',
      'engine_live_read', 'engine_live_part', 'engine_live_close', 'engine_live_forget', 'engine_runtime_capabilities', 'engine_runtime_read', 'engine_screen_capabilities', 'engine_screen_read', 'engine_model_control_capabilities', 'engine_model_control_validate', 'engine_model_control_apply', 'engine_question_control_capabilities', 'engine_question_control_apply']) {
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

  it.each(['claude', 'codex'] as const)('%s retains its accepted profile while its worker is frozen and applies pending evidence after recovery', async engine => {
    const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '60000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' })
    const agent = await create(d, c, engine)
    await turn(c, agent, `profile-before-${engine}`)
    const before = await until('an accepted runtime profile', async () => (await rows(c)).find(row => row.id === agent.id)?.selectedModel || null)
    const catalog = await c.request('models_list', { agentId: agent.id }, 15_000)
    expect(catalog.error, JSON.stringify(catalog)).toBeUndefined()
    expect(catalog.models.length).toBeGreaterThan(0)
    const core = d.corePid(), pid = readerPid(d, engine)!
    const registry = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8'))
    const bound = registry.find((row: any) => row.agentId === agent.id)
    const evidence = engine === 'claude'
      ? { type: 'system', content: 'Set model to Sonnet\nSet effort level to high' }
      : { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-luna', reasoning_effort: 'high' } } }
    process.kill(pid, 'SIGSTOP')
    try {
      appendFileSync(bound.transcriptPath, JSON.stringify(evidence) + '\n')
      const started = Date.now()
      const unavailable = await c.request('models_list', { agentId: agent.id }, 15_000)
      expect(unavailable.error).toBe('INTERNAL')
      expect(Date.now() - started).toBeLessThan(10_000)
      expect((await rows(c)).find(row => row.id === agent.id)?.selectedModel).toBe(before)
      expect(d.corePid()).toBe(core)
    } finally { process.kill(pid, 'SIGCONT') }
    const expected = `runtime-v1:${agent.id}:${engine}:${engine === 'claude' ? 'sonnet' : 'gpt-6-luna'}@high`
    await until('pending profile evidence after worker recovery', async () => (await rows(c)).find(row => row.id === agent.id)?.selectedModel === expected || null, 30_000, 100)
    const recovered = await c.request('models_list', { agentId: agent.id }, 15_000)
    expect(recovered.error, JSON.stringify(recovered)).toBeUndefined()
    expect(recovered.models.some((option: { id: string }) => option.id === expected)).toBe(true)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
    expect(alive(bound.processIdentity.pid)).toBe(true)
  })

  it.each(['claude', 'codex'] as const)('%s refuses terminal writes and retains its question while its screen worker is frozen', async engine => {
    const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '60000', HARNESSD_SERVICE_STOP_GRACE_MS: '100' })
    const agent = await create(d, c, engine)
    const asked = c.next(frame => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'permission question')
    c.send('message', { agentId: agent.id, content: '!permit printf screen-worker' })
    const question = (await asked).payload!
    const shaped = question.questions[0]
    const bound = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((row: any) => row.agentId === agent.id)
    const pid = readerPid(d, engine)!, core = d.corePid(), from = c.frames.length
    const answer = async () => {
      const result = c.next(frame => frame.type === 'question_response_result' && frame.payload?.requestId === question.requestId, 10_000, 'answer result')
      c.send('question_response', { agentId: agent.id, requestId: question.requestId, answers: { [shaped.q]: shaped.options[2] } })
      return (await result).payload!
    }
    process.kill(pid, 'SIGSTOP')
    try {
      const started = Date.now()
      expect((await answer()).error).toBe('ANSWER_FAILED')
      expect(Date.now() - started).toBeLessThan(5_000)
      const refused = c.next(frame => frame.type === 'error' && frame.agentId === agent.id, 25_000, 'unreadable-screen refusal')
      c.send('message', { agentId: agent.id, content: 'must-not-enter-the-permission' })
      expect((await refused).payload?.message).toContain('screen could not be read')
      const pane = await d.capture(bound.tmuxPane)
      expect(pane).not.toContain('must-not-enter-the-permission')
      expect(pane).not.toContain('did not run printf screen-worker')
      expect(c.frames.slice(from).filter(frame => frame.type === 'commander_question_close' && frame.agentId === agent.id)).toHaveLength(0)
      expect((await rows(c)).some(row => row.id === agent.id)).toBe(true)
      expect(d.corePid()).toBe(core)
    } finally { process.kill(pid, 'SIGCONT') }
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 30_000, 'declined permission')
    expect((await answer()).error).toBeUndefined()
    await ended
    await turn(c, agent, `screen-recovered-${engine}`)
    expect(alive(bound.processIdentity.pid)).toBe(true)
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

  it.each(['claude', 'codex'] as const)('%s replays a shortened transcript as history and delivers the next turn live once', async engine => {
    const { d, c } = await fresh()
    const agent = await create(d, c, engine)
    await turn(c, agent, 'older turn')
    await turn(c, agent, 'retained history')
    const row = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((row: any) => row.agentId === agent.id)
    const lines = readFileSync(row.transcriptPath, 'utf8').split('\n')
    let start = lines.findIndex(line => {
      try {
        const record = JSON.parse(line)
        return engine === 'claude'
          ? record.type === 'user' && record.message?.content === 'retained history'
          : record.type === 'event_msg' && record.payload?.type === 'item_completed'
            && record.payload?.item?.type === 'UserMessage'
            && record.payload.item.content.some((part: any) => part.text === 'retained history')
      } catch { return false }
    })
    expect(start).toBeGreaterThan(0)
    if (engine === 'codex') {
      // Keep the real turn's task marker and context before its completed UserMessage item.
      while (start > 0 && JSON.parse(lines[start]).payload?.type !== 'task_started') start--
      expect(start).toBeGreaterThan(0)
    }
    const first = c.frames.length
    const replayed = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id && frame.replay === true, 30_000, 'rewritten history')
    writeFileSync(row.transcriptPath, lines.slice(start).join('\n'))
    await replayed
    expect(c.frames.slice(first).filter(frame => frame.type === 'turn_ended' && frame.agentId === agent.id && !frame.replay)).toEqual([])
    await turn(c, agent, 'after rewrite')
    expect(c.frames.slice(first).filter(frame => frame.type === 'turn_ended' && frame.agentId === agent.id && !frame.replay)).toHaveLength(1)
    expect(d.coresStarted()).toBe(1)
  })

  it('parks a crashing engine worker while the CLI continues, then delivers its queued turn once after recovery', async () => {
    const { d, c } = await fresh({ HARNESSD_SERVICE_PARK_CRASHES: '3', HARNESSD_SERVICE_PARK_RETRY_MS: '30000' })
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
    const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agent.id, 60_000, 'queued turn after worker recovery')
    // A person can still use the independent CLI while its worker is parked.
    // Harness messages now require screen evidence and are withheld in an
    // outage (covered above); type through this fixture's private terminal.
    await d.tmux.run('send-keys', '-t', registered().tmuxPane, '-l', 'worker-is-parked')
    await d.tmux.run('send-keys', '-t', registered().tmuxPane, 'Enter')
    await until('the independent CLI to finish writing its turn', () => {
      const file = registered().transcriptPath
      return file && readFileSync(file, 'utf8').split('\n').some(line => {
        try { const row = JSON.parse(line); return row.payload?.type === 'task_complete' && row.payload?.last_agent_message?.includes('worker-is-parked') } catch { return false }
      }) || null
    }, 30_000, 100)
    const parked = readerPid(d, 'codex')
    expect(parked === undefined || !alive(parked)).toBe(true)
    expect(c.frames.slice(first).filter(frame => frame.type === 'turn_ended' && frame.agentId === agent.id)).toEqual([])
    await ended
    expect(c.frames.slice(first).filter(frame => frame.type === 'turn_started' && frame.agentId === agent.id)).toHaveLength(1)
    expect(c.frames.slice(first).filter(frame => frame.type === 'turn_ended' && frame.agentId === agent.id)).toHaveLength(1)
    expect(registered().processIdentity).toEqual(identity)
    expect(alive(identity.pid)).toBe(true)
    expect(d.corePid()).toBe(corePid)
    expect(d.coresStarted()).toBe(1)
  })
})
