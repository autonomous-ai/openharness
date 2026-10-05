/**
 * An agent's question at its edges, for Claude Code and Codex: asked while no window is open, answered
 * in the terminal by hand, answered by two windows at once, cancelled with Esc, and still open across a
 * daemon restart. Every window ends with the same answer to "is this question still open?", and the
 * agent gets exactly one answer.
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
const asked = (agentId: string) => (frame: Frame) => frame.type === 'commander_question' && frame.agentId === agentId
const closed = (requestId: string) => (frame: Frame) => frame.type === 'commander_question_close' && frame.payload?.requestId === requestId
async function answer(client: LocalClient, agentId: string, requestId: string, answers: Record<string, string>): Promise<Record<string, any>> {
  const reply = client.next((frame) => frame.type === 'question_response_result' && frame.payload?.requestId === requestId, 45_000, 'question_response_result')
  client.send('question_response', { requestId, agentId, answers })
  return (await reply).payload as Record<string, any>
}
/** The digit that picks Coffee in each engine's own dialog: Claude takes it, Codex takes it then Enter. */
async function pickInPane(daemon: IsolatedDaemon, engine: Engine, pane: string, keys: string[]): Promise<void> {
  for (const key of keys) await daemon.tmux.run('send-keys', '-t', pane, key)
  if (engine === 'codex' && keys[0] !== 'Escape') await daemon.tmux.run('send-keys', '-t', pane, 'Enter')
}

describe('a question at its edges', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    return d
  }

  it.each(engines)('%s: asked while no window is open, it reaches the window that opens next, and its answer is the one used', async (engine) => {
    const d = await fresh()
    const first = await LocalClient.connect(d)
    const agent = await create(d, first, engine, `ask-unwatched-${engine}`)
    first.send('message', { agentId: agent.id, content: '!ask' })
    await first.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    first.close()
    // The dialog is drawn with nobody watching; a window that opens afterwards is told about it.
    await until('the dialog to be drawn', async () => (await d.capture(agent.tmuxPane)).includes('Which drink would you like?') || null, 15_000, 100)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    // Nobody could answer it, so it was not asked; the window that opens is asked, and is the one
    // that answers.
    const late = await LocalClient.connect(d)
    const question = await late.waitFor(asked(agent.id), 30_000, 'commander_question once a window can answer')
    const ended = late.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    const result = await answer(late, agent.id, question.payload!.requestId, { [question.payload!.questions[0].q]: 'Coffee' })
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain('you chose Coffee')
    late.close()
  })

  it.each(engines)('%s: answered in the terminal by hand, every window is told it is closed, and a late answer types nothing', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const other = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `ask-by-hand-${engine}`)
    const question = client.next(asked(agent.id), 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!ask' })
    const shown = await question
    const requestId = shown.payload!.requestId as string
    const closedHere = client.next(closed(requestId), 30_000, 'commander_question_close')
    const closedThere = other.next(closed(requestId), 30_000, 'commander_question_close in the other window')
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    await pickInPane(d, engine, agent.tmuxPane, ['2'])
    await Promise.all([closedHere, closedThere, ended])
    expect(await d.capture(agent.tmuxPane)).toContain('you chose Coffee')
    const late = await answer(client, agent.id, requestId, { [shown.payload!.questions[0].q]: 'Tea' })
    expect(late.error, JSON.stringify(late)).toBeTruthy()
    expect(await d.capture(agent.tmuxPane)).not.toContain('you chose Tea')
    for (const one of [client, other]) one.close()
  })

  it.each(engines)('%s: two windows answering at once: the agent gets one answer, and the other window is told why not', async (engine) => {
    const d = await fresh()
    const a = await LocalClient.connect(d)
    const b = await LocalClient.connect(d)
    const agent = await create(d, a, engine, `ask-twice-${engine}`)
    const question = a.next(asked(agent.id), 30_000, 'commander_question')
    a.send('message', { agentId: agent.id, content: '!ask' })
    const shown = await question
    const requestId = shown.payload!.requestId as string
    const q = shown.payload!.questions[0].q as string
    const ended = a.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    const [first, second] = await Promise.all([answer(a, agent.id, requestId, { [q]: 'Tea' }), answer(b, agent.id, requestId, { [q]: 'Coffee' })])
    await ended
    const wins = [first, second].filter((result) => !result.error)
    expect(wins, JSON.stringify([first, second])).toHaveLength(1)
    const pane = await d.capture(agent.tmuxPane)
    expect([pane.includes('you chose Tea'), pane.includes('you chose Coffee')].filter(Boolean)).toHaveLength(1)
    // The agent goes on: the next question is asked, and answered. (Its id is the same when the
    // dialog is the same: ids are named from the dialog so they survive a daemon restart.)
    const next = a.next(asked(agent.id), 30_000, 'the next commander_question')
    a.send('message', { agentId: agent.id, content: '!ask' })
    const again = await next
    const after = a.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    expect((await answer(a, agent.id, again.payload!.requestId, { [q]: 'Coffee' })).error).toBeUndefined()
    await after
    for (const one of [a, b]) one.close()
  })

  it.each(engines)('%s: cancelled with Esc in the terminal, every window lets go of it', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `ask-esc-${engine}`)
    const question = client.next(asked(agent.id), 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!ask' })
    const shown = await question
    const gone = client.next(closed(shown.payload!.requestId), 30_000, 'commander_question_close')
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    await pickInPane(d, engine, agent.tmuxPane, ['Escape'])
    await Promise.all([gone, ended])
    expect(await d.capture(agent.tmuxPane)).toContain('(question cancelled)')
    client.close()
  })

  it.each(engines)('%s: still open across a daemon restart: the restarted daemon asks again, and the answer lands', async (engine) => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `ask-restart-${engine}`)
    const question = client.next(asked(agent.id), 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!ask' })
    await question
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    const again = await client.waitFor(asked(agent.id), 45_000, 'the question asked again after the restart')
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    const result = await answer(client, agent.id, again.payload!.requestId, { [again.payload!.questions[0].q]: 'Tea' })
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain('you chose Tea')
    client.close()
  })
})
