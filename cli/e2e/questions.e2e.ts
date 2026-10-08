/**
 * An agent's question, end to end, for Claude Code and Codex: the dialog the engine draws reaches the
 * window as a question, the answer chosen there is typed into the dialog and is the one the agent gets,
 * and an answer to a question that is no longer the one on screen types nothing. A permission prompt
 * is a question too: Yes in the window runs the command, No leaves it unrun. A message a person sends
 * meanwhile is not typed into either: the prompt drops a paste and takes its Enter as the focused row.
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
    expect(question.payload).not.toHaveProperty('permission')
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

  it.each(engines)('%s: an answered question in scrollback does not block the next prompt or accept a late answer', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `ask-scrollback-${engine}`)
    const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!askscrollback' })
    const question = (await asked).payload!
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    const answers = { [question.questions[0].q]: 'Coffee' }
    expect((await answer(client, agent.id, question.requestId, answers)).error).toBeUndefined()
    await ended
    // Read the same history the daemon reads, proving the old dialog really remains in the capture.
    const capture = await d.tmux.run('capture-pane', '-p', '-e', '-J', '-S', '-100', '-t', agent.tmuxPane)
    expect(capture).toContain(engine === 'claude' ? 'Enter to select' : 'enter to submit answer')
    expect(capture).toContain('you chose Coffee')
    expect((await answer(client, agent.id, question.requestId, answers)).error).toBe('STALE_QUESTION')
    await turn(client, agent.id, 'after the answered question in scrollback')
    client.close()
  })

  it.each(engines)('%s: a permission the agent asks for reaches the window, and Yes there runs the command, No does not', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `permit-${engine}`)
    for (const [choice, outcome] of [[0, 'ran printf hi'], [2, 'did not run printf hi']] as const) {
      const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'commander_question')
      client.send('message', { agentId: agent.id, content: '!permit printf hi' })
      const question = await asked
      const shaped = question.payload?.questions?.[0]
      expect(shaped?.q).toContain('printf hi')
      expect(question.payload.permission).toEqual({ dialog: expect.stringContaining('printf hi'), resolution: 'desktop' })
      expect(shaped?.options).toHaveLength(3)
      const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
      const result = await answer(client, agent.id, question.payload.requestId, { [shaped.q]: shaped.options[choice] })
      expect(result.error, JSON.stringify(result)).toBeUndefined()
      await ended
      expect(await d.capture(agent.tmuxPane)).toContain(outcome)
    }
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

  it.each(engines)('%s: a message sent while a permission prompt is open approves nothing: refused with the reason, and the prompt still answers', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `permit-message-${engine}`)
    const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!permit printf hi' })
    const question = await asked
    const shaped = question.payload?.questions?.[0]
    const from = client.frames.length
    client.send('message', { agentId: agent.id, content: 'what will that command do?' })
    // Either the refusal arrives, or the message's Enter took the focused row, Yes, and the command ran.
    const outcome = await until('the refusal, or the command run by the message', async () => {
      if ((await d.capture(agent.tmuxPane)).includes('ran printf hi')) return 'the message approved the command'
      const refused = client.frames.slice(from).find((frame) => frame.type === 'error' && frame.agentId === agent.id)
      return refused ? String(refused.payload?.message) : null
    }, 20_000, 250)
    expect(outcome).toBe(engine === 'claude'
      ? 'Claude Code is asking for permission. Answer it first, in the app or in its terminal, then send the message again.'
      : 'Codex is asking for approval. Answer it first, in the app or in its terminal, then send the message again.')
    // Still asking: the answer goes through its own path, and No leaves the command unrun.
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    expect((await answer(client, agent.id, String(question.payload?.requestId), { [shaped.q]: shaped.options[2] })).error).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain('did not run printf hi')
    // The prompt answered, the same message goes through.
    await turn(client, agent.id, 'what will that command do?')
    client.close()
  })

  it.each(engines)('%s: a message sent while a question is open answers nothing: refused with the reason, and the question still answers', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `ask-message-${engine}`)
    const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'commander_question')
    client.send('message', { agentId: agent.id, content: '!ask' })
    const question = await asked
    const shaped = question.payload?.questions?.[0]
    const from = client.frames.length
    client.send('message', { agentId: agent.id, content: 'something stronger' })
    // Claude Code drops the paste and its Enter picks the focused option; Codex takes the paste as notes
    // on it and its Enter submits that.
    const outcome = await until('the refusal, or the question answered by the message', async () => {
      if ((await d.capture(agent.tmuxPane)).includes('you chose')) return 'the message answered the question'
      const refused = client.frames.slice(from).find((frame) => frame.type === 'error' && frame.agentId === agent.id)
      return refused ? String(refused.payload?.message) : null
    }, 20_000, 250)
    expect(outcome).toBe(`${engine === 'claude' ? 'Claude Code' : 'Codex'} is asking you a question. Answer it first, in the app or in its terminal, then send the message again.`)
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    expect((await answer(client, agent.id, String(question.payload?.requestId), { [shaped.q]: 'Coffee' })).error).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain('you chose Coffee')
    expect(await d.capture(agent.tmuxPane)).not.toContain('notes:')
    client.close()
  })

  it.each(engines)('%s: a request that opens between a message\'s paste and its Enter gets no Enter: the message waits unsent, and the person is told', async (engine) => {
    const name = engine === 'claude' ? 'Claude Code' : 'Codex'
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `between-${engine}`)
    // A turn that asks permission the moment a message is pasted: a request arriving mid-turn, in the gap
    // the daemon leaves for the engine to take a long or multi-line paste in before its Enter.
    const started = client.next(isTurn('turn_started', agent.id), 45_000, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!permitnext printf hi' })
    await started
    const asked = client.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, 'commander_question')
    const refused = client.next((frame) => frame.type === 'error' && frame.agentId === agent.id, 30_000, 'the refusal')
    client.send('message', { agentId: agent.id, content: 'first line\nsecond line' })
    expect(String((await refused).payload?.message)).toBe(`${name} asked for permission just as your message was typed, so it was not sent; it waits in ${name}'s prompt. Answer the request in the app or in its terminal, then press Enter in its terminal to send the message, or clear it there.`)
    expect(await d.capture(agent.tmuxPane)).not.toContain('ran printf hi')
    // Still asking, and answered through its own path: No.
    const question = await asked
    const shaped = question.payload?.questions?.[0]
    const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
    expect((await answer(client, agent.id, String(question.payload?.requestId), { [shaped.q]: shaped.options[2] })).error).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain('did not run printf hi')
    // The message waits in the composer, unsent, and the daemon presses nothing; Enter in the terminal sends it.
    await until('the message to wait in the composer', async () => (await d.capture(agent.tmuxPane)).includes('second line') || null, 15_000, 250)
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    expect(client.frames.some((frame) => isTurn('turn_started', agent.id)(frame) && String(frame.payload?.userMessage).includes('second line'))).toBe(false)
    const sent = client.next((frame) => isTurn('turn_started', agent.id)(frame) && String(frame.payload?.userMessage).includes('second line'), 30_000, 'the message sent')
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Enter')
    await sent
    client.close()
  })

  it('codex: the answer to a question Codex 0.160 asks without stopping reads as the answer, not its wrapper, live and in the history', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'codex', 'askasync-codex')
    // The answer comes back as a user message wrapped in <send_user_message_question_reply> around JSON,
    // and was the person's words exactly so: in the live turn, the history, the recap and search.
    const readable = 'Which database should the service use? → SQLite'
    const since = client.frames.length
    client.send('message', { agentId: agent.id, content: '!askasync SQLite' })
    const started = await client.waitFor((frame) => isTurn('turn_started', agent.id)(frame) && frame.payload?.userMessage !== '!askasync SQLite', 45_000, 'the answer\'s turn', since)
    expect(started.payload?.userMessage).toBe(readable)
    await client.waitFor(isTurn('turn_ended', agent.id), 45_000, 'the answer\'s turn to end', client.frames.indexOf(started) + 1)
    const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }>; error?: string }>(
      'session_get', { sessionId: agent.sessionId, limit: 200 }, 30_000)
    expect(page.error).toBeUndefined()
    const said = (page.events ?? []).filter((event) => event.type === 'user_message').map((event) => event.payload.content)
    expect(said).toEqual(['!askasync SQLite', readable])
    client.close()
  })
})
