/**
 * Everyday edges of the core, for Claude Code and Codex, on the real daemon: folders whose names are
 * not plain ASCII, a folder that is not there, a long message and messages that are not plain ASCII,
 * messages sent faster than an agent can answer, forking an agent, and renaming one.
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
const bound = (client: LocalClient, agentId: string) =>
  until(`${agentId.slice(0, 8)} to bind its conversation`, async () => {
    const agent = await row(client, agentId)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<string> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return created.agent.id
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<Frame> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, 'turn_started')
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, 'turn_ended')
  client.send('message', { agentId, content })
  const opened = await started
  await ended
  return opened
}

describe('the everyday edges', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: folders named with spaces, accents, CJK and quotes', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    for (const folder of ['my project', 'café-déjà vu', '项目 プロジェクト', `it's "quoted"`]) {
      const id = await create(d, client, engine, folder)
      const agent = await bound(client, id)
      // The frame names the folder as its project (agentFrame.ts).
      expect(JSON.stringify(agent.project ?? null), folder).toContain(folder.split(' ')[0])
      await turn(client, id, `hello from ${folder}`)
    }
    client.close()
  })

  it('a folder that is not there is refused, and nothing is left behind', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const missing = await client.request('agent_create', { engine: 'claude', cwd: join(d.projectsDir, 'no', 'such', 'folder'), bypassPermission: true }, 60_000)
    expect(missing.error, JSON.stringify(missing)).toBeTruthy()
    expect((await client.request('agents_list', {})).agents).toEqual([])
    client.close()
  })

  it.each(engines)('%s: a long message and messages that are not plain ASCII arrive whole', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `text-${engine}`)
    await bound(client, id)
    const long = Array.from({ length: 2_000 }, (_, i) => `line ${i}: the quick brown fox`).join(' ')
    for (const content of [long, 'xin chào — 你好 — こんにちは — مرحبا — 🙂🚀', 'tabs\tand  double  spaces']) {
      const opened = await turn(client, id, content)
      expect(opened.payload?.userMessage, content.slice(0, 40)).toBe(content)
    }
    client.close()
  })

  it.each(engines)('%s: five messages sent faster than the agent answers are all answered, in order', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `burst-${engine}`)
    await bound(client, id)
    const asked = ['one', 'two', 'three', 'four', 'five']
    const before = client.frames.length
    for (const content of asked) client.send('message', { agentId: id, content })
    await until('five turns to end', () => client.frames.slice(before).filter(isTurn('turn_ended', id)).length >= asked.length || null, 90_000, 250)
    const started = client.frames.slice(before).filter(isTurn('turn_started', id)).map((frame) => frame.payload?.userMessage)
    expect(started).toEqual(asked)
    client.close()
  })

  it.each(engines)('%s: a fork is its own agent with its own conversation, and the original goes on', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `fork-${engine}`)
    const original = await bound(client, id)
    await turn(client, id, 'before the fork')
    const forked = await client.request('agent_fork', { agentId: id, name: 'the fork' }, 90_000)
    expect(forked.error, JSON.stringify(forked)).toBeUndefined()
    const forkId: string = forked.agent?.id ?? forked.agentId ?? forked.session?.agentId
    expect(forkId).toBeTruthy()
    expect(forkId).not.toBe(id)
    const fork = await bound(client, forkId)
    expect(fork.sessionId).not.toBe(original.sessionId)
    await turn(client, forkId, 'in the fork')
    await turn(client, id, 'in the original')
    client.close()
  })

  it.each(engines)('%s: a renamed agent keeps its name across a restart', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const id = await create(d, client, engine, `rename-${engine}`)
    await bound(client, id)
    const renamed = await client.request('agent_update', { agentId: id, name: 'Release checklist ✅' }, 30_000)
    expect(renamed.error, JSON.stringify(renamed)).toBeUndefined()
    await until('the new name in the list', async () => (await row(client, id))?.name === 'Release checklist ✅' || null, 15_000, 250)
    await d.restart()
    const again = await LocalClient.connect(d)
    await until('the name after a restart', async () => (await row(again, id))?.name === 'Release checklist ✅' || null, 45_000, 500)
    again.close()
    client.close()
  })
})
