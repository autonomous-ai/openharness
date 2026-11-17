/**
 * Hook-driven agent status, end to end, for Claude Code and Codex in Harness panes on the real daemon
 * (docs/plans/2026-11-16-hook-driven-agent-status-plan.md, Task 22): a Claude Code turn ends at its Stop, not when its
 * transcript ends, and a Codex one at the end Codex writes only once its Stop returned; a wait on the person stops reading as working at its hook and its question shows at the next poll;
 * a Claude Code lead stays working while its subagents run; Finished is announced once, after 1.5 s of quiet; and an
 * engine older than an event never waits for it.
 *
 * Each test has a daemon of its own, and its agent's first plain turn makes the session's turns end by hook (R0). No
 * fixed sleep: "not yet" is read after an `agents_list` round trip that follows the last frame or hook awaited.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { DONE_QUIET_MS } from '../src/lib/agentNotifications.js'
import { LocalClient, type Frame } from './harness/client.js'
import { fakeEngineShim, IsolatedDaemon, until, type EngineConfig } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>
const engines: Engine[] = ['claude', 'codex']

const TURN_MS = 45_000
/** Under the 30 s work lease: a wait that only the lease's end withdrew would miss it. */
const WAIT_MS = 15_000
/** Well under the 2 minutes a held end waits for a Stop that never comes (R6): an end that waited for one misses it. */
const AT_ONCE_MS = 20_000
/** A wait's question shows at the question watcher's next poll (1.5 s), with room for that poll's own read. */
const QUESTION_AFTER_WAIT_MS = 3_000
/** turn_ended and Finished cross the same socket but leave the daemon from different processes. */
const FRAME_SKEW_MS = 100

const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
const notified = (agentId: string) => (frame: Frame) => isTurn('turn_summary', agentId)(frame) && !!frame.payload?.notification
const said = (agentId: string, words: string) => (frame: Frame) =>
  isTurn('text_delta', agentId)(frame) && String(frame.payload?.content ?? '').includes(words)
type Arrival = { frame: Frame; at: number }
/** When a frame arrived: a waiter registered before it comes resolves as it is read. */
const arrival = (frame: Promise<Frame>): Promise<Arrival> => frame.then((value) => ({ frame: value, at: Date.now() }))

/** The hooks a fake engine ran for this session, by event (fakeEngine.mjs notes each once it returned). */
const hooksRan = (d: IsolatedDaemon, event: string, sessionId: string): number =>
  d.hookLog().split('\n').filter((line) => line.includes(` ${event} session=${sessionId} `)).length
/** Codex's rollout of this session, under the daemon's CODEX_HOME. */
function rollout(d: IsolatedDaemon, sessionId: string): string {
  const find = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const found = entry.isDirectory() ? find(path) : entry.name.includes(sessionId) && entry.name.endsWith('.jsonl') ? path : undefined
      if (found) return found
    }
    return undefined
  }
  const file = find(join(d.engineConfig.codexHome, 'sessions'))
  if (!file) throw new Error(`no rollout for ${sessionId}`)
  return readFileSync(file, 'utf8')
}
const taskCompletes = (text: string): number => text.split('\n').filter((line) => line.includes('"type":"task_complete"')).length

