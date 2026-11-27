/**
 * `harness device notify` on the real daemon (docs/plans/2026-11-16-dial-agent-notify-design.md): the real command, run
 * as an agent's shell runs it, with that agent's own variables and in its folder, reaches the devices' listener, and a
 * fake dial on the desk (harness/desk.ts) shows the line as a card of that agent's own:
 * - an outside Claude Code session's and a Codex session's notice is a card on their own row, answered in their app, and
 *   `notify` prints `shown <id>`; the same line again is limited; reading the card leaves it;
 * - a waiting card stays until its agent closes it (docs/plans/2026-11-27-dial-notice-cards-agent-closes-design.md):
 *   the person's next prompt, a message from another session and a Harness agent's message each start a turn and close
 *   nothing; `--list` shows the agent's card and `--done <id>` or `--done all` takes it off the dial;
 * - a plain or proceeding card stays through a message from another session and goes at the person's next prompt, and
 *   a Harness agent's at its next turn, which cannot tell the two apart;
 * - the turn that sent a notice ends silent, and its card stays;
 * - a Harness agent's notice is tied to the Harness agent, and a session nobody lists rings under its folder, and its
 *   card goes at a tap, which opens nothing;
 * - a decision asked with `--suggest`, `--waiting` by a Harness agent and `--proceeding` by an outside session, rings
 *   once on its own card with the one line the command composed, and its turn ends silent; a plain finished turn rings
 *   no question (docs/plans/2026-11-22-needs-you-notify-design.md);
 * - a Harness agent's turn that asks permission, is allowed on the dial and goes on rings when it ends (#4620);
 * - a tap on the card of a session in an Orca terminal switches Orca to it and keeps the card, so the dial's face of it
 *   still asks, until the agent closes it; a fake `orca` (harness/fakeOrca.ts) stands in for Orca, which never runs;
 * - after its agent's turn starts, a Harness Pro, whose firmware drops the agent's question there, gets the card back as
 *   a row, and the round dial gets no question frame;
 * - it rings with a window open on its tab;
 * - with the dial unplugged, or no dial on this computer, it prints `no dial`, and the second starts nothing;
 * - a pending card comes back after the devices process restarts, as a silent row that opens to its line
 *   (docs/plans/2026-11-18-dial-notices-restart-design.md); two cards of one agent come back with the first shown and
 *   its place, and closing it brings the second up as a row, with no ring;
 * - with the Notifications setting on Needs you, a plain finished turn draws its tile alone, and the dial's list holds the
 *   notices and the window's questions but no finished turn, after a replug too.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { LocalClient } from './harness/client.js'
import { CodexOutside } from './harness/codexOutside.js'
import { IsolatedDaemon, sourcesCli, until } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { InOrca } from './harness/inOrca.js'
import { orcaHostCc } from './harness/orcaHost.js'
import { Outside } from './harness/outsideAgent.js'

const LINE = 'Connect the VPN so I can run the staging tests'
/** The line as a waiting card shows it: only its agent closes such a card, so it outlives its agent's turns. */
const WAITING = `Waiting · ${LINE}`
/** A decision as the dial skill asks it, and the line the command makes of it: the agent goes on with its pick, or
 *  waits for the person. */
const ASK = ['Which cache for the user lookup?', '--suggest', 'in-process LRU', '--proceeding']
const COMPOSED = 'Proceeding · Which cache for the user lookup? · Doing: in-process LRU'
const WAIT_ASK = ['Which cache for the user lookup?', '--suggest', 'in-process LRU', '--waiting']
const WAIT_COMPOSED = 'Waiting · Which cache for the user lookup? · Suggest: in-process LRU'
/** What `notify` prints for a card on the dial: its 8-character id, which its agent closes it by. */
const SHOWN = expect.stringMatching(/^shown [0-9a-f]{8}$/)
/** What the Harness Pro says in its greeting, as dialProApps.e2e.ts's: the board is what tells it from a round dial. */
const PRO = {
  board: 'pro', swarms: 'members-v1', recap: 'long-v1', activity: 'steps-v1', stats: 'turn-v1', player: 'library-v1',
  ota: 'v1', appFilter: 'v1', questionTier: 'v1', appCards: 'v1',
}

// The run's bundle when there is one (E2E_BUNDLE), as the daemon runs. Run from the caller's folder, where a bare
// `--import tsx` would not resolve: tsx and the sources by their paths.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH
  ? [process.env.E2E_BUNDLE_PATH]
  : sourcesCli()

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
/** A Harness agent in a tmux pane, created as the desktop creates one, and the engine session the core bound to it. */
async function create(daemon: IsolatedDaemon, client: LocalClient, folder: string): Promise<{ id: string; sessionId: string }> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  const agent = await until(`${folder} to bind its conversation`, async () => {
    const found = await row(client, created.agent.id)
    return found?.sessionId && found.status === 'active' ? found : null
  }, 60_000, 500)
  return { id: created.agent.id, sessionId: String(agent.sessionId) }
}

