/**
 * The core's own flows under pressure, for Claude Code and Codex, on the real daemon under a throwaway
 * home and a private tmux server: several agents at once, an engine that exits, stopping and restarting
 * in the middle of a turn, requests for agents that are not there, clients that come and go by the
 * dozen, a storm of hooks, and a transcript deleted under its tail.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']

const rows = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)

async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, name: string): Promise<string> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${name}: ${JSON.stringify(created)}`).toBeUndefined()
  return created.agent.id
}
const bound = (client: LocalClient, agentId: string, ms = 60_000) =>
  until(`${agentId.slice(0, 8)} to bind its conversation`, async () => {
    const agent = await row(client, agentId)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, ms, 500)

const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string, ms = 45_000): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), ms, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), ms, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await started
  await ended
}

describe('the core under pressure', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it('six agents at once, both engines: all bind, run turns together, come back after a restart and stop together', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const plan = [...engines, ...engines, ...engines].map((engine, i) => ({ engine, name: `many-${engine}-${i}` }))
    const ids = await Promise.all(plan.map(({ engine, name }) => create(d, client, engine, name)))
    const first = await Promise.all(ids.map((id) => bound(client, id, 90_000)))
    await Promise.all(ids.map((id, i) => turn(client, id, `together ${i}`, 60_000)))

    await d.restart()
    const again = await LocalClient.connect(d)
    await Promise.all(ids.map((id, i) => until(`${id.slice(0, 8)} back after the restart`, async () => {
      const agent = await row(again, id)
      return agent?.status === 'active' && agent.sessionId === first[i].sessionId ? agent : null
    }, 60_000, 500)))
    await Promise.all(ids.map((id, i) => turn(again, id, `again ${i}`, 60_000)))

    const stopped = await Promise.all(ids.map((id) => again.request('agent_delete', { agentId: id }, 90_000)))
    for (const result of stopped) expect(result.error, JSON.stringify(result)).toBeUndefined()
    await until('every agent to stop', async () => (await rows(again)).filter((agent) => ids.includes(agent.id)).every((agent) => agent.status === 'stopped') || null, 60_000, 500)
    expect(d.coresStarted()).toBe(2)
    again.close()
    client.close()
  })

  it.each(engines)('%s: stopping in the middle of a turn, then resuming: the conversation goes on', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `stop-mid-turn-${engine}`)
    const before = await bound(client, id)
    const started = client.next(isTurn('turn_started', id), 30_000, 'turn_started')
    client.send('message', { agentId: id, content: '!slow 8000' })
    await started
    const stopped = await client.request('agent_delete', { agentId: id }, 60_000)
    expect(stopped.error, JSON.stringify(stopped)).toBeUndefined()
    await until('the agent to stop', async () => (await row(client, id))?.status === 'stopped' || null, 45_000, 500)
    const resumed = await client.request('agent_resume', { agentId: id }, 90_000)
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
    const after = await bound(client, id)
    expect(after.sessionId).toBe(before.sessionId)
    await turn(client, id, 'after the resume')
    client.close()
  })

  it.each(engines)('%s: restarting in the middle of a turn: one answer, and the agent takes the next message', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `restart-mid-turn-${engine}`)
    const before = await bound(client, id)
    const started = client.next(isTurn('turn_started', id), 30_000, 'turn_started')
    client.send('message', { agentId: id, content: '!slow 8000' })
    await started
    const restarted = await client.request('agent_restart', { agentId: id }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    const after = await bound(client, id)
    expect(after.sessionId).toBe(before.sessionId)
    expect(after.status).toBe('active')
    await turn(client, id, 'after the restart')
    client.close()
  })

  it.each(engines)('%s: an engine that exits takes its agent out of active, and a restart brings it back', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `exits-${engine}`)
    await bound(client, id)
    client.send('message', { agentId: id, content: '!exit' })
    const gone = await until('the agent to stop counting as active', async () => {
      const agent = await row(client, id)
      return agent && agent.status !== 'active' ? agent : null
    }, 45_000, 500)
    expect(['offline', 'stopped']).toContain(gone.status)
    // A message to it now is not an error anyone has to handle, and nothing breaks.
    client.send('message', { agentId: id, content: 'anyone there?' })
    const restarted = await client.request('agent_restart', { agentId: id }, 90_000)
    const resumed = restarted.error ? await client.request('agent_resume', { agentId: id }, 90_000) : restarted
    expect(resumed.error, `restart: ${JSON.stringify(restarted)} resume: ${JSON.stringify(resumed)}`).toBeUndefined()
    await bound(client, id)
    await turn(client, id, 'back again')
    client.close()
  })

  it('requests for agents that are not there are refused, and nothing else is disturbed', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const ghost = '00000000-0000-4000-8000-000000000000'
    client.send('message', { agentId: ghost, content: 'hello?' })
    client.send('cancel', { agentId: ghost })
    for (const [type, payload] of [
      ['agent_restart', { agentId: ghost }], ['agent_resume', { agentId: ghost }],
      ['agent_restart', {}], ['agent_delete', {}], ['agent_fork', { agentId: ghost }],
    ] as const) {
      const answer = await client.request(type, payload, 30_000)
      expect(answer.error, `${type} ${JSON.stringify(payload)}`).toBeTruthy()
    }
    // Stopping an agent that is not there is a stop that has nothing left to do: idempotent, not an error.
    expect(await client.request('agent_delete', { agentId: ghost }, 30_000)).toBeTruthy()
    expect((await rows(client)).find((agent) => agent.id === ghost)).toBeUndefined()
    const id = await create(d, client, 'claude', 'after-the-ghosts')
    await bound(client, id)
    expect((await client.request('agent_delete', { agentId: id }, 60_000)).error).toBeUndefined()
    // Stopping it again, and resuming it twice at once, answer rather than race.
    const twice = await client.request('agent_delete', { agentId: id }, 60_000)
    expect(twice).toBeTruthy()
    const [a, b] = await Promise.all([client.request('agent_resume', { agentId: id }, 90_000), client.request('agent_resume', { agentId: id }, 90_000)])
    expect([a.error, b.error].filter((error) => !error).length).toBeGreaterThanOrEqual(1)
    await bound(client, id)
    await turn(client, id, 'resumed once')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it('fifty clients coming and going while an agent runs turns: every turn reaches the client that stayed', async () => {
    const d = await fresh()
    const steady = await LocalClient.connect(d)
    const id = await create(d, steady, 'codex', 'client-churn')
    await bound(steady, id)
    const rssBefore = await d.rssMiB()
    let churning = true
    const churn = (async () => {
      let n = 0
      while (churning && n < 50) {
        const batch = await Promise.all(Array.from({ length: 5 }, () => LocalClient.connect(d)))
        await Promise.all(batch.map((c) => c.request('agents_list', {}, 15_000)))
        for (const c of batch) c.close()
        n += batch.length
      }
      return n
    })()
    for (let i = 0; i < 3; i++) await turn(steady, id, `while clients churn ${i}`)
    churning = false
    expect(await churn).toBeGreaterThan(0)
    const rssAfter = await d.rssMiB()
    expect(rssAfter - rssBefore, `rss ${rssBefore} → ${rssAfter} MiB`).toBeLessThan(200)
    expect((await steady.request('agents_list', {})).agents.length).toBe(1)
    steady.close()
  })

  it('a storm of hooks: every one is answered, and the daemon answers clients through it', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const token = d.hookCredential()
    const post = (i: number) => fetch(`http://127.0.0.1:${d.port}/api/hook/session-start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': token },
      body: JSON.stringify({ engine: i % 2 ? 'claude' : 'codex', sessionId: `storm-${i}`, tmuxPane: `%${1000 + i}`, cwd: '/nowhere', callerPid: 1 }),
    }).then((response) => response.status).catch(() => 0)
    const storm = Promise.all(Array.from({ length: 300 }, (_, i) => post(i)))
    const startedAt = Date.now()
    expect(Array.isArray((await client.request('agents_list', {}, 15_000)).agents)).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    const statuses = await storm
    expect(statuses.filter((status) => status === 0), 'a hook left unanswered').toEqual([])
    expect(statuses.filter((status) => status >= 500), 'a hook that failed').toEqual([])
    const id = await create(d, client, 'claude', 'after-the-storm')
    await bound(client, id)
    await turn(client, id, 'after the storm')
    client.close()
  })

  it.each(engines)('%s: a transcript deleted under its tail: the agent goes on, and its turns are seen again', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `deleted-transcript-${engine}`)
    const agent = await bound(client, id)
    await turn(client, id, 'first')
    const transcript: string | undefined = agent.transcriptPath ?? (await row(client, id))?.transcriptPath
    const files = transcript ? [transcript] : findTranscripts(d)
    expect(files.length, 'a transcript to delete').toBeGreaterThan(0)
    for (const file of files) rmSync(file, { force: true })
    // The engine writes its next turn into a new file at the same path. A file that shrank under the
    // tail is read as a rewrite of history (watcher.ts: one agent was once credited with 42 turns in a
    // second by a rewrite replayed as live), so what the new file holds when the tail first sees it is
    // history — and everything written after that is live again.
    client.send('message', { agentId: id, content: 'into a new file' })
    await until('the engine to write the new file', () => files.some((file) => { try { return readdirSync(join(file, '..')).includes(file.split('/').pop()!) } catch { return false } }) || null, 30_000, 250)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await turn(client, id, 'seen live again', 60_000)
    expect((await row(client, id))?.status).toBe('active')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})

function findTranscripts(daemon: IsolatedDaemon): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) found.push(path)
    }
  }
  walk(join(daemon.root, 'claude'))
  walk(join(daemon.root, 'codex'))
  return found
}
