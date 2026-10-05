/**
 * How an agent's life ends, for Claude Code and Codex: closed now, closed only when idle, closed after
 * its task (and that intent cancelled, or carried across a daemon restart), and purged with its history
 * — and the search that finds a conversation until it is purged. A close never takes a turn that is
 * still working unless it was asked to; a purge leaves nothing of the conversation behind.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']

const rows = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
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
const close = (client: LocalClient, agent: Record<string, any>, mode: string) =>
  client.request('agent_close', { agentId: agent.id, sessionId: agent.sessionId, createdAt: agent.createdAt, mode }, 90_000)
const stopped = (client: LocalClient, agentId: string, ms = 45_000) =>
  until(`${agentId.slice(0, 8)} to stop`, async () => (await row(client, agentId))?.status === 'stopped' || null, ms, 500)
/** The engine's own transcript files for a conversation, where the fake engines write them. */
function transcriptsOf(daemon: IsolatedDaemon, sessionId: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try { entries = readdirSync(dir, { withFileTypes: true }) as never } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) found.push(path)
    }
  }
  walk(join(daemon.root, 'claude', 'projects'))
  walk(join(daemon.root, 'codex', 'sessions'))
  return found
}

describe('how an agent\'s life ends', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: closed now it stops with its conversation kept, and opening it again goes on with it', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `close-now-${engine}`)
    await turn(client, agent.id, 'before the close')
    expect(await close(client, agent, 'inspect')).toMatchObject({ activity: 'idle' })
    expect(await close(client, agent, 'now')).toMatchObject({ closed: true })
    await stopped(client, agent.id)
    expect((await client.request('agent_resume', { agentId: agent.id }, 90_000)).error).toBeUndefined()
    await until('the agent to be back', async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
    }, 60_000, 500)
    await turn(client, agent.id, 'after opening it again')
    client.close()
  })

  it.each(engines)('%s: closed only when idle, a working agent is left working and says so', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `close-idle-${engine}`)
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: '!slow 4000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    await until('the agent to read as working', async () => (await row(client, agent.id))?.activity?.state === 'working' || null, 15_000, 250)
    expect(await close(client, agent, 'inspect')).toMatchObject({ activity: 'working' })
    expect(await close(client, agent, 'idle')).toMatchObject({ error: 'SESSION_NOT_IDLE', activity: 'working' })
    await ended
    expect((await row(client, agent.id))?.status).toBe('active')
    await turn(client, agent.id, 'still here')
    client.close()
  })

  it.each(engines)('%s: closed after its task, it finishes the turn, then closes on its own', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `close-after-${engine}`)
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: '!slow 3000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    expect(await close(client, agent, 'after_task')).toMatchObject({ deferred: true })
    // Asking twice is the same plan.
    expect(await close(client, agent, 'after_task')).toMatchObject({ deferred: true })
    await ended
    expect((await row(client, agent.id))?.status).toBe('active')
    // Idle for a while (a turn boundary alone is not completion), then closed.
    await stopped(client, agent.id, 45_000)
    client.close()
  })

  it.each(engines)('%s: a close after its task, cancelled, leaves the agent open', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `close-cancel-${engine}`)
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: '!slow 2000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    expect(await close(client, agent, 'after_task')).toMatchObject({ deferred: true })
    expect(await close(client, agent, 'cancel')).toMatchObject({ cancelled: true })
    await ended
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    expect((await row(client, agent.id))?.status).toBe('active')
    await turn(client, agent.id, 'still open')
    client.close()
  })

  it('a close after its task outlives a daemon restart, and is carried out once the agent is idle', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'close-across-restart')
    client.send('message', { agentId: agent.id, content: '!slow 4000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    expect(await close(client, agent, 'after_task')).toMatchObject({ deferred: true })
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    await stopped(client, agent.id, 60_000)
    client.close()
  })

  it('a close for an agent that is not the one asked about changes nothing', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'close-changed')
    expect(await close(client, { ...agent, sessionId: 'another-conversation' }, 'now')).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(await close(client, { ...agent, createdAt: new Date(0).toISOString() }, 'now')).toMatchObject({ error: 'AGENT_CHANGED' })
    expect((await client.request('agent_close', { agentId: agent.id, mode: 'now' }, 30_000)).error).toBe('INVALID_CLOSE_REQUEST')
    await turn(client, agent.id, 'untouched')
    client.close()
  })

  it.each(engines)('%s: found by search until purged; purged, nothing of the conversation is left', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `purge-${engine}`)
    const word = `zebrafish${engine}`
    await turn(client, agent.id, `remember the ${word}`)
    await until('search to find the conversation', async () => {
      const found = await client.request('session_search', { query: word }, 30_000)
      return JSON.stringify(found).includes(agent.sessionId) ? found : null
    }, 60_000, 1_000)
    const files = transcriptsOf(d, agent.sessionId)
    expect(files.length).toBeGreaterThan(0)
    const createdAt = Date.parse(agent.createdAt)
    const review = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'inspect' }, 60_000)
    expect(review.error, JSON.stringify(review)).toBeUndefined()
    expect(review.reviewId).toBeTruthy()
    // A review is used once: a delete with a made-up one is refused, and nothing goes.
    const forged = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'delete', reviewId: 'not-a-review' }, 60_000)
    expect(forged.error).toBe('DELETE_REFUSED')
    expect((await row(client, agent.id))?.status).toBe('active')
    const deleted = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'delete', reviewId: review.reviewId }, 90_000)
    expect(deleted, JSON.stringify(deleted)).toMatchObject({ deleted: true, sessionDeleted: true })
    for (const file of files) expect(existsSync(file), file).toBe(false)
    await until('the agent to be gone', async () => !(await row(client, agent.id)) || null, 30_000, 500)
    expect((await client.request('session_get', { sessionId: agent.sessionId, limit: 10 }, 30_000)).error).toBe('NOT_FOUND')
    await until('search to forget it', async () => {
      const found = await client.request('session_search', { query: word }, 30_000)
      return JSON.stringify(found).includes(agent.sessionId) ? null : found
    }, 30_000, 1_000)
    client.close()
  })
})