describe('harness device notify', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })
  /** [before] runs once the daemon's folders are made and before it starts: a setting in its data folder, or the fake
   *  `orca` in its `bin`, goes in then. */
  const fresh = async (env: Record<string, string> = {}, before?: (d: IsolatedDaemon) => void): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...env } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    before?.(d)
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    return { d, desk: theDesk }
  }
  const plugged = async (theDesk: Desk, capabilities?: Record<string, string>, serial = 'E2E-A', mac = 'e2:e0:00:00:00:0a'): Promise<FakeDial> => {
    const dial = await theDesk.plug(serial, mac, capabilities)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return dial
  }
  const startOutside = async (d: IsolatedDaemon, folder: string): Promise<Outside> => {
    const engine = await Outside.start(d, folder, { TERM_PROGRAM: 'ghostty' })
    outside.push(engine)
    return engine
  }
  const listed = (dial: FakeDial, agentId: string): Promise<DialMessage> =>
    dial.next((m) => m.t === 'agent' && m.id === agentId, 45_000, 'the agent listed')

  /** The command as an agent's shell runs it: the daemon's environment, the caller's variables, in its folder. */
  async function notify(d: IsolatedDaemon, caller: Record<string, string>, cwd: string, words = [LINE]): Promise<{ code: number | null; out: string; err: string }> {
    mkdirSync(cwd, { recursive: true })
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', 'notify', ...words], {
      cwd, env: { ...d.env, TMUX_PANE: '', ...caller }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = '', err = ''
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { code, out: out.trim(), err }
  }
  /** The card's id, as `notify` printed it. */
  const idOf = (out: string): string => out.slice('shown '.length)
  /** The card is still the daemon's and nothing closed it since [from]: the read answered now is the barrier. */
  const stays = async (dial: FakeDial, question: DialMessage, from: number): Promise<void> => {
    expect(await opened(dial, question.agentId as string)).toMatchObject({ ok: true, id: question.id })
    expect(dial.messages.slice(from).filter((m) => m.t === 'question.close' && m.agentId === question.agentId)).toEqual([])
  }
  /** The agent's `--list` shows its card by the id `notify` printed, and `--done` with [id] (or `all`) takes it off the
   *  dial. */
  const listedThenDone = async (d: IsolatedDaemon, caller: Record<string, string>, cwd: string, dial: FakeDial,
    question: DialMessage, id: string, line = LINE, done = id): Promise<void> => {
    const list = await notify(d, caller, cwd, ['--list'])
    expect(list).toMatchObject({ code: 0, out: expect.stringMatching(new RegExp(`^${id} \\d+[smh] (plain|waiting|proceeding) `)) })
    expect(list.out.endsWith(` ${line}`)).toBe(true)
    const since = dial.messages.length
    expect(await notify(d, caller, cwd, ['--done', done])).toMatchObject({ code: 0, out: '' })
    await dial.next((m) => m.t === 'question.close' && m.agentId === question.agentId && m.id === question.id, 45_000, 'the card closed', since)
  }
  const questions = (dial: FakeDial, agentId: string): DialMessage[] =>
    dial.messages.filter((m) => m.t === 'question' && m.agentId === agentId)
  const card = (app: string, line = LINE) => [{ key: 'notice', q: line, options: [`In ${app}`] }]
  /** What a ring carries of the card: its line, as the drawer row shows it. The dial reads the card itself. */
  const rung = (line = LINE) => [{ key: '', q: line, options: [] }]

  it('an outside Claude Code session\'s waiting notice is its own card, read without closing it, kept through its next prompt, and closed by --done', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const cwd = join(d.projectsDir, 'fix-login')

    const shown = await notify(d, caller, cwd, [LINE, '--waiting'])
    expect(shown).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice')
    expect(question).toMatchObject({ agentId: engine.id, name: 'fix-login', id: expect.stringMatching(/^shown:/), questions: rung(WAITING) })

    // The same line again, within the minute: limited, and nothing more on the dial.
    expect(await notify(d, caller, cwd, [LINE, '--waiting'])).toMatchObject({ code: 0, out: 'limited' })

    // Opening the alert to read it leaves the card. The list asked after it is the barrier: the daemon has handled the
    // read, and whatever it sent for it, by the time the list's drawer is sent. A drawer carries the dial's open
    // questions as rows instead of asking them again (#4445): the card is one of them.
    let since = dial.messages.length
    dial.send({ t: 'question.read', agentId: engine.id, requestId: 'read-1' })
    const state = await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the card read', since)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: card('Ghostty', WAITING) })
    since = dial.messages.length
    dial.send({ t: 'agents.list' })
    const drawer = await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer sent with the list', since)
    expect(drawer.items).toContainEqual(expect.objectContaining({ agentId: engine.id, name: 'fix-login', summary: WAITING, question: true }))
    // The same card each time it is sent, never a second one, and never closed.
    expect([...new Set(questions(dial, engine.id).map((m) => m.id))]).toEqual([question.id])
    const prompted = dial.messages.length
    expect(dial.messages.some((m) => m.t === 'question.close' && m.agentId === engine.id)).toBe(false)

    // The person's next prompt starts a turn, which is no answer the devices can read: the waiting card stays until its
    // agent closes it.
    engine.type('connected')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', prompted)
    await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', prompted)
    await stays(dial, question, prompted)
    await listedThenDone(d, caller, cwd, dial, question, idOf(shown.out), WAITING)

    await until('the notice in the daemon\'s log', () => d.log().includes('[device] notify · claude · shown'), 30_000, 50)
    expect(d.log().split('\n').filter((line) => line.includes(LINE))).toEqual([])
    // A card's id names one notice: it stays with its agent, after it was shown, listed and closed.
    expect(d.log()).not.toContain(idOf(shown.out))
  })

  it('a message from another session keeps a plain card, and the person\'s next prompt closes it', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const cwd = join(d.projectsDir, 'fix-login')
    expect(await notify(d, caller, cwd)).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice')

    // Another session's message reaches the agent as a prompt the person did not type: its turn closes nothing.
    const relayed = dial.messages.length
    engine.type('<cross-session-message from="b">hi</cross-session-message>')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', relayed)
    await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', relayed)
    await stays(dial, question, relayed)

    // The person's own next prompt closes it: a plain card was for the person, who has acted (rule 5).
    const prompted = dial.messages.length
    engine.type('connected')
    await dial.next((m) => m.t === 'question.close' && m.agentId === engine.id && m.id === question.id, 45_000, 'the card closed', prompted)
    expect(await notify(d, caller, cwd, ['--list'])).toMatchObject({ code: 0, out: '' })
  })

  // One ring a turn (docs/plans/2026-11-17-dial-one-ring-per-turn-design.md): the notice rang, so the turn's end only
  // draws the tile, and the notice keeps its row. Any open card keeps its agent's turn ends silent, a plain one too
  // (docs/plans/2026-11-27-dial-notice-cards-agent-closes-design.md, rule 8).
  it('a turn that sent a notice ends silent, and its card stays', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const started = dial.messages.length
    // The turn ends only once the notice is shown, as an agent's turn goes on while the command it runs works: no
    // timer for the command to beat.
    engine.type('!until fix-login')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', started)
    expect(await notify(d, caller, join(d.projectsDir, 'fix-login'))).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice', started)
    writeFileSync(join(d.engineConfig.root, 'fix-login.release'), '')
    const summary = await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', started)
    expect(summary).toMatchObject({ tier: 'silent', silent: true })
    // The read answered after the summary is the barrier: the card is still the daemon's, and nothing closed it.
    const since = dial.messages.length
    dial.send({ t: 'question.read', agentId: engine.id, requestId: 'read-1' })
    expect(await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the card read', since))
      .toMatchObject({ ok: true, id: question.id, questions: card('Ghostty') })
    expect(dial.messages.some((m) => m.t === 'question.close' && m.agentId === engine.id)).toBe(false)
    // The log reaches the test on a path of its own, not behind the dial's frames.
    await until('the silent end in the daemon\'s log', () => d.log().includes('[cable] notify · silent · rule:notice · notice · 0ms'), 30_000, 50)
  })

  it('a Harness agent\'s waiting decision rings once on its card with the composed line, its turn ends silent, the card stays through a message, and --done all closes it', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await plugged(desk)
    await listed(dial, harness.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: harness.sessionId }
    const cwd = join(d.projectsDir, 'in-harness')
    const started = dial.messages.length
    client.send('message', { agentId: harness.id, content: '!until in-harness' })
    await dial.next((m) => m.t === 'turn.started' && m.agentId === harness.id, 45_000, 'its turn started', started)
    const shown = await notify(d, caller, cwd, WAIT_ASK)
    expect(shown).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === harness.id, 45_000, 'the notice', started)
    expect(question).toMatchObject({ id: expect.stringMatching(/^shown:/), questions: rung(WAIT_COMPOSED) })
    writeFileSync(join(d.engineConfig.root, 'in-harness.release'), '')
    const summary = await dial.next((m) => m.t === 'summary' && m.agentId === harness.id, 60_000, 'its answer', started)
    expect(summary).toMatchObject({ tier: 'silent', silent: true })
    expect(await opened(dial, harness.id)).toMatchObject({ ok: true, id: question.id, questions: card('Harness', WAIT_COMPOSED) })
    expect([...new Set(questions(dial, harness.id).map((m) => m.id))]).toEqual([question.id])

    // The person answers in the app: the message reaches the agent's pane as a turn, which closes no waiting card; the
    // agent closes its card.
    const prompted = dial.messages.length
    await client.turn(harness.id, 'Use Redis')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === harness.id, 45_000, 'its turn started', prompted)
    await stays(dial, question, prompted)
    await listedThenDone(d, caller, cwd, dial, question, idOf(shown.out), WAIT_COMPOSED, 'all')
    await until('the notice in the daemon\'s log', () => d.log().includes('[device] notify · claude · shown'), 30_000, 50)
    expect(d.log().split('\n').filter((line) => line.includes(WAIT_ASK[0]) || line.includes(WAIT_ASK[2]))).toEqual([])
    client.close()
  })

  it('an outside Claude Code session\'s decision rings once on its own card, its turn ends silent, and its next prompt closes the card', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const cwd = join(d.projectsDir, 'fix-login')
    const started = dial.messages.length
    engine.type('!until fix-login')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', started)
    const shown = await notify(d, caller, cwd, ASK)
    expect(shown).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice', started)
    expect(question).toMatchObject({ name: 'fix-login', id: expect.stringMatching(/^shown:/), questions: rung(COMPOSED) })
    writeFileSync(join(d.engineConfig.root, 'fix-login.release'), '')
    const summary = await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', started)
    expect(summary).toMatchObject({ tier: 'silent', silent: true })
    expect(await opened(dial, engine.id)).toMatchObject({ ok: true, id: question.id, questions: card('Ghostty', COMPOSED) })
    expect([...new Set(questions(dial, engine.id).map((m) => m.id))]).toEqual([question.id])

    // The person's next prompt closes it: the agent went on with its pick, and the person has acted (rule 5).
    const prompted = dial.messages.length
    engine.type('Use Redis')
    await dial.next((m) => m.t === 'question.close' && m.agentId === engine.id && m.id === question.id, 45_000, 'the card closed', prompted)
    expect(await notify(d, caller, cwd, ['--list'])).toMatchObject({ code: 0, out: '' })
    await until('the notice in the daemon\'s log', () => d.log().includes('[device] notify · claude · shown'), 30_000, 50)
    expect(d.log().split('\n').filter((line) => line.includes(ASK[0]) || line.includes(ASK[2]))).toEqual([])
  })

  // The dial draws its face of an agent as asking while that agent's question is open: a tap that only brought the agent
  // forward must leave it open, or the face falls back to resting before the person has answered.
  it.skipIf(!orcaHostCc)('a tap on the card of a session in an Orca terminal switches Orca to it and keeps the card, through its next prompt, until --done', async () => {
    let orca: FakeOrca | undefined
    const { d, desk } = await fresh({}, (made) => { orca = FakeOrca.install(made) })
    const dial = await plugged(desk)
    const handle = `term_${randomUUID()}`
    const claude = new InOrca(d, 'fix-login', children, { ORCA_TERMINAL_HANDLE: handle, __CFBundleIdentifier: 'com.stablyai.orca' })
    await claude.hook('SessionStart', { source: 'startup' })
    await listed(dial, claude.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: claude.sessionId }
    const shown = await notify(d, caller, claude.cwd, WAIT_ASK)
    expect(shown).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === claude.id, 45_000, 'the notice')

    // The person taps "In Orca": Orca switches to its terminal, and the dial turns to its face.
    let since = dial.messages.length
    dial.send({ t: 'agent.open', agentId: claude.id })
    await dial.next((m) => m.t === 'focus' && m.agentId === claude.id, 45_000, 'its face', since)
    expect(orca!.log().map((run) => run.argv.slice(1).join(' '))).toContain(`terminal switch --terminal ${handle} --json`)

    // The list asked after the tap is the barrier: whatever the daemon sent for the tap is sent by the time the list's
    // drawer is. The card is still one of its question rows, and nothing closed it.
    since = dial.messages.length
    dial.send({ t: 'agents.list' })
    const drawer = await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer sent with the list', since)
    expect(drawer.items).toContainEqual(expect.objectContaining({ agentId: claude.id, question: true }))
    expect(dial.messages.some((m) => m.t === 'question.close' && m.agentId === claude.id)).toBe(false)

    // The person answers in Orca: its next turn starts, which closes nothing; the agent closes its card.
    const prompted = dial.messages.length
    await claude.hook('UserPromptSubmit', { prompt: 'Use Redis' })
    await dial.next((m) => m.t === 'turn.started' && m.agentId === claude.id, 45_000, 'its next turn started', prompted)
    await stays(dial, question, prompted)
    await listedThenDone(d, caller, claude.cwd, dial, question, idOf(shown.out), WAIT_COMPOSED)
  })

  // A guard for the skill's rule: a turn that only finished asks nothing, so the dial gets no question for it.
  it('a plain finished turn of a Harness agent or an outside session sends no question frame', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await plugged(desk)
    await listed(dial, harness.id)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    let since = dial.messages.length
    client.send('message', { agentId: harness.id, content: 'hello' })
    await dial.next((m) => m.t === 'summary' && m.agentId === harness.id, 60_000, 'its answer', since)
    expect(questions(dial, harness.id)).toEqual([])
    since = dial.messages.length
    engine.type('hello')
    await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', since)
    expect(questions(dial, engine.id)).toEqual([])
    client.close()
  })

  // Answering an ask closes the ask, not the turn (#4620): the turn goes on after it, and its end is news as any turn's.
  it('a Harness agent\'s turn that asks permission, is allowed on the dial and goes on rings when it ends', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    const { id } = await create(d, window, 'permit-rings')
    const dial = await plugged(desk)
    await listed(dial, id)
    const since = dial.messages.length
    window.send('message', { agentId: id, content: '!permit printf hi' })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === id, 45_000, 'the permission asked', since)
    const { q } = (question.questions as Array<{ q: string }>)[0]
    dial.send({ t: 'answer', agentId: id, requestId: question.id, answers: { [q]: 'Yes' } })
    await dial.next((m) => m.t === 'question.close' && m.agentId === id, 45_000, 'the ask closed', since)
    const summary = await dial.next((m) => m.t === 'summary' && m.agentId === id, 60_000, 'its answer', since)
    expect(summary).toMatchObject({ tier: 'alert' })
    expect(summary.silent).toBeUndefined()
    expect(await d.capture(String((await row(window, id))?.tmuxPane))).toContain('ran printf hi')
    window.close()
  })

  it('a Codex session\'s notice is its own card', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const codex = new CodexOutside(d, 'api', children, { TERM_PROGRAM: 'ghostty' })
    await codex.hook('SessionStart', { source: 'startup' })
    await listed(dial, codex.id)
    expect(await notify(d, { CODEX_THREAD_ID: codex.sessionId }, codex.cwd)).toMatchObject({ code: 0, out: SHOWN })
    expect(await dial.next((m) => m.t === 'question' && m.agentId === codex.id, 45_000, 'the notice'))
      .toMatchObject({ name: 'api', id: expect.stringMatching(/^shown:/), questions: rung() })
    expect(await opened(dial, codex.id)).toMatchObject({ ok: true, questions: card('Ghostty') })
    await until('the notice in the daemon\'s log', () => d.log().includes('[device] notify · codex · shown'), 30_000, 50)
  })

  it('a Harness agent\'s notice is tied to the agent, and a plain one goes at its next turn', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await plugged(desk)
    await listed(dial, harness.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: harness.sessionId }
    const cwd = join(d.projectsDir, 'in-harness')
    expect(await notify(d, caller, cwd)).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === harness.id, 45_000, 'the notice')
    expect(question).toMatchObject({ id: expect.stringMatching(/^shown:/), questions: rung() })
    expect(await opened(dial, harness.id)).toMatchObject({ ok: true, questions: card('Harness') })
    expect(questions(dial, observedAgentId('claude', harness.sessionId))).toEqual([])

    // Its next turn closes it, as before: who started the turn only the core knows (rule 5).
    const since = dial.messages.length
    await client.turn(harness.id, 'go on')
    await dial.next((m) => m.t === 'question.close' && m.agentId === harness.id && m.id === question.id, 45_000, 'the card closed', since)
    expect(await notify(d, caller, cwd, ['--list'])).toMatchObject({ code: 0, out: '' })
    client.close()
  })

  it('a session nobody lists still rings, under its folder, and its card goes at a tap', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const sessionId = randomUUID()
    const agentId = observedAgentId('claude', sessionId)
    expect(await notify(d, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: sessionId }, join(d.projectsDir, 'scratch')))
      .toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === agentId, 45_000, 'the notice')
    expect(question).toMatchObject({ name: 'scratch', id: expect.stringMatching(/^shown:/), questions: rung() })
    expect(await opened(dial, agentId)).toMatchObject({ ok: true, questions: card('Terminal') })

    // The person taps "In Terminal": nothing lists the session, so nothing opens and the dial has no face of it to ask
    // on, and its next turn may never be heard. The tap is its card's end.
    const tapped = dial.messages.length
    dial.send({ t: 'agent.open', agentId })
    await dial.next((m) => m.t === 'question.close' && m.agentId === agentId && m.id === question.id, 45_000, 'the card closed', tapped)
  })

  it('it rings with a window open on its tab', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    // A window on a tab, as the desktop says it: the dial shows the tab's list, and an outside agent's turns are held.
    const window = await LocalClient.connect(d)
    const since = dial.messages.length
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    window.send('app_panes', { agentIds: [], foreground: true })
    await dial.next((m) => m.t === 'agents.end' && m.tab === 't1', 45_000, 'the tab\'s list', since)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    expect(await notify(d, caller, join(d.projectsDir, 'fix-login'))).toMatchObject({ code: 0, out: SHOWN })
    expect(await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice', since))
      .toMatchObject({ questions: rung() })
    window.close()
  })

  it('with Notifications on Needs you, a plain finished turn draws its tile alone and the list holds only what needs the person, after a replug too', async () => {
    const { d, desk } = await fresh({}, (d) => {
      mkdirSync(d.dataDir, { recursive: true })
      writeFileSync(join(d.dataDir, 'dial-notify.json'), '{"mode":"you"}\n')
    })
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    const since = dial.messages.length
    engine.type('hello')
    expect(await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', since)).toMatchObject({ tier: 'silent' })

    // A notice of a session nobody lists, and a window whose unread list holds that turn's end and another agent's question.
    const sessionId = randomUUID()
    const noticed = observedAgentId('claude', sessionId)
    expect(await notify(d, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: sessionId }, join(d.projectsDir, 'scratch')))
      .toMatchObject({ code: 0, out: SHOWN })
    await dial.next((m) => m.t === 'question' && m.agentId === noticed, 45_000, 'the notice')
    const window = await LocalClient.connect(d)
    window.send('app_unread', { items: [
      { agentId: engine.id, machineId: d.computerId, text: 'done' },
      { agentId: 'asks-1', machineId: d.computerId, question: true, text: 'Ship it?' },
    ] })
    const items = (m: DialMessage) => (m.items ?? []) as Array<Record<string, unknown>>
    const drawer = async (on: FakeDial, from: number) => items(await on.next((m) => m.t === 'notif.replace' &&
      items(m).some((item) => item.agentId === 'asks-1'), 60_000, 'the window\'s list', from)).map((item) => item.agentId)
    expect(await drawer(dial, since)).toEqual([noticed, 'asks-1'])

    // Plugged in again: the drawer it is handed holds no finished turn either. The notice, which rang already, is held
    // there, never asked again: the read answered after the list is the barrier.
    await desk.unplug('E2E-A')
    const again = await plugged(desk)
    expect(await drawer(again, 0)).toEqual([noticed, 'asks-1'])
    expect(await opened(again, noticed)).toMatchObject({ ok: true, questions: card('Terminal') })
    expect(again.messages.filter((m) => m.t === 'question' && m.agentId === noticed)).toEqual([])
    for (const on of [dial, again]) {
      expect(on.messages.filter((m) => m.t === 'notif.replace' && items(m).some((item) => item.agentId === engine.id))).toEqual([])
    }
    window.close()
  })

  it('with the dial unplugged it prints no dial', async () => {
    const { d, desk } = await fresh()
    await plugged(desk)
    const window = await LocalClient.connect(d)
    await desk.unplug('E2E-A')
    await until('the dial to read as unplugged', async () => {
      const answer = await window.request('harness_devices_list', {})
      return (answer.status?.devices as Array<{ id: string; attached: boolean }> | undefined)?.find((device) => device.id === 'E2E-A')?.attached === false || null
    }, 30_000, 500)
    expect(await notify(d, { CODEX_THREAD_ID: randomUUID() }, join(d.projectsDir, 'api'))).toMatchObject({ code: 0, out: 'no dial' })
    window.close()
  })

  it('with no dial on this computer it prints no dial and starts nothing', async () => {
    const { d } = await fresh({ CABLE_DISABLE: 'true' })
    const before = d.log().length
    expect(await notify(d, { CODEX_THREAD_ID: randomUUID() }, join(d.projectsDir, 'api'))).toMatchObject({ code: 0, out: 'no dial' })
    expect(d.log().slice(before)).not.toContain('asking for the devices\' process')
  })

  /** The cards of the daemon's file of pending notices, once it is there. */
  const stored = (d: IsolatedDaemon): Array<{ id: string }> | null => {
    try { return (JSON.parse(readFileSync(join(d.dataDir, 'dial-notices.json'), 'utf8')) as { cards: Array<{ id: string }> }).cards } catch { return null }
  }
  const inFile = (d: IsolatedDaemon, id: string) => until('the card in the file', () => stored(d)?.some((card) => card.id === id) || null, 30_000, 50)
  /** That agent's row in the first drawer since [since] that carries one. */
  const drawerRow = async (dial: FakeDial, agentId: string, since: number): Promise<Record<string, unknown>> => {
    const items = (m: DialMessage) => (m.items ?? []) as Array<Record<string, unknown>>
    const replaced = await dial.next((m) => m.t === 'notif.replace' && items(m).some((item) => item.agentId === agentId), 60_000, 'the row back', since)
    return items(replaced).find((item) => item.agentId === agentId)!
  }
  /** Opening its row reads the line, as the dial asks once a question row is opened. The list asked first is the barrier:
   *  the hold goes in its agent's order, a turn of the loop behind the drawer replace. */
  const opened = async (dial: FakeDial, agentId: string): Promise<DialMessage> => {
    let since = dial.messages.length
    dial.send({ t: 'agents.list' })
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the list', since)
    since = dial.messages.length
    dial.send({ t: 'question.read', agentId, requestId: 'read-1' })
    return dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the row read', since)
  }
  /** What rang for that agent since [since]: a question, an error, or a summary told aloud. */
  const rang = (dial: FakeDial, agentId: string, since: number): DialMessage[] => dial.messages.slice(since).filter((m) => m.agentId === agentId &&
    (m.t === 'question' || m.t === 'turn.error' || (m.t === 'summary' && m.restore !== true && m.tier !== 'silent')))

  it('an outside session\'s waiting notice comes back as a silent row after the devices restart, stays through its next prompt, and goes at --done', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    // A turn, so the scan after the restart finds its conversation.
    engine.type('before the restart')
    await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    await engine.idle(d)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const cwd = join(d.projectsDir, 'fix-login')
    const shown = await notify(d, caller, cwd, [LINE, '--waiting'])
    expect(shown).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice')
    await inFile(d, question.id as string)

    const back = dial.messages.length
    for (const pid of devicesPids(d)) process.kill(pid, 'SIGKILL')
    await dial.welcomeAfter(back, 60_000)
    expect(await drawerRow(dial, engine.id, back)).toMatchObject({ agentId: engine.id, question: true, summary: WAITING, name: 'fix-login' })
    // The row opens to its line, never "No readable question. Check the terminal."
    const state = await opened(dial, engine.id)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: [{ q: WAITING }] })
    expect(state.error).toBeUndefined()
    expect(rang(dial, engine.id, back)).toEqual([])

    // The person's next prompt starts a turn, which closes no waiting card; the agent's --done takes the card, from the
    // file too.
    const prompted = dial.messages.length
    engine.type('connected')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', prompted)
    await dial.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', prompted)
    await stays(dial, question, prompted)
    await listedThenDone(d, caller, cwd, dial, question, idOf(shown.out), WAITING)
    await until('the file emptied', () => stored(d)?.length === 0 || null, 30_000, 50)
    expect(d.log()).toContain('[device] notices · restored 1 · aged out 0')
    expect(d.log().split('\n').filter((line) => line.includes(LINE))).toEqual([])
  })

  it('a Harness agent\'s waiting notice comes back as a silent row after the devices restart, stays through a message, and goes at --done', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await plugged(desk)
    await listed(dial, harness.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: harness.sessionId }
    const cwd = join(d.projectsDir, 'in-harness')
    const shown = await notify(d, caller, cwd, [LINE, '--waiting'])
    expect(shown).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === harness.id, 45_000, 'the notice')
    await inFile(d, question.id as string)

    const back = dial.messages.length
    for (const pid of devicesPids(d)) process.kill(pid, 'SIGKILL')
    await dial.welcomeAfter(back, 60_000)
    expect(await drawerRow(dial, harness.id, back)).toMatchObject({ agentId: harness.id, question: true, summary: WAITING })
    const state = await opened(dial, harness.id)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: [{ q: WAITING }] })
    expect(state.error).toBeUndefined()
    expect(dial.messages.slice(back).filter((m) => m.t === 'question' && m.agentId === harness.id)).toEqual([])

    const prompted = dial.messages.length
    await client.turn(harness.id, 'go on')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === harness.id, 45_000, 'its turn started', prompted)
    await stays(dial, question, prompted)
    await listedThenDone(d, caller, cwd, dial, question, idOf(shown.out), WAITING)
    await until('the file emptied', () => stored(d)?.length === 0 || null, 30_000, 50)
    client.close()
  })

  it('two cards of one agent come back after a restart; the first shows its place, and --done brings the second up with no ring', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const engine = await startOutside(d, 'fix-login')
    await listed(dial, engine.id)
    // A turn, so the scan after the restart finds its conversation.
    engine.type('before the restart')
    await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    await engine.idle(d)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    const cwd = join(d.projectsDir, 'fix-login')
    const first = WAITING
    const second = 'Waiting · Rotate the staging keys too'
    const shown = await notify(d, caller, cwd, [LINE, '--waiting'])
    expect(shown).toMatchObject({ code: 0, out: SHOWN })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice')
    await inFile(d, question.id as string)

    // A second waiting card of the same agent, behind the first, as the devices would have kept it: its keys, a new id.
    // The devices go at once, before anything of theirs can write the file again.
    const file = join(d.dataDir, 'dial-notices.json')
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { v: number; cards: Array<Record<string, unknown>> }
    const secondId = `shown:${randomUUID()}`
    kept.cards.push({ ...kept.cards[0], id: secondId, line: second, at: (kept.cards[0].at as number) + 1 })
    writeFileSync(file, JSON.stringify(kept))
    const back = dial.messages.length
    for (const pid of devicesPids(d)) process.kill(pid, 'SIGKILL')
    await until('both cards restored', () => d.log().includes('[device] notices · restored 2 · aged out 0') || null, 60_000, 50)
    await dial.welcomeAfter(back, 60_000)
    expect(await drawerRow(dial, engine.id, back)).toMatchObject({ agentId: engine.id, question: true, summary: `${first} (1/2)` })

    // The agent closes the first: the second comes up as a row, its place gone, and nothing rings for it.
    const since = dial.messages.length
    expect(await notify(d, caller, cwd, ['--done', idOf(shown.out)])).toMatchObject({ code: 0, out: '' })
    await dial.next((m) => m.t === 'question.close' && m.agentId === engine.id && m.id === question.id, 45_000, 'the first closed', since)
    expect(await drawerRow(dial, engine.id, since)).toMatchObject({ agentId: engine.id, question: true, summary: second })
    expect(await opened(dial, engine.id)).toMatchObject({ ok: true, id: secondId, questions: [{ q: second }] })
    expect(rang(dial, engine.id, back)).toEqual([])
  })

  // The Pro's firmware drops an agent's question when that agent's next turn starts (pod_model.c set_state), while the
  // devices keep the card: they give it back to the Pro as a drawer row. The round dial keeps the card through a turn
  // start, and any question frame would ring it again.
  it('after its agent\'s turn starts, a Harness Pro gets the card back as a row, and the round dial gets no question frame', async () => {
    const { d, desk } = await fresh()
    const round = await plugged(desk)
    const pro = await plugged(desk, PRO, 'E2E-P', 'e2:e0:00:00:00:0b')
    const engine = await startOutside(d, 'fix-login')
    await listed(round, engine.id)
    const caller = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: engine.sessionId }
    expect(await notify(d, caller, join(d.projectsDir, 'fix-login'), [LINE, '--waiting'])).toMatchObject({ code: 0, out: SHOWN })
    const question = await round.next((m) => m.t === 'question' && m.agentId === engine.id, 45_000, 'the notice')
    await pro.next((m) => m.t === 'question' && m.agentId === engine.id && m.id === question.id, 45_000, 'the notice on the Pro')

    const onRound = round.messages.length
    const onPro = pro.messages.length
    engine.type('connected')
    const started = await pro.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started on the Pro', onPro)
    expect(await drawerRow(pro, engine.id, pro.messages.indexOf(started)))
      .toMatchObject({ agentId: engine.id, question: true, summary: WAITING })
    await round.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', onRound)
    // The turn's end is the barrier: whatever its start sent is sent by then.
    await round.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer', onRound)
    await pro.next((m) => m.t === 'summary' && m.agentId === engine.id, 60_000, 'its answer on the Pro', onPro)
    expect(pro.messages.slice(onPro).filter((m) => m.t === 'question' && m.agentId === engine.id)).toEqual([])
    expect(round.messages.slice(onRound).filter((m) => m.t === 'question' && m.agentId === engine.id)).toEqual([])
    await stays(round, question, onRound)
  })
})
