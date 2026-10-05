/**
 * Compaction, for Claude Code and Codex: `/compact` between turns and an automatic compaction in the
 * middle of one. Claude Code announces the same session again after it, and the daemon re-reads the
 * transcript while it still tails it — the path where turns used to be shown twice or lost. Every turn
 * after a compaction starts and ends once, live, and the history still reads back whole.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']

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
/** Types the compaction command into the pane, as a person types `/compact`. */
async function compact(daemon: IsolatedDaemon, client: LocalClient, agent: Record<string, any>): Promise<void> {
  await daemon.tmux.run('send-keys', '-t', agent.tmuxPane, '!compact', 'Enter')
  await until('the compaction to land', async () => (await daemon.capture(agent.tmuxPane)).includes('(compacted)') || null, 15_000, 100)
  // Claude Code's repeat SessionStart: let the re-read it causes finish.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}
const count = (client: LocalClient, since: number, type: string, agentId: string) =>
  client.frames.slice(since).filter(isTurn(type, agentId)).length
const users = async (client: LocalClient, sessionId: string): Promise<string[]> => {
  const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }>; error?: string }>('session_get', { sessionId, limit: 200 }, 30_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  return (page.events ?? []).filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
}

describe('compaction', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: after /compact every turn starts and ends once, live, and the history reads back whole', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `compact-${engine}`)
    for (const n of [1, 2, 3]) await turn(client, agent.id, `before ${n}`)
    await compact(d, client, agent)
    const since = client.frames.length
    for (const n of [1, 2, 3]) await turn(client, agent.id, `after ${n}`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(count(client, since, 'turn_started', agent.id)).toBe(3)
    expect(count(client, since, 'turn_ended', agent.id)).toBe(3)
    expect((await row(client, agent.id))?.status).toBe('active')
    expect(await users(client, agent.sessionId)).toEqual(['before 1', 'before 2', 'before 3', 'after 1', 'after 2', 'after 3'])
    client.close()
  })

  it.each(engines)('%s: a compaction in the middle of a turn: the turn ends once, and the next one is fresh', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `compact-mid-${engine}`)
    await turn(client, agent.id, 'a turn before')
    const since = client.frames.length
    await turn(client, agent.id, '!compactmid')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(count(client, since, 'turn_started', agent.id)).toBe(1)
    expect(count(client, since, 'turn_ended', agent.id)).toBe(1)
    const next = client.frames.length
    await turn(client, agent.id, 'the turn after')
    expect(count(client, next, 'turn_started', agent.id)).toBe(1)
    expect((await row(client, agent.id))?.activity?.state).not.toBe('working')
    client.close()
  })

  it('five compactions in a row, a turn after each: nothing doubles, nothing is lost', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'compact-five')
    const since = client.frames.length
    for (const n of [1, 2, 3, 4, 5]) {
      await compact(d, client, agent)
      await turn(client, agent.id, `turn ${n}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(count(client, since, 'turn_started', agent.id)).toBe(5)
    expect(count(client, since, 'turn_ended', agent.id)).toBe(5)
    const texts = client.frames.slice(since).filter((frame) => frame.type === 'text_delta' && frame.agentId === agent.id)
      .map((frame) => String(frame.payload?.content ?? ''))
    for (const n of [1, 2, 3, 4, 5]) expect(texts.filter((text) => text.includes(`: turn ${n}`)).length, `answer ${n}`).toBe(1)
    client.close()
  })

  it.each(engines)('%s: a compaction while the daemon is down: it comes back, and turns are live again', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `compact-down-${engine}`)
    await turn(client, agent.id, 'before')
    client.close()
    await d.stop()
    // The engine compacts while nobody watches: its SessionStart finds no daemon.
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, '!compact', 'Enter')
    await until('the compaction to land', async () => (await d.capture(agent.tmuxPane)).includes('(compacted)') || null, 15_000, 100)
    await d.start()
    client = await LocalClient.connect(d)
    await until('the agent to be back', async () => (await row(client, agent.id))?.status === 'active' || null, 60_000, 500)
    const since = client.frames.length
    await turn(client, agent.id, 'after the restart')
    expect(count(client, since, 'turn_started', agent.id)).toBe(1)
    client.close()
  })
})
