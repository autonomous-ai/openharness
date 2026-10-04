/**
 * A thread's history read back page by page, for Claude Code and Codex, as a phone or the web scrolls
 * it (`session_get` with a limit and a cursor): every message comes back exactly once and in order,
 * whatever the page size, while turns are still being written, from two windows at once, across a
 * daemon restart, across a resume and across a compaction. Requests that cannot be served are
 * answered, never crashed on.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']
type Event = { type: string; payload: Record<string, any> }
type Page = { events: Event[]; hasMore?: boolean; oldestCursor?: string | null; staleCursor?: boolean; error?: string }

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
async function turns(client: LocalClient, agentId: string, from: number, to: number): Promise<void> {
  for (let i = from; i <= to; i++) await turn(client, agentId, `question ${i}`)
}
const asked = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `question ${from + i}`)
/** The fake engine numbers its answers by turn, so a resumed engine starts its count again. */
const answered = (from: number, to: number, turnFrom = from) => asked(from, to).map((question, i) => `answer ${turnFrom + i}: ${question}`)

/** The engine's own transcript files for a conversation, found where the fake engines write them. */
function transcriptsOf(daemon: IsolatedDaemon, sessionId: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>
    try { entries = readdirSync(dir, { withFileTypes: true }) as never } catch { return }
    for (const entry of entries) {
      const path = join(dir, String(entry.name))
      if (entry.isDirectory()) walk(path)
      else if (String(entry.name).endsWith('.jsonl') && String(entry.name).includes(sessionId)) found.push(path)
    }
  }
  walk(join(daemon.root, 'claude'))
  walk(join(daemon.root, 'codex'))
  return found
}

const page = (client: LocalClient, sessionId: string, limit: unknown, before?: string): Promise<Page> =>
  client.request<Page>('session_get', { sessionId, limit, ...(before ? { before } : {}) }, 60_000)

/** Every page from the newest back to the first, as a client scrolling up collects them, oldest first. */
async function thread(client: LocalClient, sessionId: string, limit: number, between?: (pageIndex: number) => Promise<void>) {
  const pages: Page[] = []
  let before: string | undefined
  for (let n = 0; n < 2_000; n++) {
    const next = await page(client, sessionId, limit, before)
    expect(next.error, JSON.stringify(next)).toBeUndefined()
    expect(next.staleCursor, `page ${n} (limit ${limit})`).toBeUndefined()
    pages.unshift(next)
    if (!next.hasMore || !next.oldestCursor) break
    expect(next.oldestCursor, `page ${n} moves back`).not.toBe(before)
    before = next.oldestCursor
    await between?.(n)
  }
  const events = pages.flatMap((one) => one.events)
  return {
    pages: pages.length,
    users: events.filter((event) => event.type === 'user_message').map((event) => String(event.payload.content)),
    answers: events.filter((event) => event.type === 'text_delta').map((event) => String(event.payload.content)),
  }
}

