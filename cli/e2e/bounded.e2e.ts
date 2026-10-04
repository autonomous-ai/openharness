/**
 * Memory follows activity, never history. On 2026-10-03 a Codex rollout of 803 MB crash-looped the
 * daemon at its 4 GB heap: attaching read the whole transcript. These run the daemon under a heap far
 * smaller than the transcripts it serves.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const HEAP_MIB = 256
const TRANSCRIPT_MIB = 300

describe('bounded memory', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it.each(['claude', 'codex'] as const)(`%s: a ${TRANSCRIPT_MIB} MiB transcript re-attaches under a ${HEAP_MIB} MiB heap`, async (engine) => {
    daemon = await IsolatedDaemon.create({ heapMiB: HEAP_MIB })
    const d = daemon
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-60).join('\n')}`) })
    await d.start()
    let client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, engine)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 60_000)
    const agentId: string = created.agent.id
    const row = async (c: LocalClient) => ((await c.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>)
      .find((agent) => agent.id === agentId)
    await until('the conversation to bind', async () => (await row(client))?.sessionId, 45_000, 250)

    const isEnd = (frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId
    const grown = client.next(isEnd, 170_000, 'the growing turn to end')
    client.send('message', { agentId, content: `!grow ${TRANSCRIPT_MIB}` })
    await grown
    expect(d.child, 'the daemon survived the live tail').not.toBeNull()

    await d.restart()
    client = await LocalClient.connect(d)
    const back = await until('the agent to be back', async () => {
      const agent = await row(client)
      return agent?.status && agent.status !== 'stopped' ? agent : null
    }, 60_000, 250)
    expect(back.status).not.toBe('stopped')
    const next = client.next(isEnd, 30_000, 'a turn after the restart')
    client.send('message', { agentId, content: 'still here?' })
    await next
    expect(d.child, 'the daemon survived the attach').not.toBeNull()
    expect(await d.rssMiB()).toBeLessThan(HEAP_MIB + 200)

    // A phone or the web opening the thread: its length, then page after page back into the turn that
    // wrote the 300 MiB — each page read on its own, never the whole file (lib/transcriptPages.ts).
    const sessionId: string = (await row(client))!.sessionId
    const listed = await client.request('sessions_list', { agentId })
    expect(listed.sessions[0].messageCount).toBeGreaterThan(TRANSCRIPT_MIB)
    let before: string | undefined
    let pages = 0
    for (; pages < 8; pages++) {
      const page = await client.request('session_get', { sessionId, limit: 50, before }, 60_000)
      expect(page.staleCursor, `page ${pages}`).toBeUndefined()
      // Compaction records render nothing, so a page inside the long turn can hold no events: what
      // matters is that every page moves back.
      expect(Array.isArray(page.events), `page ${pages}`).toBe(true)
      expect(page.oldestCursor, `page ${pages}`).not.toBe(before)
      if (!page.hasMore || !page.oldestCursor) break
      before = page.oldestCursor
    }
    expect(pages, 'pages read back into the long turn').toBe(8)
    // An app from before paging asks for the whole thread: it gets the newest page's worth, and a cursor.
    const whole = await client.request('session_get', { sessionId }, 60_000)
    expect(whole).toMatchObject({ hasMore: true })
    expect(d.child, 'the daemon survived the paging').not.toBeNull()
    expect(await d.rssMiB()).toBeLessThan(HEAP_MIB + 200)
  })
})