describe('hook-driven agent status', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  /**
   * A daemon, the engine as [release] of it (written over the fake's wrapper before the daemon starts), and an agent of
   * it bound to its conversation, whose first plain turn has ended.
   */
  async function setUp(engine: Engine, folder: string, release: Partial<EngineConfig> = {}) {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- hooks the engine ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    if (Object.keys(release).length) writeFileSync(join(d.root, 'bin', engine), fakeEngineShim(engine, { ...d.engineConfig, ...release }), { mode: 0o755 })
    await d.start()
    const client = await LocalClient.connect(d)
    const rows = async (): Promise<Row[]> => (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
    const agent = await until(`${folder} to bind its conversation`, async () => {
      const now = (await rows()).find((row) => row.id === created.agent.id)
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500)
    // Its recap too, so what a test counts from here is its own.
    const recap = client.next(isTurn('turn_summary', agent.id), TURN_MS, 'the first turn\'s recap')
    await client.turn(agent.id, 'a first plain turn', TURN_MS)
    await recap
    /** A round trip that follows every frame awaited before it: "not since" is read after it. */
    const fence = async (): Promise<Row> => (await rows()).find((row) => row.id === agent.id)!
    const isWorking = (what: string, ms = TURN_MS) => until(what, async () => (await fence()).activity?.state === 'working' || null, ms, 50)
    return { d, client, agent, fence, isWorking }
  }
  type Run = Awaited<ReturnType<typeof setUp>>

  /** Answers the question with its option that [pick] matches, under the question's own request id. */
  async function answer({ client, agent }: Run, question: Frame, pick: RegExp): Promise<void> {
    const shaped = question.payload!.questions[0] as { q: string; options: string[] }
    const option = shaped.options.find((label) => pick.test(label))
    expect(option, `an option matching ${pick} in ${JSON.stringify(shaped.options)}`).toBeDefined()
    const requestId = question.payload!.requestId as string
    const reply = client.next((frame) => frame.type === 'question_response_result' && frame.payload?.requestId === requestId, TURN_MS, 'question_response_result')
    client.send('question_response', { requestId, agentId: agent.id, answers: { [shaped.q]: option } })
    expect((await reply).payload?.error, 'the answer').toBeUndefined()
  }

  /**
   * A wait on the person (R4): the agent stops reading as working at the wait's hook, long before its work lease would
   * run out, and the question shows at the watcher's next poll; once answered it reads working again, and the turn ends
   * once. [hookFirst]: the engine waits for the hook before it draws its dialog, so the question comes after it.
   * The turn's Stop is held (`!heldstop`) until working again has been read: Claude Code's end waits for its Stop, and
   * Codex writes its end only once its Stop hook returns, so neither turn can end before.
   */
  async function waitsOnThePerson(run: Run, prompt: string, pick: RegExp, hookFirst: boolean): Promise<void> {
    const { d, client, agent, fence, isWorking } = run
    const since = client.frames.length
    const began = () => client.frames.slice(since).some(isTurn('turn_started', agent.id))
    // A not-working state before this turn started is the first turn's.
    const waited = arrival(client.next((frame) => isTurn('agent_activity', agent.id)(frame) && frame.payload?.activity?.state !== 'working' && began(),
      WAIT_MS, 'the agent to stop reading as working at its wait hook'))
    const asked = arrival(client.next(isTurn('commander_question', agent.id), TURN_MS, 'the question'))
    client.send('message', { agentId: agent.id, content: `!heldstop ${prompt}` })
    const [wait, question] = await Promise.all([waited, asked])
    if (hookFirst) expect(client.frames.indexOf(wait.frame), 'not working before the question').toBeLessThan(client.frames.indexOf(question.frame))
    // Claude Code runs its PermissionRequest hook beside the dialog it has just drawn: either may be first.
    expect(Math.abs(question.at - wait.at), 'the question and the wait hook, ms apart').toBeLessThanOrEqual(QUESTION_AFTER_WAIT_MS)
    await answer(run, question.frame, pick)
    await isWorking('working again once answered')
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id)), 'no turn_ended while its Stop is held').toEqual([])
    const ended = client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended at its Stop')
    writeFileSync(join(d.engineConfig.root, 'held-stop.release'), 'go')
    await ended
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
  }

  // Codex writes its end only after its Stop: `codex: a turn's Stop reaches the daemon before its task_complete…` below.
  it('claude: a turn\'s end is told at its Stop, not when its transcript ends', async () => {
    const { d, client, agent, fence } = await setUp('claude', 'held-stop-claude')
    const since = client.frames.length
    const answered = client.next(said(agent.id, '!heldstop'), TURN_MS, 'the turn\'s answer')
    client.send('message', { agentId: agent.id, content: '!heldstop' })
    await answered
    await fence()
    // The engine ran its Stop, and waits for it: it has not reached the daemon.
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id)), 'no turn_ended before its Stop').toEqual([])
    const ended = client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended at its Stop')
    writeFileSync(join(d.engineConfig.root, 'held-stop.release'), 'go')
    await ended
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
  })

  // A loaded runner (cli-e2e, 2026-11-17): a turn's Stop reached the daemon 2 ms to 6 s before its tail read the turn,
  // and the end then waited 2 minutes for a Stop that had come. Here the engine writes the turn only once its Stop
  // has returned (`!lagwrite`).
  it('claude: a Stop that reaches the daemon before its turn is read ends that turn as it is read', async () => {
    const { d, client, agent, fence } = await setUp('claude', 'lag-claude')
    const since = client.frames.length
    const stops = hooksRan(d, 'Stop', agent.sessionId)
    await client.turn(agent.id, '!lagwrite', AT_ONCE_MS)
    expect(hooksRan(d, 'Stop', agent.sessionId), 'its Stop ran').toBe(stops + 1)
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
  })

  it.each(engines)('%s: Esc typed in the pane ends the turn as aborted, and nothing is announced', async (engine) => {
    const { d, client, agent, fence } = await setUp(engine, `esc-${engine}`)
    const started = client.next(isTurn('turn_started', agent.id), TURN_MS, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!hold' })
    await started
    const since = client.frames.length
    const ended = client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended after Esc')
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    expect((await ended).payload?.aborted).toBe(true)
    // Nothing announced is read once the next turn's Finished, which comes after the quiet window, has come.
    const finished = client.next(notified(agent.id), TURN_MS, 'the next turn\'s Finished')
    const next = await client.turn(agent.id, 'after Esc', TURN_MS)
    const done = await finished
    await fence()
    const after = client.frames.slice(since)
    expect(after.filter(isTurn('turn_summary', agent.id))[0], 'no recap of the stopped turn').toBe(done)
    expect(after.filter(notified(agent.id))).toEqual([done])
    expect(client.frames.indexOf(done)).toBeGreaterThan(client.frames.indexOf(next))
  })

  it.each(engines)('%s: a cancel from the app types one Ctrl-C, and the next message is a fresh turn', async (engine) => {
    const { d, client, agent, isWorking } = await setUp(engine, `cancel-${engine}`)
    const started = client.next(isTurn('turn_started', agent.id), TURN_MS, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!hold' })
    await started
    await isWorking('the agent to read as working')
    client.send('cancel', { agentId: agent.id })
    await client.turn(agent.id, 'after the cancel', TURN_MS)
    const interrupts = readFileSync(join(d.engineConfig.root, 'interrupts'), 'utf8').split('\n').filter(Boolean)
    expect(interrupts.map((line) => line.split(' ')[0])).toEqual(['C-c'])
  })

  it.each(engines)('%s: a permission asked: the agent stops reading as working at the hook, the question is shown at the next poll, and an answer sets it working again', async (engine) => {
    const run = await setUp(engine, `permit-${engine}`)
    // Codex runs its PermissionRequest hook and waits for it before it draws the request; Claude Code beside it.
    await waitsOnThePerson(run, '!permit printf hi', /^Yes/, engine === 'codex')
    expect(await run.d.capture(run.agent.tmuxPane)).toContain('ran printf hi')
  })

  it.each(engines)('%s: a question through the engine\'s own tool (AskUserQuestion, request_user_input), the same', async (engine) => {
    const run = await setUp(engine, `ask-${engine}`)
    // Both run the tool's PreToolUse hook and wait for it before the dialog.
    await waitsOnThePerson(run, '!ask', /^Coffee$/, true)
    expect(await run.d.capture(run.agent.tmuxPane)).toContain('you chose Coffee')
  })

  it('claude: an MCP server asking for input (Elicitation), the same', async () => {
    const run = await setUp('claude', 'elicit-claude')
    // Claude Code runs its Elicitation hook and waits for it before it draws the dialog.
    await waitsOnThePerson(run, '!elicit', /^Accept$/, true)
    expect(await run.d.capture(run.agent.tmuxPane)).toContain('the deploy was accepted')
  })

  it.each([
    ['its subagent', ''],
    ['its subagent, while one of Claude Code\'s own forked agents ends (a stop the hook drops)', ' helper'],
    ['its subagent, while another is resumed and ends (a start with its own stop)', ' resume'],
  ])('claude: a lead whose subagent still runs stays working past its own Stop, and ends at its Stop after the subagent stops: %s', async (_, extra) => {
    const { d, client, agent, fence } = await setUp('claude', `spawn-claude${extra.replace(' ', '-')}`)
    const since = client.frames.length
    const stops = hooksRan(d, 'Stop', agent.sessionId)
    const answered = client.next(said(agent.id, 'started scout in the background'), TURN_MS, 'the lead\'s answer')
    client.send('message', { agentId: agent.id, content: `!spawn scout${extra}` })
    await answered
    await until('the lead\'s own Stop to run', () => hooksRan(d, 'Stop', agent.sessionId) > stops, TURN_MS, 50)
    if (extra === ' helper') await until('the forked agent\'s stop to run', () => hooksRan(d, 'SubagentStop', agent.sessionId) === 1, TURN_MS, 50)
    if (extra === ' resume') await until('the resumed subagent to stop', () => hooksRan(d, 'SubagentStop', agent.sessionId) === 1, TURN_MS, 50)
    const row = await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id)), 'no turn_ended while the subagent runs').toEqual([])
    expect(row.activity?.state, 'the lead reads as working').toBe('working')
    const ended = client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended after the subagent stops')
    writeFileSync(join(d.engineConfig.root, 'scout.release'), 'go')
    const end = await ended
    const wrapUp = client.frames.slice(since).find(said(agent.id, 'scout found 3 files'))
    expect(wrapUp && client.frames.indexOf(wrapUp) < client.frames.indexOf(end), 'the lead\'s wrap-up before its turn ends').toBe(true)
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
  })

  it('codex: a lead with a subagent ends once, as today: no subagent hook is installed or waited for', async () => {
    const { d, client, agent, fence } = await setUp('codex', 'spawn-codex')
    const hooks = (JSON.parse(readFileSync(join(d.engineConfig.codexHome, 'hooks.json'), 'utf8')) as { hooks?: Record<string, unknown> }).hooks ?? {}
    expect(Object.keys(hooks)).not.toContain('SubagentStart')
    expect(Object.keys(hooks)).not.toContain('SubagentStop')
    const since = client.frames.length
    await client.turn(agent.id, '!spawn scout', AT_ONCE_MS)
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
    expect(d.hookLog()).not.toMatch(/ Subagent(Start|Stop) session=/)
  })

  it('codex: a turn that ends in an error is told at once, with no Stop and no 2-minute wait', async () => {
    const { d, client, agent } = await setUp('codex', 'fail-codex')
    const stops = hooksRan(d, 'Stop', agent.sessionId)
    await client.turn(agent.id, '!fail', AT_ONCE_MS)
    expect(hooksRan(d, 'Stop', agent.sessionId), 'Codex runs no Stop for a turn that ends in an error').toBe(stops)
  })

  it('codex: a turn\'s Stop reaches the daemon before its task_complete is written, and the end is told once', async () => {
    const { d, client, agent, fence } = await setUp('codex', 'stop-first-codex')
    const before = taskCompletes(rollout(d, agent.sessionId))
    const since = client.frames.length
    const answered = client.next(said(agent.id, '!heldstop'), TURN_MS, 'the turn\'s answer')
    client.send('message', { agentId: agent.id, content: '!heldstop' })
    await answered
    await fence()
    // Codex waits for its Stop before it writes the turn's end, so no end can be read before the Stop has come.
    expect(taskCompletes(rollout(d, agent.sessionId)), 'no task_complete while its Stop runs').toBe(before)
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id)), 'no turn_ended while its Stop runs').toEqual([])
    const ended = client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended once its Stop came')
    writeFileSync(join(d.engineConfig.root, 'held-stop.release'), 'go')
    await ended
    await fence()
    expect(taskCompletes(rollout(d, agent.sessionId))).toBe(before + 1)
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
  })

  it('claude: a /goal loop announces nothing between its passes, and Finished once at its end', async () => {
    const { client, agent, fence } = await setUp('claude', 'goal-claude')
    const since = client.frames.length
    const label = 'Continuing goal: every check passes'
    client.send('message', { agentId: agent.id, content: '!goalloop every check passes' })
    const pass = await client.waitFor((frame) => isTurn('turn_started', agent.id)(frame) && frame.payload?.userMessage === label,
      TURN_MS, 'the goal\'s next pass to start', since)
    const end = await client.waitFor(isTurn('turn_ended', agent.id), TURN_MS, 'the goal\'s last pass to end', client.frames.indexOf(pass))
    const finished = await client.waitFor(notified(agent.id), TURN_MS, 'Finished', client.frames.indexOf(end))
    await fence()
    expect(client.frames.slice(since).filter(notified(agent.id))).toEqual([finished])
  })

  it.each(engines)('%s: Finished comes once, no sooner than 1.5 s after the turn ends', async (engine) => {
    const { client, agent, fence } = await setUp(engine, `finished-${engine}`)
    const since = client.frames.length
    const ended = arrival(client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended'))
    const finished = arrival(client.next(notified(agent.id), TURN_MS, 'Finished'))
    client.send('message', { agentId: agent.id, content: 'a plain turn' })
    const [end, done] = await Promise.all([ended, finished])
    expect(done.at - end.at, 'Finished after the turn ended, ms').toBeGreaterThanOrEqual(DONE_QUIET_MS - FRAME_SKEW_MS)
    await fence()
    expect(client.frames.slice(since).filter(notified(agent.id))).toHaveLength(1)
  })

  it.each([
    ['claude', ['Stop', 'StopFailure']],
    ['codex', ['Stop']],
  ] as const)('%s: an engine that sends no Stop ends its turns from the transcript, as before', async (engine, withoutHooks) => {
    const { d, client, agent, fence } = await setUp(engine, `no-stop-${engine}`, { withoutHooks: [...withoutHooks] })
    const since = client.frames.length
    await client.turn(agent.id, 'a second turn', AT_ONCE_MS)
    await client.turn(agent.id, 'a third turn', AT_ONCE_MS)
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(2)
    expect(hooksRan(d, 'Stop', agent.sessionId), 'the engine ran no Stop').toBe(0)
  })

  // As Tasks 1 and 2 found: Claude Code 2.1.209 has every event Harness installs; Codex 0.144.0 has no Interrupt, so its
  // Esc ends the turn by the transcript's turn_aborted alone.
  it.each([
    ['claude', '2.1.209', []],
    ['codex', '0.144.0', ['Interrupt']],
  ] as const)('the oldest supported, %s %s: the events it lacks are never waited for, and each turn ends at once, one stopped by Esc among them', async (engine, version, withoutHooks) => {
    const { d, client, agent, fence } = await setUp(engine, `oldest-${engine}`, { version, withoutHooks: [...withoutHooks] })
    const since = client.frames.length
    await client.turn(agent.id, 'a second turn', AT_ONCE_MS)
    const started = client.next(isTurn('turn_started', agent.id), TURN_MS, 'turn_started')
    client.send('message', { agentId: agent.id, content: '!hold' })
    await started
    const stopped = client.next(isTurn('turn_ended', agent.id), AT_ONCE_MS, 'turn_ended after Esc')
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    await stopped
    await client.turn(agent.id, 'after Esc', AT_ONCE_MS)
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(3)
    for (const event of withoutHooks) expect(hooksRan(d, event, agent.sessionId), `the engine ran no ${event}`).toBe(0)
  })
})
