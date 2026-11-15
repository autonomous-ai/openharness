/**
 * The dial shows Claude Code waiting outside Harness (docs/specs/2026-11-13-device-claude-orca.md), on the real daemon: the
 * session's own hooks (the real hook/notify.mjs the daemon installed) tell where it runs and when its turns go, the
 * plugin's PermissionRequest hook runs the real `harness device claude asked`, and a fake dial on the desk
 * (harness/fakeDial.ts) shows what it is shown:
 * - the client prints nothing and exits at once, and with no dial nothing more happens: no devices process is started;
 * - with a dial, the agent waits with "<summary> · answer in Orca", also as a question the dial only shows (every answer
 *   to it refused, and asked again of a dial plugged in again), and the session's Stop ends the wait and closes it;
 * - the mod's inbox poll is refused with no dial and held with one;
 * - the dial reads the agent by its folder, then by the name its hook says, renamed by a later prompt, and no log holds it.
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { IsolatedDaemon } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { IN_ORCA, InOrca } from './harness/inOrca.js'

/** At once, not a held hook's seconds: room for the CLI's own start on a loaded machine. */
const AT_ONCE_MS = 30_000

/** A POST of the mod's poll over the daemon's socket, as the mod sends it: its status once answered. */
const inboxPoll = (d: IsolatedDaemon, sessionId: string, signal?: AbortSignal): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: d.socketPath, path: '/api/hook/inbox', method: 'POST', headers: { 'Content-Type': 'application/json' }, signal },
      (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(JSON.stringify({ sessionId }))
  })

describe('the dial shows Claude Code waiting outside Harness', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })
  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
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
    expect(question).toEqual({ t: 'question', agentId: claude.id, name: 'in-orca', engine: 'claude', machine: expect.any(String),
      id: expect.stringMatching(/^shown:/), questions: shown })
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
    // A dial plugged in again is shown it again, after the drawer that clears its own.
    await desk.unplug('E2E-A')
    dial = await plugged(desk)
    await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer')
    const drawer = dial.messages.findIndex((m) => m.t === 'notif.replace')
    expect(await dial.next((m) => m.t === 'question' && m.agentId === claude.id, 45_000, 'the question again', drawer + 1)).toMatchObject({ id: question.id, questions: shown })
    // Orca's secrets never left the hook.
    for (const secret of [IN_ORCA.ORCA_PAIRING_CODE, IN_ORCA.ORCA_AGENT_SESSION_SPAWN_TOKEN]) expect(JSON.stringify(dial.messages)).not.toContain(secret)
    // Answered in Orca, the turn goes to its end: the session's Stop.
    const answered = dial.messages.length
    await claude.hook('Stop', { stop_hook_active: false })
    await dial.next((m) => m.t === 'question.close' && m.agentId === claude.id && m.id === question.id, 45_000, 'the question closed', answered)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === claude.id, 45_000, 'its turn done', answered)
    expect(dial.messages.slice(answered).some((m) => m.agentId === claude.id && m.text === 'printf hi · answer in Orca')).toBe(false)
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
    expect(await inboxPoll(d, sessionId)).toBe(503)
    await plugged(desk)
    // Held: no answer within a second; the devices would end it only after 25 s.
    await expect(inboxPoll(d, sessionId, AbortSignal.timeout(1_000))).rejects.toThrow(/abort/i)
  })
})
