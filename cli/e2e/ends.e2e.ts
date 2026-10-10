/**
 * How an agent's life ends, for Claude Code and Codex: closed now, closed only when idle, closed after
 * its task (and that intent cancelled, or carried across a daemon restart, whether the turn ends while
 * the daemon is stopped or another begins meanwhile), and purged with its history — and the search
 * that finds a conversation until it is purged. A close never takes a turn that is still working unless
 * it was asked to; a purge leaves nothing of the conversation behind.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
/** Whether the conversation's transcript holds this text yet: what the engine has done, read with the
 *  daemon stopped. */
const written = (daemon: IsolatedDaemon, agent: Record<string, any>, text: string): boolean =>
  transcriptsOf(daemon, agent.sessionId).some((file) => readFileSync(file, 'utf8').includes(text))
/** Closed once: one window frame said so, and two more ticks of the close service later still only one. */
async function closedOnce(client: LocalClient, agent: Record<string, any>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 11_000))
  expect(client.frames.filter((frame) => frame.type === 'agent_deleted' && frame.payload?.agentId === agent.id)).toHaveLength(1)
}
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

  it.each(engines)('%s: unavailable transcript identity holds Close and Resume until the same conversation is restored', async engine => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `identity-hold-${engine}`)
    await turn(client, agent.id, 'History that must survive')
    const paths = transcriptsOf(d, agent.sessionId)
    expect(paths).toHaveLength(1)
    const file = paths[0], original = readFileSync(file, 'utf8')
    const lines = original.split('\n'), first = JSON.parse(lines[0])
    if (engine === 'codex') first.payload.id = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
    else first.sessionId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
    lines[0] = JSON.stringify(first)
    const foreign = lines.join('\n')
    writeFileSync(file, foreign)
    expect(await close(client, agent, 'now')).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', detail: expect.any(String) })
    expect(await row(client, agent.id)).toMatchObject({ status: 'active', sessionId: agent.sessionId })
    expect(client.frames.filter(frame => frame.type === 'agent_deleted' && frame.payload?.agentId === agent.id)).toHaveLength(0)
    expect((await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}')).trim().split('\n')).toContain(agent.tmuxPane)
    writeFileSync(file, original)
    expect(await close(client, agent, 'now')).toMatchObject({ closed: true })
    await stopped(client, agent.id)
    const saved = readFileSync(file, 'utf8')
    writeFileSync(file, foreign)
    const refused = await client.request('agent_resume', { agentId: agent.id }, 90_000)
    expect(refused).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', detail: expect.any(String) })
    expect(await row(client, agent.id)).toMatchObject({ status: 'stopped', sessionId: agent.sessionId })
    expect(readFileSync(file, 'utf8')).toBe(foreign)
    writeFileSync(file, saved)
    expect((await client.request('agent_resume', { agentId: agent.id }, 90_000)).error).toBeUndefined()
    await until('the held conversation to resume', async () => {
      const latest = await row(client, agent.id)
      return latest?.status === 'active' && latest.sessionId === agent.sessionId ? latest : null
    }, 60_000, 500)
    await turn(client, agent.id, 'History survives the hold')
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

  it.each(engines)('%s: a close after its task whose turn ends while the daemon is stopped is carried out once it is back', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `close-while-down-${engine}`)
    client.send('message', { agentId: agent.id, content: '!slow 3000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    expect(await close(client, agent, 'after_task')).toMatchObject({ deferred: true })
    client.close()
    await d.stop()
    // The turn ends with nothing listening: its answer reaches the transcript, and its hooks no one.
    await until('the turn to end while the daemon is stopped', () => written(d, agent, 'answer 1: !slow 3000'), 30_000, 250)
    await d.start()
    client = await LocalClient.connect(d)
    await stopped(client, agent.id, 60_000)
    await closedOnce(client, agent)
    client.close()
  })

  it.each(engines)('%s: a close after its task waits for a turn begun while the daemon was stopped, then is carried out once', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `close-busy-again-${engine}`)
    client.send('message', { agentId: agent.id, content: '!slow 2000' })
    await client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    expect(await close(client, agent, 'after_task')).toMatchObject({ deferred: true })
    client.close()
    await d.stop()
    await until('the first turn to end while the daemon is stopped', () => written(d, agent, 'answer 1: !slow 2000'), 30_000, 250)
    // The person starts another task in the terminal before the daemon is back. It runs longer than the
    // two idle looks five seconds apart that a close waits for, so a daemon that took it for idle would
    // close the agent in the middle of it.
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, '!slow 30000', 'Enter')
    await until('the second turn to start while the daemon is stopped', () => written(d, agent, '!slow 30000'), 30_000, 250)
    await d.start()
    client = await LocalClient.connect(d)
    // The daemon back reads that turn as open from the conversation itself, ahead of anything on screen:
    // what holds the close.
    await until('the daemon to see the second turn working', async () =>
      (await close(client, agent, 'inspect')).activity === 'working' || null, 15_000, 500)
    // Never while that turn is working: the agent is still there each time it is looked at, until the
    // turn has written its answer.
    await until('the second turn to end', async () => {
      const done = written(d, agent, 'answer 2: !slow 30000')
      if (!done) expect((await row(client, agent.id))?.status, 'closed while it was working').toBe('active')
      return done
    }, 60_000, 500)
    await stopped(client, agent.id, 60_000)
    await closedOnce(client, agent)
    client.close()
  })

  it('codex: an agent between the turns of its goal is not closed after its task until the goal is done', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'close-goal')
    // Codex 0.160 between the turns of a goal: its composer empty, `Pursuing goal` on its status line.
    await turn(client, agent.id, '!goal')
    expect(await close(client, agent, 'inspect')).toMatchObject({ activity: 'working' })
    expect(await close(client, agent, 'after_task')).toMatchObject({ deferred: true })
    // Two idle looks five seconds apart would have closed it by now.
    await new Promise((resolve) => setTimeout(resolve, 13_000))
    expect((await row(client, agent.id))?.status).toBe('active')
    await turn(client, agent.id, '!goal done')
    await stopped(client, agent.id, 60_000)
    client.close()
  })

  it('codex: browsing its transcript is someone at the pane, so a close only when idle waits', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'close-browsing')
    await turn(client, agent.id, '!browse')
    expect(await close(client, agent, 'inspect')).toMatchObject({ activity: 'needs_input' })
    expect(await close(client, agent, 'idle')).toMatchObject({ error: 'SESSION_NOT_IDLE', activity: 'needs_input' })
    // Esc leaves it, as in Codex, and the agent reads idle again.
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    await until('the agent to read idle again', async () => (await close(client, agent, 'inspect')).activity === 'idle' || null, 15_000, 500)
    expect((await row(client, agent.id))?.status).toBe('active')
    client.close()
  })

  // A failed start (Claude Code that cannot reach Anthropic) keeps its pane on the shell it leaves,
  // where its last screen says why: agent_deleted names that shell as `successor`. An agent that
  // exits after doing work still ends as before (#262).
  it('an agent that exits before any conversation hands its pane to the shell; one after a turn does not', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const early = await create(d, client, 'claude', 'exit-at-start')
    const gone = client.next((frame) => frame.type === 'agent_deleted' && frame.payload?.agentId === early.id, 45_000, 'agent_deleted (early)')
    client.send('message', { agentId: early.id, content: '!exit' })
    const deleted = await gone
    const successor = deleted.payload?.successor as string | undefined
    expect(successor, JSON.stringify(deleted.payload)).toBeTruthy()
    const shell = await until('the successor shell row', async () => (await row(client, successor!)) ?? null, 30_000, 500)
    expect(shell.engine).toBe('terminal')

    const worked = await create(d, client, 'claude', 'exit-after-work')
    await turn(client, worked.id, 'a real first task')
    const ended = client.next((frame) => frame.type === 'agent_deleted' && frame.payload?.agentId === worked.id, 45_000, 'agent_deleted (after work)')
    client.send('message', { agentId: worked.id, content: '!exit' })
    expect((await ended).payload?.successor).toBeUndefined()
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
    // A location is not authority to delete it. Hold this exact unexpired confirmation while
    // its native header is incomplete; restoring the same file permits the reviewed retry.
    const transcript = files[0], original = readFileSync(transcript, 'utf8')
    writeFileSync(transcript, '{')
    const held = await client.request('agent_purge', { agentId: agent.id, sessionId: agent.sessionId, createdAt, mode: 'delete', reviewId: review.reviewId }, 60_000)
    expect(held, JSON.stringify(held)).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true, stopped: false })
    expect(held.detail).toEqual(expect.any(String))
    expect((await row(client, agent.id))?.status).toBe('active')
    expect(readFileSync(transcript, 'utf8')).toBe('{')
    writeFileSync(transcript, original)
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
