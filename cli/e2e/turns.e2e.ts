/**
 * Turns ending the ways people end them, for Claude Code and Codex, on the real daemon: cancelled from
 * the app, interrupted with Ctrl-C in the terminal itself, and watched by more than one window at once.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WORK_EVIDENCE_MS } from '../src/lib/turnActivity.js'
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

  it.each(engines)('%s: a turn cancelled while a tool runs settles idle after the aborted tool\'s late output, not unknown for good', async (engine) => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, engine, `cancel-tool-${engine}`)
    const started = client.next(isTurn('turn_started', agent.id), 30_000, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!holdtool sleep 45' })
    await started
    await until('the agent to read as working', async () => (await row(client, agent.id))?.activity?.state === 'working' || null, 15_000, 250)
    // The CLI writes the aborted tool's output only after the interrupt, and it reads as work for one
    // lease. With no turn open nothing probes the agent again: it stuck at unknown until the next prompt
    // (a real Codex 0.160, found by daemon QA). It must settle idle once that late evidence runs out.
    const late = client.next(isTurn('tool_end', agent.id), 30_000, 'the aborted tool\'s late output')
    client.send('cancel', { agentId: agent.id })
    await late
    await until('the agent to settle idle', async () => (await row(client, agent.id))?.activity?.state === 'idle' || null, WORK_EVIDENCE_MS + 20_000, 500)
    await turn(client, agent.id, 'after the cancel')
    client.close()
  }, 150_000)

  it('claude: a /goal its hook says is not met yet goes on as a turn of its own, working until it ends', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'goal-loop')
    const since = client.frames.length
    const label = 'Continuing goal: every check passes'
    const continued = (frame: Frame) => isTurn('turn_started', agent.id)(frame) && frame.payload?.userMessage === label
    // The goal hook refuses the first stop and Claude Code works on in the same turn, with no prompt line:
    // the daemon closed the turn at that stop and the next pass ran with none open, so it never ended,
    // had no recap, and read idle whenever its tool outlasted the work lease (real 2.1.283 transcripts).
    client.send('message', { agentId: agent.id, content: '!goalloop every check passes' })
    const pass = await client.waitFor(continued, 45_000, 'the goal\'s next pass to start', since)
    const at = client.frames.indexOf(pass)
    expect(client.frames.slice(since, at).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
    await until('the agent to read as working in the next pass', async () => (await row(client, agent.id))?.activity?.state === 'working' || null, 3_000, 100)
    const end = await client.waitFor(isTurn('turn_ended', agent.id), 45_000, 'the goal\'s next pass to end', at)
    expect(end.payload?.aborted).toBeUndefined()
    // Ended by its own answer, after its tool: not by the Stop of the pass before it, which reached the
    // daemon after this pass had started (as under load) and force-closed it after the grace while its
    // tool still ran.
    const tool = client.frames.slice(at).find(isTurn('tool_end', agent.id))
    expect(tool && client.frames.indexOf(tool) < client.frames.indexOf(end), 'the pass\'s tool to finish before it ends').toBe(true)
    await settled(client, agent.id)
    const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }> }>('session_get', { sessionId: agent.sessionId, limit: 200 }, 30_000)
    expect((page.events ?? []).filter((event) => event.type === 'user_message').map((event) => event.payload.content))
      .toEqual(['!goalloop every check passes', label])
    // Its end leaves nothing open: the next message is a fresh turn.
    await turn(client, agent.id, 'after the goal')
    client.close()
  })

  it('claude: a /goal that pauses after its hook refuses to stop ends its turn, and the agent reads idle', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const agent = await create(d, client, 'claude', 'goal-pause')
    const since = client.frames.length
    const label = 'Continuing goal: every check passes'
    client.send('message', { agentId: agent.id, content: '!goalpause every check passes' })
    const pass = await client.waitFor((frame) => isTurn('turn_started', agent.id)(frame) && frame.payload?.userMessage === label, 45_000, 'the refused stop to continue', since)
    // Claude Code writes no output and fires no Stop for a pass it pauses: only notices and its own
    // turn_duration. Nothing else closes the pass that the refusal opened.
    await client.waitFor(isTurn('turn_ended', agent.id), 20_000, 'the paused pass to end', client.frames.indexOf(pass))
    await until('the agent to read idle', async () => (await row(client, agent.id))?.activity?.state === 'idle' || null, 15_000, 250)
    await turn(client, agent.id, 'after the pause')
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
