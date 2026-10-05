/**
 * A new conversation in the same pane, for Claude Code and Codex — Claude Code's `/clear`, Codex's
 * `/new`: the engine ends one conversation and starts another without leaving the pane. The agent is
 * the same agent, under the same id, bound to the new conversation; its turns are seen; it comes back
 * bound to the new one after a restart, and resumes the new one after a stop. The person chose to leave
 * the old conversation, so it is not kept as a stopped harness, as one the daemon had to leave is
 * (updates.e2e.ts): people who clear often would pile up stopped rows.
 */
import { mkdirSync } from 'node:fs'
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
async function turn(client: LocalClient, agentId: string, content: string): Promise<Frame> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  const frame = await started
  await ended
  return frame
}
/** Types the new-conversation command into the pane itself, as a person does. */
async function newConversation(daemon: IsolatedDaemon, client: LocalClient, agent: Record<string, any>, from: string): Promise<Record<string, any>> {
  await daemon.tmux.run('send-keys', '-t', agent.tmuxPane, '!clear', 'Enter')
  return until('the agent to bind the new conversation', async () => {
    const now = await row(client, agent.id)
    return now?.sessionId && now.sessionId !== from && now.status === 'active' ? now : null
  }, 30_000, 250)
}
const users = async (client: LocalClient, sessionId: string): Promise<string[]> => {
  const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }>; error?: string }>('session_get', { sessionId, limit: 200 }, 30_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  return (page.events ?? []).filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
}

describe('a new conversation in the same pane', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: the agent keeps its id, binds the new conversation, and its turns are seen', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `rotate-${engine}`)
    await turn(client, agent.id, 'in the first conversation')
    const rotated = await newConversation(d, client, agent, agent.sessionId)
    expect(rotated.tmuxPane).toBe(agent.tmuxPane)
    const started = await turn(client, agent.id, 'in the second conversation')
    expect(started.payload?.userMessage).toBe('in the second conversation')
    expect(await users(client, rotated.sessionId)).toEqual(['in the second conversation'])
    // One agent for the pane, never a second minted beside it, and no stopped row for the one left.
    expect((await rows(client)).filter((one) => one.tmuxPane === agent.tmuxPane && one.status === 'active')).toHaveLength(1)
    expect((await rows(client)).filter((one) => one.status === 'stopped')).toEqual([])
    client.close()
  })

  it.each(engines)('%s: after a restart the agent is back on the new conversation', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `rotate-restart-${engine}`)
    await turn(client, agent.id, 'first')
    const rotated = await newConversation(d, client, agent, agent.sessionId)
    await turn(client, agent.id, 'second')
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    const back = await until('the agent to be back', async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' ? now : null
    }, 60_000, 500)
    expect(back.sessionId).toBe(rotated.sessionId)
    await turn(client, agent.id, 'third, after the restart')
    expect(await users(client, rotated.sessionId)).toEqual(['second', 'third, after the restart'])
    client.close()
  })

  it.each(engines)('%s: stopped and resumed after a new conversation, it resumes the new one', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `rotate-resume-${engine}`)
    await turn(client, agent.id, 'first')
    const rotated = await newConversation(d, client, agent, agent.sessionId)
    await turn(client, agent.id, 'second')
    expect((await client.request('agent_delete', { agentId: agent.id }, 60_000)).error).toBeUndefined()
    await until('the agent to stop', async () => (await row(client, agent.id))?.status === 'stopped' || null, 45_000, 500)
    expect((await client.request('agent_resume', { agentId: agent.id }, 90_000)).error).toBeUndefined()
    const resumed = await until('the agent to be back', async () => {
      const now = await row(client, agent.id)
      return now?.status === 'active' && now.sessionId ? now : null
    }, 60_000, 500)
    expect(resumed.sessionId).toBe(rotated.sessionId)
    await turn(client, agent.id, 'third, after the resume')
    expect(await users(client, rotated.sessionId)).toEqual(['second', 'third, after the resume'])
    client.close()
  })

  it.each(engines)('%s: a new conversation started in the middle of a turn ends that turn', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `rotate-mid-turn-${engine}`)
    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!hold' })
    await started
    await newConversation(d, client, agent, agent.sessionId)
    await until('the agent to read as not working', async () => {
      const now = await row(client, agent.id)
      return now && now.activity?.state !== 'working' ? now : null
    }, 30_000, 250)
    await turn(client, agent.id, 'a fresh turn in the new conversation')
    client.close()
  })

  it('two new conversations in a row: the agent follows both, and keeps its id', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'rotate-twice')
    const second = await newConversation(d, client, agent, agent.sessionId)
    const third = await newConversation(d, client, second, second.sessionId)
    expect(new Set([agent.sessionId, second.sessionId, third.sessionId]).size).toBe(3)
    await turn(client, agent.id, 'in the third conversation')
    expect(await users(client, third.sessionId)).toEqual(['in the third conversation'])
    expect((await rows(client)).filter((one) => one.status === 'stopped')).toEqual([])
    client.close()
  })
})
