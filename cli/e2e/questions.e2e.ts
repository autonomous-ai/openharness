/**
 * An agent's question, end to end, for Claude Code and Codex: the dialog the engine draws reaches the
 * window as a question, the answer chosen there is typed into the dialog and is the one the agent gets,
 * and an answer to a question that is no longer the one on screen types nothing.
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
  const started = client.next(isTurn('turn_started', agentId), 45_000, 'turn_started')
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, 'turn_ended')
  client.send('message', { agentId, content })
  await started
  await ended
}
/** An answer goes back under the question's own request id, which is how the client knows which. */
async function answer(client: LocalClient, agentId: string, requestId: string, answers: Record<string, string>): Promise<Record<string, any>> {
  const reply = client.next((frame) => frame.type === 'question_response_result' && frame.payload?.requestId === requestId, 45_000, 'question_response_result')
  client.send('question_response', { requestId, agentId, answers })
  return (await reply).payload as Record<string, any>
}

describe('an agent asks a question', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: the question reaches the window, and the answer chosen there is the one the agent gets', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `ask-${engine}`)
    const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!ask' })
    const question = await asked
    const shaped = question.payload?.questions?.[0]
    expect(shaped?.q).toBe('Which drink would you like?')
    expect(shaped?.options).toEqual(expect.arrayContaining(['Tea', 'Coffee']))
    expect((await row(client, agent.id))?.status).toBe('active')

    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    const result = await answer(client, agent.id, question.payload.requestId, { [shaped.q]: 'Coffee' })
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain('you chose Coffee')
    await turn(client, agent.id, 'after the question')
    client.close()
  })

  it.each(engines)('%s: an answer to a question that is not the one on screen types nothing', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `stale-${engine}`)
    const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!ask' })
    const question = await asked
    const shaped = question.payload?.questions?.[0]
    const stale = await answer(client, agent.id, 'q_not_this_one', { [shaped.q]: 'Tea' })
    expect(stale.error, JSON.stringify(stale)).toBeTruthy()
    expect(await d.capture(agent.tmuxPane)).not.toContain('you chose')
    // The real question is still open, and still answerable.
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    expect((await answer(client, agent.id, question.payload.requestId, { [shaped.q]: 'Tea' })).error).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain('you chose Tea')
    client.close()
  })
})
