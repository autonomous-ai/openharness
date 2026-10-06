/**
 * A full desk, for Claude Code and Codex together, on the real daemon: many agents created at once, a
 * turn each in parallel, then a daemon restart that brings every one of them back with its
 * conversation, and a turn each again. What it checks is what a crowded machine notices first: the
 * core holds, every turn reaches the window, the restart's attaches finish in bounded time, and the
 * core's memory stays bounded by the work rather than growing with the desk.
 *
 * `SCALE_AGENTS` sets the size, 24 by default. The design's own bar is 50 panes:
 * `SCALE_AGENTS=50 npm run test:e2e -- scale`. Each agent is a fake engine process and a tmux pane, so
 * 50 needs a few GB of memory free.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const AGENTS = Number(process.env.SCALE_AGENTS ?? 24)

type Row = Record<string, any>
const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 60_000)).agents
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 120_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 120_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}
/** The lowest of a few samples: what the process holds, not a moment's garbage before a collection. */
async function settledRss(daemon: IsolatedDaemon): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < 5; i++) { samples.push(await daemon.rssMiB()); await new Promise((resolve) => setTimeout(resolve, 1_000)) }
  return Math.min(...samples)
}

describe('a full desk', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it(`${AGENTS} agents, half Claude Code and half Codex: created together, a turn each, through a restart, and back`, async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    let client = await LocalClient.connect(d)
    const rssEmpty = await settledRss(d)

    // Created together, as a restored desk or a script making a team does.
    const engines = Array.from({ length: AGENTS }, (_, i) => (i % 2 ? 'codex' : 'claude') as 'claude' | 'codex')
    const created = await Promise.all(engines.map(async (engine, i) => {
      const cwd = join(d.projectsDir, `desk-${i}`)
      mkdirSync(cwd, { recursive: true })
      const answer = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 180_000)
      expect(answer.error, `agent ${i}: ${JSON.stringify(answer)}`).toBeUndefined()
      return answer.agent.id as string
    }))
    const bound = await until(`all ${AGENTS} agents to bind`, async () => {
      const now = await rows(client)
      const ready = created.map((id) => now.find((row) => row.id === id)).filter((row): row is Row => !!row?.sessionId && row.status === 'active')
      return ready.length === AGENTS ? ready : null
    }, 240_000, 1_000)
    const sessions = new Map(bound.map((row) => [row.id as string, row.sessionId as string]))

    // A turn each, all at once: every one reaches the window as itself.
    await Promise.all(created.map((id, i) => turn(client, id, `desk turn ${i}`)))
    client.frames.splice(0, client.frames.length)
    const rssWorking = await settledRss(d)

    // A restart: every agent comes back with its conversation, in bounded time.
    client.close()
    const restartedAt = Date.now()
    await d.restart()
    client = await LocalClient.connect(d)
    await until(`all ${AGENTS} agents back after the restart`, async () => {
      const now = await rows(client)
      const back = created.filter((id) => {
        const row = now.find((one) => one.id === id)
        return row?.status === 'active' && row.sessionId === sessions.get(id)
      })
      return back.length === AGENTS || null
    }, 240_000, 1_000)
    const backInMs = Date.now() - restartedAt

    // And they work: a turn each again, all at once.
    await Promise.all(created.map((id, i) => turn(client, id, `after the restart ${i}`)))
    client.frames.splice(0, client.frames.length)
    const rssAfter = await settledRss(d)

    const report = `${AGENTS} agents · rss empty ${rssEmpty.toFixed(0)} → working ${rssWorking.toFixed(0)} → after the restart ${rssAfter.toFixed(0)} MiB · back in ${(backInMs / 1000).toFixed(1)} s`
    if (process.env.SCALE_REPORT) writeFileSync(process.env.SCALE_REPORT, `${report}\n`)
    // Bounded by the work, not the desk: a few MiB an agent at most, measured from an empty core.
    expect(rssWorking - rssEmpty, report).toBeLessThan(64 + AGENTS * 6)
    expect(rssAfter - rssEmpty, report).toBeLessThan(64 + AGENTS * 6)
    // Every attach after the restart is bounded: back well inside the master's start-up deadline.
    expect(backInMs, report).toBeLessThan(120_000)
    expect(d.coresStarted()).toBe(2)
    client.close()
  }, 900_000)
})
