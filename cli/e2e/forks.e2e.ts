/**
 * Forks at their edges, for Claude Code and Codex: asked for in the middle of a turn, a fork of a fork, a
 * source stopped under its fork, and both coming back after a daemon restart. A fork is its own agent
 * with its own conversation from the moment it exists; nothing one does reaches the other.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
const engines: Engine[] = ['claude', 'codex']

const rows = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const bound = (client: LocalClient, agentId: string) =>
  until(`${agentId.slice(0, 8)} to bind its conversation`, async () => {
    const agent = await row(client, agentId)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return bound(client, created.agent.id)
}
async function fork(client: LocalClient, agentId: string, name: string): Promise<Record<string, any>> {
  const forked = await client.request('agent_fork', { agentId, name }, 90_000)
  expect(forked.error, JSON.stringify(forked)).toBeUndefined()
  const forkId: string = forked.agent?.id ?? forked.agentId ?? forked.session?.agentId
  expect(forkId).toBeTruthy()
  return bound(client, forkId)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
const users = async (client: LocalClient, sessionId: string): Promise<string[]> => {
  const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }>; error?: string }>('session_get', { sessionId, limit: 200 }, 30_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  return (page.events ?? []).filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
}

describe('forks at their edges', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: a fork asked for in the middle of a turn is refused with why, the turn goes on, and after it the fork is made', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const source = await create(d, client, engine, `fork-mid-turn-${engine}`)
    await turn(client, source.id, 'before the fork')
    const ended = client.next(isTurn('turn_ended', source.id), 45_000, 'the source turn_ended')
    client.send('message', { agentId: source.id, content: '!slow 3000' })
    await client.next(isTurn('turn_started', source.id), 30_000, 'the source turn_started')
    // Forking copies the conversation, and a turn half written is not one to copy.
    const refused = await client.request('agent_fork', { agentId: source.id, name: 'too early' }, 90_000)
    expect(refused.error, JSON.stringify(refused)).toBe('AGENT_BUSY')
    expect(String(refused.detail)).toContain('middle of a turn')
    await ended
    const child = await fork(client, source.id, 'after the turn')
    expect(child.sessionId).not.toBe(source.sessionId)
    await turn(client, child.id, 'in the fork')
    await turn(client, source.id, 'in the source')
    expect(await users(client, child.sessionId)).not.toContain('in the source')
    expect(await users(client, source.sessionId)).not.toContain('in the fork')
    expect((await rows(client)).filter((agent) => agent.status === 'active')).toHaveLength(2)
    client.close()
  })

  it.each(engines)('%s: a fork of a fork is a third agent with a third conversation', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const first = await create(d, client, engine, `fork-of-fork-${engine}`)
    await turn(client, first.id, 'the first conversation')
    const second = await fork(client, first.id, 'second')
    await turn(client, second.id, 'the second conversation')
    const third = await fork(client, second.id, 'third')
    expect(new Set([first.sessionId, second.sessionId, third.sessionId]).size).toBe(3)
    expect(new Set([first.tmuxPane, second.tmuxPane, third.tmuxPane]).size).toBe(3)
    await Promise.all([first, second, third].map((agent, i) => turn(client, agent.id, `turn in agent ${i}`)))
    client.close()
  })

  it.each(engines)('%s: the source stopped under its fork: the fork goes on, and the source resumes its own conversation', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const source = await create(d, client, engine, `fork-stop-source-${engine}`)
    await turn(client, source.id, 'before the fork')
    const child = await fork(client, source.id, 'the fork')
    expect((await client.request('agent_delete', { agentId: source.id }, 60_000)).error).toBeUndefined()
    await until('the source to stop', async () => (await row(client, source.id))?.status === 'stopped' || null, 45_000, 500)
    await turn(client, child.id, 'the fork after the source stopped')
    expect((await row(client, child.id))?.status).toBe('active')
    expect((await client.request('agent_resume', { agentId: source.id }, 90_000)).error).toBeUndefined()
    const back = await bound(client, source.id)
    expect(back.sessionId).toBe(source.sessionId)
    await turn(client, source.id, 'the source after its resume')
    client.close()
  })

  // A Codex agent moved back off a grid relaunches on the model it had before (the row's
  // `subscriptionModel`, `-m`) and on its own provider (`-c model_provider=…`), as a restart and a resume
  // build it (launch.ts `relaunchOverrides`). A fork was launched without either, and came back on Codex's
  // default model.
  it('codex: a fork of an agent moved back to its own login runs on that agent\'s model, as its restart does', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const source = await create(d, client, 'codex', 'fork-own-login')
    await turn(client, source.id, 'before the move back')
    // The model the agent runs, as the frame names it (`runtime-v1:<session>:codex:<model>@<effort>`).
    const model = async (agentId: string) => /:codex:([^@]+)@/.exec(String((await row(client, agentId))?.selectedModel))?.[1]
    expect(await model(source.id)).toBe('gpt-6')
    client.close()
    await d.stop()
    // What a move back off a grid leaves on the row (retarget.ts `setSubscriptionModel`): the model to come
    // back to. No grid is reachable from a test, so the row is given what that move would have written.
    const file = join(d.dataDir, 'registry.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    const entry = saved.find((one) => one.agentId === source.id)
    expect(entry, JSON.stringify(saved)).toBeTruthy()
    entry!.subscriptionModel = 'gpt-6-mini'
    writeFileSync(file, JSON.stringify(saved))
    await d.start()
    client = await LocalClient.connect(d)
    await bound(client, source.id)
    const child = await fork(client, source.id, 'the fork')
    await turn(client, child.id, 'in the fork')
    expect(await model(child.id)).toBe('gpt-6-mini')
    // The same model a restart of the source comes back on.
    expect((await client.request('agent_restart', { agentId: source.id }, 90_000)).error).toBeUndefined()
    await bound(client, source.id)
    await turn(client, source.id, 'after the restart')
    expect(await model(source.id)).toBe('gpt-6-mini')
    client.close()
  })

  it.each(engines)('%s: after a daemon restart the source and its fork are both back, each on its own conversation', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const source = await create(d, client, engine, `fork-restart-${engine}`)
    await turn(client, source.id, 'before the fork')
    const child = await fork(client, source.id, 'the fork')
    await turn(client, child.id, 'the fork before the restart')
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    const [sourceBack, childBack] = await Promise.all([source, child].map((agent) => until(`${agent.id.slice(0, 8)} back`, async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
    }, 60_000, 500)))
    expect(sourceBack.tmuxPane).not.toBe(childBack.tmuxPane)
    await Promise.all([source, child].map((agent) => turn(client, agent.id, `after the restart in ${agent.id.slice(0, 8)}`)))
    client.close()
  })
})