describe('a thread read back page by page', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: every message once and in order, whatever the page size', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `pages-${engine}`)
    await turns(client, agent.id, 1, 30)
    for (const limit of [1, 2, 7, 50, 500]) {
      const read = await thread(client, agent.sessionId, limit)
      expect(read.users, `limit ${limit}`).toEqual(asked(1, 30))
      expect(read.answers, `limit ${limit}`).toEqual(answered(1, 30))
      // A page's limit counts turns: one a page is a page a turn.
      if (limit === 1) expect(read.pages).toBeGreaterThanOrEqual(30)
    }
    client.close()
  })

  it.each(engines)('%s: turns written while a client pages back leave the older pages as they were', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `paging-while-${engine}`)
    await turns(client, agent.id, 1, 10)
    let next = 11
    // Between the first pages, the agent answers three more messages.
    const read = await thread(client, agent.sessionId, 4, async (pageIndex) => {
      if (pageIndex < 3) await turn(client, agent.id, `question ${next++}`)
    })
    expect(read.users).toEqual(asked(1, 10))
    expect(read.answers).toEqual(answered(1, 10))
    const again = await thread(client, agent.sessionId, 4)
    expect(again.users).toEqual(asked(1, 13))
    expect(again.answers).toEqual(answered(1, 13))
    client.close()
  })

  it('two windows paging at once while the agent keeps working each read a whole thread, nothing missing or repeated', async () => {
    const d = await fresh()
    const writer = await LocalClient.connect(d)
    const agent = await create(d, writer, 'codex', 'two-readers')
    await turns(writer, agent.id, 1, 12)
    const [first, second] = [await LocalClient.connect(d), await LocalClient.connect(d)]
    let working = true
    const working$ = (async () => { for (let i = 13; working && i <= 40; i++) await turn(writer, agent.id, `question ${i}`) })()
    const [a, b] = await Promise.all([thread(first, agent.sessionId, 3), thread(second, agent.sessionId, 11)])
    working = false
    await working$
    for (const read of [a, b]) {
      // Whatever was written when the newest page was read, from the first message on: no gap, no repeat.
      expect(read.users.length).toBeGreaterThanOrEqual(12)
      expect(read.users).toEqual(asked(1, read.users.length))
      expect(read.answers).toEqual(answered(1, read.answers.length))
      expect(read.users.length - read.answers.length).toBeGreaterThanOrEqual(0)
      expect(read.users.length - read.answers.length).toBeLessThanOrEqual(1)
    }
    for (const client of [writer, first, second]) client.close()
  })

  it.each(engines)('%s: a cursor taken before a daemon restart reads on after it', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `cursor-restart-${engine}`)
    await turns(client, agent.id, 1, 12)
    const newest = await page(client, agent.sessionId, 6)
    expect(newest.hasMore).toBe(true)
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    await until('the agent to be back', async () => (await row(client, agent.id))?.status === 'active' || null, 60_000, 500)
    const pages: Page[] = [newest]
    let before = newest.oldestCursor ?? undefined
    while (before) {
      const older = await page(client, agent.sessionId, 6, before)
      expect(older.staleCursor).toBeUndefined()
      pages.unshift(older)
      before = older.hasMore ? older.oldestCursor ?? undefined : undefined
    }
    const events = pages.flatMap((one) => one.events)
    expect(events.filter((event) => event.type === 'user_message').map((event) => event.payload.content)).toEqual(asked(1, 12))
    client.close()
  })

  it.each(engines)('%s: a resumed conversation reads back across the resume', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `resume-${engine}`)
    await turns(client, agent.id, 1, 5)
    expect((await client.request('agent_delete', { agentId: agent.id }, 60_000)).error).toBeUndefined()
    await until('the agent to stop', async () => (await row(client, agent.id))?.status === 'stopped' || null, 45_000, 500)
    expect((await client.request('agent_resume', { agentId: agent.id }, 90_000)).error).toBeUndefined()
    await until('the agent to be back', async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
    }, 60_000, 500)
    await turns(client, agent.id, 6, 10)
    const read = await thread(client, agent.sessionId, 4)
    expect(read.users).toEqual(asked(1, 10))
    expect(read.answers).toEqual([...answered(1, 5), ...answered(6, 10, 1)])
    client.close()
  })

  it.each(engines)('%s: a compaction in the middle of the thread pages through like any other record', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `compaction-${engine}`)
    await turns(client, agent.id, 1, 4)
    await turn(client, agent.id, '!grow 2')
    await turns(client, agent.id, 6, 9)
    const read = await thread(client, agent.sessionId, 3)
    expect(read.users).toEqual([...asked(1, 4), '!grow 2', ...asked(6, 9)])
    expect(read.answers).toEqual([...answered(1, 4), 'answer 5: !grow 2', ...answered(6, 9)])
    client.close()
  })

  it('requests that cannot be served are answered, and the daemon goes on', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'bad-pages')
    await turns(client, agent.id, 1, 3)
    expect((await client.request('session_get', {}, 30_000)).error).toBe('MISSING_SESSION_ID')
    expect((await client.request('session_get', { sessionId: 'no-such-session', limit: 5 }, 30_000)).error).toBe('NOT_FOUND')
    expect((await page(client, agent.sessionId, 5, 'a-cursor-from-nowhere')).staleCursor).toBe(true)
    // Limits that make no sense read as no limit, as the most a page may ask for, or rounded down.
    for (const limit of [0, -5, 'ten', 10_000, 2.5, null]) {
      const answer = await page(client, agent.sessionId, limit)
      expect(answer.error, `limit ${JSON.stringify(limit)}`).toBeUndefined()
      expect(Array.isArray(answer.events), `limit ${JSON.stringify(limit)}`).toBe(true)
    }
    // No limit is the newest page's worth: here, the whole short thread.
    expect((await page(client, agent.sessionId, null)).events.filter((event) => event.type === 'user_message').length).toBe(3)
    // The transcript removed under the agent: the page is empty, not an error, and the agent goes on.
    const files = transcriptsOf(d, agent.sessionId)
    expect(files).toHaveLength(1)
    rmSync(files[0])
    const gone = await page(client, agent.sessionId, 5)
    expect(gone.error, JSON.stringify(gone)).toBeUndefined()
    await turn(client, agent.id, 'after the transcript went')
    expect(client.closed).toBe(false)
    client.close()
  })
})
