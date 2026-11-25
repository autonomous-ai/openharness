/**
 * The dial shows Claude Code waiting outside Harness (docs/specs/2026-11-13-device-claude-orca.md), on the real daemon: the
 * session's own hooks (the real hook/notify.mjs the daemon installed) tell where it runs and when its turns go, the
 * plugin's PermissionRequest hook runs the real `harness device claude asked`, and a fake dial on the desk
 * (harness/fakeDial.ts) shows what it is shown:
 * - the client prints nothing and exits at once, and with no dial nothing more happens: no devices process is started;
 * - with a dial, the agent waits with "<summary> · answer in Orca", also as a question the dial only shows (every answer
 *   to it refused, and a row of the drawer of a dial plugged in again), and the session's Stop ends the wait and closes it;
 * - the mod's inbox poll is refused with no dial and held with one;
 * - the dial reads the agent by its folder, then by the name its hook says, renamed by a later prompt, and no log holds it;
 * - words to a live Orca chat take today's route, its mod's poll, until the owner's hand test (Task 0 c of
 *   docs/plans/2026-11-23-dial-orca-chats-plan.md) keeps it or turns it off for chats.
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { heardClip } from '../src/cable/__fixtures__/heardClip.js'
import { RECORDED_ORCA_AGENTS } from '../src/testing/recordedOrca.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { IN_ORCA, InOrca } from './harness/inOrca.js'
import { inboxPoll } from './harness/modInbox.js'

/** At once, not a held hook's seconds: room for the CLI's own start on a loaded machine. */
const AT_ONCE_MS = 30_000
const ORCA = 'com.stablyai.orca'
/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c7'.repeat(16), computerId: 'e2e-device-claude-orca-computer', name: 'Fixture', token: 'e2e-device-claude-orca-token' }

