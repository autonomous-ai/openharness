/**
 * Turns ending the ways people end them, for Claude Code and Codex, on the real daemon: cancelled from
 * the app, interrupted with Ctrl-C in the terminal itself, and watched by more than one window at once.
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
async function create(daemon: IsolatedDaemon, client: LocalClient, engine: Engine, folder: string): Promise<Record<string, any>> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return bound(client, created.agent.id)
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 45_000, 'turn_started')
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, 'turn_ended')
  client.send('message', { agentId, content })
  await started
  await ended
}
const settled = (client: LocalClient, agentId: string) =>
  until('the agent to read as not working', async () => {
    const agent = await row(client, agentId)
    return agent && agent.activity?.state !== 'working' ? agent : null
  }, 30_000, 250)

describe('how turns end', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: a turn cancelled from the app stops reading as working, and the next message is a fresh turn', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `cancel-${engine}`)
    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!hold' })
    await started
    await until('the agent to read as working', async () => (await row(client, agent.id))?.activity?.state === 'working' || null, 15_000, 250)
    client.send('cancel', { agentId: agent.id })
    await settled(client, agent.id)
    await turn(client, agent.id, 'after the cancel')
    client.close()
  })

  it.each(engines)('%s: Ctrl-C typed in the terminal itself ends the turn, and the agent goes on', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `ctrl-c-${engine}`)
    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!hold' })
    await started
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'C-c')
    await settled(client, agent.id)
    await turn(client, agent.id, 'after Ctrl-C in the pane')
    client.close()
  })

  it('every window watching sees the same turn, and one that connects in the middle sees it running', async () => {
    const d = await fresh()
    const first = await LocalClient.connect(d)
    const second = await LocalClient.connect(d)
    const agent = await create(d, first, 'claude', 'two-windows')
    const startedThere = second.next(isTurn('turn_started', agent.id), 30_000, 'turn_started in the second window')
    const endedThere = second.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended in the second window')
    const startedHere = first.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    first.send('message', { agentId: agent.id, content: '!slow 4000' })
    await startedHere
    expect((await startedThere).payload?.userMessage).toBe('!slow 4000')
    const late = await LocalClient.connect(d)
    expect((await row(late, agent.id))?.activity?.state).toBe('working')
    await endedThere
    await settled(late, agent.id)
    for (const client of [first, second, late]) client.close()
  })
})