describe('the dial shows Claude Code waiting outside Harness', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
  })
  /** A daemon of its own and a desk; with [relay], signed in to it as ME, for the dial's words. [before] runs on the daemon
   *  before it starts. */
  const fresh = async (relay?: FakeBackend, before?: (d: IsolatedDaemon) => void): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const signIn: Record<string, string> = relay ? { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId } : {}
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...signIn } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    if (relay) writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    before?.(d)
    await d.start()
    return { d, desk: theDesk }
  }
  /** The dial on the desk, welcomed and shown its first list. */
  const plugged = async (theDesk: Desk): Promise<FakeDial> => {
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return dial
  }
  /** What the dial was told the agent's line is, from [since]. */
  const line = (dial: FakeDial, agentId: string, text: string, what: string, since = 0): Promise<DialMessage> =>
    dial.next((m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === agentId && m.text === text, 45_000, what, since)

  it('no dial: the client prints nothing at once and exits 0, and no devices process is started', async () => {
    const { d } = await fresh()
    const claude = new InOrca(d, 'in-orca', children)
    await claude.hook('SessionStart', { source: 'startup' })
    const run = await claude.asked('printf hi')
    expect(run).toMatchObject({ stdout: '', stderr: '', code: 0 })
    expect(run.ms).toBeLessThan(AT_ONCE_MS)
    expect(devicesPids(d)).toEqual([])
  })

  it('the dial shows the agent waiting with "printf hi · answer in Orca", as a question nothing answers, and its Stop ends the wait', async () => {
    const { d, desk } = await fresh()
    let dial = await plugged(desk)
    const claude = new InOrca(d, 'in-orca', children)
    await claude.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'agent' && m.id === claude.id, 45_000, 'the agent listed')
    await claude.hook('UserPromptSubmit', { prompt: 'say hi' })
    await line(dial, claude.id, '', 'its turn started')
    const since = dial.messages.length
    const run = await claude.asked('printf hi')
    expect(run).toMatchObject({ stdout: '', stderr: '', code: 0 })
    expect(run.ms).toBeLessThan(AT_ONCE_MS)
    await line(dial, claude.id, 'printf hi · answer in Orca', 'the waiting line', since)
    // The round dial's asking face draws it from a question, which the dial only shows.
    const shown = [{ key: 'prompt', q: 'printf hi · answer in Orca', options: ['In Orca'] }]
    const question = await dial.next((m) => m.t === 'question' && m.agentId === claude.id, 45_000, 'the question', since)
    expect(question).toEqual({ t: 'question', agentId: claude.id, name: 'in-orca', machine: expect.any(String),
      id: expect.stringMatching(/^shown:/), questions: [{ key: '', q: shown[0].q, options: [] }] })
    // Nothing for the dial to answer with: no `a` on its row, and an answer, a reviewed one or spoken words are refused.
    expect(dial.messages.filter((m) => m.t === 'agent' && m.id === claude.id).map((row) => row.caps)).not.toContainEqual(expect.stringContaining('a'))
    const tried = dial.messages.length
    dial.send({ t: 'answer', agentId: claude.id, requestId: question.id, answers: { prompt: 'In Orca' } })
    dial.send({ t: 'question.read', agentId: claude.id, requestId: 'read-1' })
    const state = await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the question read', tried)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: shown })
    dial.send({ t: 'answer.reviewed', agentId: claude.id, requestId: 'send-1', token: state.token, choices: [1] })
    expect(await dial.next((m) => m.t === 'answer.receipt' && m.requestId === 'send-1', 45_000, 'the refusal', tried))
      .toMatchObject({ ok: false, error: 'Answer it in Orca.' })
    dial.send({ t: 'voice.begin', agentId: claude.id, questionToken: state.token, questionIndex: 0, uploadId: 'spoken-1' })
    dial.send({ t: 'voice.end', uploadId: 'spoken-1' })
    await dial.next((m) => m.t === 'voice.error' && m.uploadId === 'spoken-1', 45_000, 'the spoken refusal', tried)
    // A dial plugged in again holds it as a row of its first drawer, the devices' own questions first: a drawer carries
    // an open question as a row instead of asking it again (#4445).
    await desk.unplug('E2E-A')
    dial = await plugged(desk)
    const drawer = await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer')
    expect(drawer.items).toContainEqual(expect.objectContaining({ agentId: claude.id, name: 'in-orca', summary: 'printf hi · answer in Orca', question: true }))
    // Orca's secrets never left the hook.
    for (const secret of [IN_ORCA.ORCA_PAIRING_CODE, IN_ORCA.ORCA_AGENT_SESSION_SPAWN_TOKEN]) expect(JSON.stringify(dial.messages)).not.toContain(secret)
    // Answered in Orca, the turn goes to its end: the session's Stop.
    const answered = dial.messages.length
    await claude.hook('Stop', { stop_hook_active: false })
    const closed = await dial.next((m) => m.t === 'question.close' && m.agentId === claude.id && m.id === question.id, 45_000, 'the question closed', answered)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === claude.id, 45_000, 'its turn done', answered)
    // The dial was landed on the agent, so its line is read again as the shown agent's until the Stop clears it: never
    // after.
    expect(dial.messages.slice(dial.messages.indexOf(closed)).some((m) => m.agentId === claude.id && m.text === 'printf hi · answer in Orca')).toBe(false)
  })

  it('the dial reads a session by its folder, then by the name its hook says, and no log holds the name', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const claude = new InOrca(d, 'scratch-2016', children)
    const named = (name: string, what: string, since: number) =>
      dial.next((m) => m.t === 'agent' && m.id === claude.id && m.name === name, 45_000, what, since)
    await claude.hook('SessionStart', { source: 'startup' })
    await named('scratch-2016', 'the agent by its folder', 0)
    let since = dial.messages.length
    await claude.hook('UserPromptSubmit', { prompt: 'say hi', session_title: 'Tho' })
    await named('Tho', 'the agent by its name', since)
    // The turn already runs, so the name is all this prompt changes.
    since = dial.messages.length
    await claude.hook('UserPromptSubmit', { prompt: 'again', session_title: 'Math 7f3a91c2' })
    await named('Math 7f3a91c2', 'the agent renamed', since)
    expect(d.log()).not.toContain('7f3a91c2')
  })

  it('the inbox route answers 503 with no dial, and holds a poll with one', async () => {
    const { d, desk } = await fresh()
    const sessionId = randomUUID()
    expect((await inboxPoll(d, sessionId)).status).toBe(503)
    await plugged(desk)
    // Held: no answer within a second; the devices would end it only after 25 s.
    await expect(inboxPoll(d, sessionId, AbortSignal.timeout(1_000))).rejects.toThrow(/abort/i)
  })

  // Orca's chats have no command for words until Orca offers `orca agent send`; whether the mod's `prompt.submit` shows
  // them in Orca's chat as the person's own is Task 0 c, a hand test the owner has not run yet. This locks the route the
  // dial takes today, so that test's result changes it on purpose, here and in observed.ts, never by accident.
  it("today's route, locked until Task 0 c's hand test decides it: words to a live Orca chat whose mod polls reach that poll once, and the dial shows them sent", async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    let orca: FakeOrca | undefined
    const { d, desk } = await fresh(relay, (made) => { orca = FakeOrca.install(made) })
    // Orca lists the chat, and runs its process on no terminal: its hook names its Orca session and no handle.
    const orcaId = randomUUID()
    const title = `Chat ${orcaId.slice(0, 8)}`
    orca!.agents([{ ...RECORDED_ORCA_AGENTS.result.agents[0], orcaSessionId: orcaId, state: 'done',
      worktreeId: `${randomUUID()}::/e2e/orca-chat`, workspace: 'orca-chat', repo: 'e2e', paneKey: randomUUID(), title,
      lastAssistantMessage: 'Done.', updatedAt: Date.now() }])
    const dial = await plugged(desk)
    const chat = new InOrca(d, 'in-orca-chat', children, { ORCA_AGENT_SESSION_ID: orcaId, ORCA_STRUCTURED_SESSION: '1', __CFBundleIdentifier: ORCA })
    await chat.hook('SessionStart', { source: 'startup' })
    // One card: the hooked copy, named as Orca names the chat.
    await dial.next((m) => m.t === 'agent' && m.id === chat.id && m.name === title, 45_000, 'the chat by its Orca title')
    // Its mod polls: the dial may speak to it.
    const poll = inboxPoll(d, chat.sessionId)
    await dial.next((m) => m.t === 'agent' && m.id === chat.id && String(m.caps ?? '').includes('v'), 45_000, 'voice once its mod polls')
    const words = 'run the chat tests'
    relay.speech = words
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: chat.id, uploadId: 'spoken-chat', sr: 16_000, lang: 'en' })
    for (const frame of heardClip()) dial.audio(frame)
    dial.send({ t: 'voice.end', uploadId: 'spoken-chat' })
    expect(await dial.next((m) => (m.t === 'voice.transcript' || m.t === 'voice.error') && m.uploadId === 'spoken-chat', 45_000, 'the answer to its words', since))
      .toMatchObject({ t: 'voice.transcript', agentId: chat.id, text: words })
    expect(await poll).toEqual({ status: 200, body: { text: words } })
    await until('the route said', () => d.log().includes('[device] voice · mod') || undefined, 30_000, 50)
    // Once: the next poll is held, with nothing more for it.
    await expect(inboxPoll(d, chat.sessionId, AbortSignal.timeout(1_000))).rejects.toThrow(/abort/i)
    // Orca was handed none of them: no terminal of its typed them.
    expect(orca!.log().filter(({ argv }) => argv[1] === 'terminal' && argv[2] === 'send')).toEqual([])
    for (const secret of [words, orcaId, title]) expect(d.log()).not.toContain(secret)
  })
})
