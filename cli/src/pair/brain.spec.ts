/**
 * P2 — triage and one key (daemons/BRAIN.md).
 *
 * Two machines, both with a REAL PairSensor and journal: this one (machine-a, where the window is) and
 * a laptop (machine-b) reached through a fake link that does what the sealed relay does — carries
 * `pair_*` requests and `pair_event` pushes, nothing else. A fake clock, a stubbed one-shot, and the
 * brain's local frames captured where `sendLocal` would deliver them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairJournal } from './journal.js'
import { PairSensor, type PairSubject } from './sensor.js'
import { PairFleet, relayPairLinkOpener, type PairLinkOpener } from './fleet.js'
import { PairTriage, actionsFor, parseTriage, triagePrompt, type PairOneShot } from './triage.js'
import { PairVoice, DISPLAY_MS, UNSOLICITED_GAP_MS, doneLine, failLine, fillLine, needLine } from './voice.js'
import { PairBrain, TALK_COST_NOTE, type AnswerResult } from './brain.js'
import { ARM_MS, ShownLines } from './shown.js'
import type { DaemonSay, PairEvent, PairQuestion } from './protocol.js'
import type { Autonomy } from './floor.js'
import { BackendSocket } from '../backendSocket.js'

type Frame = Record<string, unknown>

const SUBJECTS: Record<string, PairSubject> = {
  api: { name: 'api', engine: 'claude' },
  web: { name: 'web', engine: 'codex' },
}
const ask = (q: string, options = ['Yes', 'No']) => [{ key: q, q, options, multi: false }]

let dirs: string[] = []
function sensorFor(machineId: string): PairSensor {
  const dir = mkdtempSync(join(tmpdir(), `pair-${machineId}-`))
  dirs.push(dir)
  const sensor = new PairSensor({ machineId: () => machineId, journal: new PairJournal({ dir }), describe: (id) => SUBJECTS[id] ?? null, now: Date.now })
  sensor.setPair('tim')
  return sensor
}

/** The laptop, as the relay would carry it: sealed requests in, pushes out. */
function laptop() {
  const sensor = sensorFor('machine-b')
  const answers: Frame[] = []
  let answerReply: Frame = { error: 'UNSUPPORTED' }
  let seq = 0
  const links: Array<{ drop: () => void }> = []
  const open: PairLinkOpener = async (machineId, on) => {
    if (machineId !== 'machine-b') throw new Error('NO_PEER_LINK')
    const connId = `relay-${++seq}`
    let closed = false
    links.push({ drop: () => { if (!closed) { closed = true; sensor.unwatch(connId); on.closed('relay dropped') } } })
    return {
      request: async (type, payload) => {
        if (closed) throw new Error('closed')
        if (type === 'pair_watch') {
          if (payload.off) { sensor.unwatch(connId); return { ok: true } }
          return { snapshot: sensor.watch(connId, (event) => { if (closed) return false; on.event(structuredClone(event)); return true }) }
        }
        if (type === 'pair_journal') return { ...sensor.journal(payload) }
        if (type === 'pair_answer') { answers.push(payload); return answerReply }
        return { error: 'UNSUPPORTED' }
      },
      close: () => { closed = true; sensor.unwatch(connId) },
    }
  }
  return { sensor, open, answers, links, reply: (r: Frame) => { answerReply = r } }
}

function world(opts: { oneshot?: PairOneShot | null; answer?: (i: { agentId: string; requestId: string; choice: string }) => Promise<AnswerResult>; linked?: boolean; model?: boolean; autonomy?: Autonomy; relayLimits?: Array<{ windowMs: number; max: number }>; talk?: (text: string) => Promise<Frame>; open?: (uid?: string) => Promise<Frame>; proposals?: ConstructorParameters<typeof PairBrain>[0]['proposals']; lessonKey?: ConstructorParameters<typeof PairBrain>[0]['lessonKey']; lessonReview?: ConstructorParameters<typeof PairBrain>[0]['lessonReview'] } = {}) {
  const local = sensorFor('machine-a')
  const remote = laptop()
  const frames: Frame[] = []
  const toClient: Array<{ connId: string; frame: Frame }> = []
  let brain: PairBrain | null = null
  const fleet = new PairFleet({
    local: { machineId: () => 'machine-a', name: () => 'desk', snapshot: () => local.snapshot(), subscribe: (l) => local.subscribe(l), journal: (p) => local.journal(p) },
    machines: () => [{ machineId: 'machine-b', name: 'laptop', linked: opts.linked !== false }],
    open: remote.open,
    onChange: (change) => brain?.onFleetChange(change),
    now: Date.now,
  })
  const oneshot = opts.oneshot === undefined ? null : opts.oneshot
  const answer = vi.fn(opts.answer ?? (async () => ({ ok: true })))
  const triage = new PairTriage({ oneshot, modelEnabled: () => opts.model === true, now: Date.now })
  // Every keyed frame is recorded against the windows it reaches, as cli.ts does (pair/shown.ts).
  const shown = new ShownLines(Date.now)
  const sendLocal = shown.sender((f) => frames.push(f), () => brain?.clientIds() ?? [])
  const voice = new PairVoice({ sendLocal, now: Date.now })
  brain = new PairBrain({
    pairing: { enabled: () => local.enabled(), pairedDaemon: () => local.pairedDaemon() },
    fleet, triage, voice, shown,
    sendLocal,
    sendLocalTo: shown.senderTo((connId, frame) => { toClient.push({ connId, frame }); return true }),
    answer, autonomy: () => opts.autonomy ?? 'suggest', now: Date.now,
    relayed: (fields) => { local.relayed(fields) },
    ...(opts.relayLimits ? { relayLimits: opts.relayLimits } : {}),
    ...(opts.talk ? { talk: opts.talk } : {}),
    ...(opts.open ? { open: opts.open } : {}),
    ...(opts.proposals ? { proposals: opts.proposals } : {}),
    ...(opts.lessonKey ? { lessonKey: opts.lessonKey } : {}),
    ...(opts.lessonReview ? { lessonReview: opts.lessonReview } : {}),
  })
  const says = () => frames.filter((f) => f.type === 'daemon_say').map((f) => f.payload as DaemonSay)
  const unsays = () => frames.filter((f) => f.type === 'daemon_unsay').map((f) => f.payload as Frame)
  /** A key from a window: it draws the line first (daemon_shown), and presses a moment later. */
  const act = async (payload: Frame, opts: { conn?: string; shown?: boolean } = {}): Promise<Frame> => {
    const conn = opts.conn ?? 'local:window'
    if (opts.shown !== false) { brain!.onShown(conn, { id: payload.id }); await vi.advanceTimersByTimeAsync(ARM_MS) }
    const replies: Frame[] = []
    await brain!.onKey(conn, payload, (f) => replies.push(f))
    return replies[0].payload as Frame
  }
  return { local, remote, brain, fleet, frames, toClient, says, unsays, act, answer, triage, voice }
}

const settle = async (ms = 1): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }

beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }) })
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('triage', () => {
  const question: PairQuestion = { requestId: 'q1', text: 'Approve Bash command: npm test', options: ['1. Yes', '2. Yes, and don\'t ask again for: npm *', '3. No, and tell Claude what to do'], multi: false, deny: false, allow: true, permission: true, since: 0 }
  const input = { daemonId: 'tim', machineId: 'machine-a', who: 'api', engine: 'claude', question, present: true }
  const on = () => true

  it('says the template at once, keys first; [y] is a ONE-TIME yes, never "don\'t ask again"', () => {
    const triage = new PairTriage({ oneshot: null, now: Date.now })
    expect(triage.template(input)).toEqual({
      line: '[y/n/g] api: Approve Bash command: npm test  (bell)', recommend: null, tier: 0,
      actions: [{ key: 'y', label: 'Yes', choice: '1. Yes' }, { key: 'n', label: 'No, and tell Claude what to do', choice: '3. No, and tell Claude what to do' }, { key: 'g', label: 'open', choice: 'open' }],
    })
  })

  it('never hands a model a secret: the question and its options are redacted in the prompt', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const prompt = triagePrompt({ ...input, question: { ...question, text: `Approve Bash command: GITHUB_TOKEN=${token} npm test`, options: ['1. Yes', `2. No, use ${token}`] } })
    expect(prompt).not.toContain(token)
    expect(prompt).toContain('[redacted]')
  })

  it('offers no [y] when the only yes answers for more than this once', () => {
    const only = { ...question, options: ['1. Yes, allow all edits during this session (shift+tab)', '2. No'] }
    expect(actionsFor(only, null).map((a) => a.key)).toEqual(['n', 'g'])
    expect(actionsFor(only, '1. Yes, allow all edits during this session (shift+tab)').map((a) => a.key)).toEqual(['n', 'g'])
    const codex = { ...question, options: ['1. Yes, proceed (y)', "2. Yes, and don't ask again for commands that start with `npm test` (p)", '3. No, and tell Codex what to do differently (esc)'] }
    expect(actionsFor(codex, null)[0]).toEqual({ key: 'y', label: 'Yes, proceed (y)', choice: '1. Yes, proceed (y)' })
    expect(parseTriage('{"line":"x","recommend":"2. Yes, and don\'t ask again for: npm *"}', question.options)).toBe('off-list')
  })

  it('offers [y] only on an allow-class permission prompt; anything else gets [g] to open the pane', () => {
    expect(actionsFor({ ...question, allow: false }, null).map((a) => a.key)).toEqual(['n', 'g'])
    // A question the agent asks, or a plan: nothing is answered for the person, not even a "no".
    expect(actionsFor({ ...question, permission: false }, null).map((a) => a.key)).toEqual(['g'])
    expect(actionsFor({ ...question, deny: true }, '1. Yes').map((a) => a.key)).toEqual(['n', 'g'])
    expect(actionsFor({ ...question, multi: true }, null).map((a) => a.key)).toEqual(['n', 'g'])
    expect(actionsFor({ ...question, options: ['Postgres', 'SQLite'], permission: false, allow: false }, 'SQLite')).toEqual([{ key: 'g', label: 'open', choice: 'open' }])
    expect(actionsFor(question, null, { watch: true })).toEqual([{ key: 'g', label: 'open', choice: 'open' }])
  })

  it('asks a model only when the person opted in, once per requestId, and replaces the line whole', async () => {
    const oneshot = vi.fn<PairOneShot>(async () => '{"line": "api wants to run the tests.", "recommend": "1. Yes"}')
    const off = new PairTriage({ oneshot, now: Date.now })
    expect(await off.refine(input)).toBeNull()
    expect(oneshot).not.toHaveBeenCalled()
    const triage = new PairTriage({ oneshot, modelEnabled: on, now: Date.now })
    const first = await triage.refine(input)
    expect(first).toEqual({ line: '[y/n/g] api wants to run the tests.', recommend: '1. Yes', tier: 1, actions: triage.template(input).actions })
    expect(await triage.refine(input)).toBe(first)
    expect(oneshot).toHaveBeenCalledTimes(1)
    const prompt = oneshot.mock.calls[0][0]
    expect(prompt).toContain('<question>\nApprove Bash command: npm test\n</question>')
    // No example that leans toward yes: the need line is not among the voice samples.
    expect(prompt).not.toMatch(/i'd say|\[y\/n\]/)
    expect(prompt.length).toBeLessThan(4_500)   // ~1k tokens
  })

  it('keeps the template on a timeout, bad JSON, an off-list suggestion or a bad line', async () => {
    const hang = new PairTriage({ oneshot: () => new Promise(() => {}), modelEnabled: on, now: Date.now })
    const pending = hang.triage(input)
    await settle(2_500)
    expect(await pending).toMatchObject({ tier: 0, why: 'timeout', recommend: null, line: '[y/n/g] api: Approve Bash command: npm test  (bell)' })
    for (const [reply, why] of [
      ['sure! api wants to run tests', 'bad-json'],
      ['{"line": "api wants to run the tests.", "recommend": "Yes, and always allow rm"}', 'off-list'],
      ['{"line": "", "recommend": null}', 'bad-line'],
    ] as const) {
      const triage = new PairTriage({ oneshot: async () => reply, modelEnabled: on, now: Date.now })
      expect(await triage.triage(input)).toMatchObject({ tier: 0, why, recommend: null })
    }
  })

  it('never sends a deny-class prompt to the model, nor asks while nobody is here or past the cap', async () => {
    const oneshot = vi.fn<PairOneShot>(async () => '{"line": "ship it", "recommend": "1. Yes"}')
    const triage = new PairTriage({ oneshot, modelEnabled: on, now: Date.now, hourlyCap: 2 })
    expect(await triage.triage({ ...input, question: { ...question, requestId: 'q-push', deny: true } })).toMatchObject({ tier: 0, why: 'deny' })
    expect(await triage.triage({ ...input, present: false })).toMatchObject({ tier: 0, why: 'absent' })
    expect(oneshot).not.toHaveBeenCalled()
    for (const id of ['a', 'b', 'c']) await triage.refine({ ...input, question: { ...question, requestId: id } })
    expect(oneshot).toHaveBeenCalledTimes(2)
    expect(await triage.triage({ ...input, question: { ...question, requestId: 'd' } })).toMatchObject({ tier: 0, why: 'cap' })
  })
})

describe('voice', () => {
  it('fills slots, keeps case, spacing and digits, and never shows a line with a slot it cannot fill', () => {
    expect(fillLine('bell in {who}: {q}', { who: 'api@office', q: 'Bash: npm test' })).toBe('bell in api@office: Bash: npm test')
    expect(fillLine('{who} finished! {recap}', { who: 'api' })).toBeNull()
    expect(needLine('vim', { who: 'api', question: 'Bash: npm test' }, [{ key: 'n' }, { key: 'g' }])).toBe('[n/g] api: Bash: npm test  E325')
    expect(needLine('ping', { who: 'api', question: 'Bash: npm run 2' }, [])).toBe('api: Bash: npm run 2  PING')
    // grue's need has no {who}: the harness is appended rather than left out.
    expect(needLine('grue', { who: 'api', question: 'Bash: ls' }, [{ key: 'g' }])).toBe('[g] api: Bash: ls  (in the dark)')
    expect(failLine('zsh', { who: 'api', reason: 'exit 1' })).toBe('api failed: exit 1  [exit 1]')
    expect(doneLine('fish', { who: 'web' })).toBe('web finished.')   // {recap} missing: the neutral fact
    expect(doneLine('fish', { who: 'web', recap: '3 tests fixed' })).toBe('web finished! 3 tests fixed')
  })

  it('says at most one unsolicited line every two minutes, never twice, and takes lines back', () => {
    const frames: Frame[] = []
    const voice = new PairVoice({ sendLocal: (f) => frames.push(f), now: Date.now })
    const say = (id: string, mood: DaemonSay['mood']) => voice.say({ id, mood, line: id, actions: [], ttlMs: DISPLAY_MS, about: { machineId: 'm', agentId: 'a' } })
    expect(say('need:1', 'need')).toBe(true)
    expect(say('need:1', 'need')).toBe(false)
    expect(say('fail:1', 'fail')).toBe(false)          // within two minutes of the last unsolicited line
    expect(say('back:1', 'back')).toBe(true)           // a return is asked for: it speaks
    expect(say('say:1', 'say')).toBe(true)
    vi.advanceTimersByTime(UNSOLICITED_GAP_MS)
    expect(say('fail:1', 'fail')).toBe(true)
    expect(frames.filter((f) => f.type === 'daemon_say')).toHaveLength(4)
    expect(voice.unsay('fail:1', 'gone')).toBe(true)
    expect(voice.unsay('fail:1', 'gone')).toBe(false)
  })

  it('keys work only while the line shows; a replacement keeps the time it had left', () => {
    const frames: Frame[] = []
    const voice = new PairVoice({ sendLocal: (f) => frames.push(f), now: Date.now })
    voice.say({ id: 'need:1', mood: 'need', line: 'a', actions: [{ key: 'y', label: 'Yes', choice: 'Yes' }], ttlMs: DISPLAY_MS, about: { machineId: 'm', agentId: 'a' } })
    vi.advanceTimersByTime(2_000)
    expect(voice.replace('need:1', { line: 'b', actions: [] })).toBe(true)
    expect(frames.at(-1)).toMatchObject({ type: 'daemon_say', payload: { id: 'need:1', line: 'b', ttlMs: DISPLAY_MS - 2_000 } })
    vi.advanceTimersByTime(DISPLAY_MS - 2_000)
    expect(voice.get('need:1')).toBeNull()
    expect(voice.replace('need:1', { line: 'c', actions: [] })).toBe(false)
  })
})

/** A permission prompt as the watcher reads it: the whole dialog, every line, and the transcript's open call. */
const permit = (cmd: string, description = 'Run it') => ({ permission: true, dialog: `Bash command\n\n  ${cmd}\n  ${description}\n\nDo you want to proceed?\n1. Yes\n2. No`,
  tools: [{ name: 'Bash', input: { command: cmd, description } }] })
const tick = async (): Promise<void> => { await settle(UNSOLICITED_GAP_MS) }

describe('the brain', () => {
  it('says a new question at once, keys first, and lists it in daemon_state with its keys while it shows', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    w.remote.sensor.turnStarted('api')
    w.remote.sensor.question('api', 'q_1', ask('Approve Bash command: npm test'), permit('npm test'))
    await settle(200)
    expect(w.says()).toEqual([expect.objectContaining({
      mood: 'need', line: '[y/n/g] api@laptop: Approve Bash command: npm test  (bell)', ttlMs: DISPLAY_MS,
      about: { machineId: 'machine-b', agentId: 'api', requestId: 'q_1' },
      actions: [{ key: 'y', label: 'Yes', choice: 'Yes' }, { key: 'n', label: 'No', choice: 'No' }, { key: 'g', label: 'open', choice: 'open' }],
    })])
    const state = () => w.frames.filter((f) => f.type === 'daemon_state').at(-1)!.payload as Frame
    expect(state()).toMatchObject({ pair: 'tim', working: 0, needs: [{ machineId: 'machine-b', machine: 'laptop', agentId: 'api',
      requestId: 'q_1', question: 'Approve Bash command: npm test', allow: true, id: w.says()[0].id }] })
    expect((state().machines as Frame[]).map((m) => [m.machineId, m.status])).toEqual([['machine-a', 'ok'], ['machine-b', 'ok']])
    // Once the line has gone, so have its keys: the need stays listed, for the person to open.
    await settle(DISPLAY_MS + 200)
    expect((state().needs as Frame[])[0]).not.toHaveProperty('actions')
    expect(await w.act({ requestId: 'r1', id: w.says()[0].id, choice: 'y' })).toMatchObject({ ok: false, error: 'GONE' })
  })

  it('another machine takes only an allow-class answer from here, a few a minute', async () => {
    // Two an hour, so the lines' own two-minute spacing stays inside the window.
    const w = world({ relayLimits: [{ windowMs: 60 * 60_000, max: 2 }] })
    w.remote.reply({ ok: true })
    w.brain.clientAttached('local:window')
    await settle()
    // Not allow-class there (a curl): no keys but [g] on its line, and a key sent anyway is not relayed.
    w.remote.sensor.question('api', 'q_curl', ask('Approve Bash command: curl -s https://x'), { permission: true, dialog: 'Bash command\n\n  curl -s https://x\n\nDo you want to proceed?\n1. Yes\n2. No' })
    await settle(200)
    const curl = w.says()[0]
    expect(curl.actions.map((a) => a.key)).toEqual(['g'])
    w.remote.sensor.questionGone('api', 'q_curl')
    await tick()
    // Allow-class: answered there, until the minute's relays are spent.
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      w.remote.sensor.question('api', `q_${i}`, ask('Approve Bash command: npm test'), permit('npm test'))
      await settle(200)
      ids.push(w.says().at(-1)!.id)
      const result = await w.act({ requestId: `r${i}`, id: ids[i], choice: i === 2 ? 'y' : 'n' })
      if (i < 2) expect(result).toMatchObject({ ok: true, machineId: 'machine-b' })
      else expect(result).toMatchObject({ ok: false, error: 'RATE_LIMITED' })
      w.remote.sensor.questionGone('api', `q_${i}`)
      await tick()
    }
    expect(w.remote.answers).toHaveLength(2)
  })

  it('talk comes only from a window, six a minute, and every answer says what it costs', async () => {
    const talked: string[] = []
    const w = world({ talk: async (text) => { talked.push(text); return { ok: true, sent: true } } })
    const talk = async (conn: string, text: string): Promise<Frame> => {
      const replies: Frame[] = []
      await w.brain.onTalk(conn, { requestId: 't', text }, (f) => replies.push(f))
      return replies[0].payload as Frame
    }
    expect(await talk('local:tool', 'hi')).toMatchObject({ ok: false, error: 'UI_ONLY', cost: TALK_COST_NOTE })
    w.brain.clientAttached('local:window')
    for (let i = 0; i < 6; i++) expect(await talk('local:window', `hi ${i}`)).toEqual({ requestId: 't', ok: true, sent: true, cost: TALK_COST_NOTE })
    expect(await talk('local:window', 'once more')).toMatchObject({ ok: false, error: 'RATE_LIMITED', retryAfterMs: 60_000 })
    await settle(60_000)
    expect(await talk('local:window', 'later')).toMatchObject({ ok: true })
    expect(talked).toHaveLength(7)
  })

  it('only an attached window can open its companion terminal, without a talk or cost', async () => {
    const open = vi.fn(async () => ({ ok: true, agentId: 'pair-tim' }))
    const w = world({ open })
    const replies: Frame[] = []
    const send = (f: Frame) => { replies.push(f) }
    await w.brain.onOpen('tool', { requestId: 'o1', companionUid: 'tim-one' }, send)
    expect(replies.pop()?.payload).toMatchObject({ ok: false, error: 'UI_ONLY' })
    expect(open).not.toHaveBeenCalled()
    w.brain.clientAttached('window')
    await w.brain.onOpen('window', { requestId: 'o2' }, send)
    expect(replies.pop()?.payload).toMatchObject({ ok: false, error: 'STALE_COMPANION' })
    await w.brain.onOpen('window', { requestId: 'o3', companionUid: 'tim-one' }, send)
    expect(open).toHaveBeenCalledWith('tim-one', undefined)
    expect(replies.pop()).toEqual({ type: 'daemon_open_result', payload: { requestId: 'o3', ok: true, agentId: 'pair-tim' } })
    await w.brain.onOpen('window', { requestId: 'o4', companionUid: 'tim-one', engine: 'codex' }, send)
    expect(open).toHaveBeenLastCalledWith('tim-one', 'codex')
    await w.brain.onOpen('window', { requestId: 'o5', companionUid: 'tim-one', engine: 'unknown' }, send)
    expect(replies.pop()?.payload).toMatchObject({ error: 'BAD_ENGINE' })
    await w.brain.onOpen('tool', { requestId: 'o6', companionUid: 'tim-one', engine: 'codex' }, send)
    expect(replies.pop()?.payload).toMatchObject({ error: 'UI_ONLY' })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('a key counts only from the window that was shown the line, a moment after it was shown', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    w.remote.reply({ ok: true })
    w.remote.sensor.question('api', 'q_1', ask('Approve Bash command: npm test'), permit('npm test'))
    await settle(200)
    const id = w.says()[0].id
    // Never acknowledged as displayed: a script replaying the id has nothing to show for it.
    expect(await w.act({ requestId: 'r1', id, choice: 'y' }, { shown: false })).toMatchObject({ ok: false, error: 'NOT_SHOWN' })
    // Another connection cannot borrow this window's acknowledgement.
    w.brain.onShown('local:window', { id })
    w.brain.clientAttached('local:script')
    await settle(ARM_MS)
    expect(await w.act({ requestId: 'r2', id, choice: 'y' }, { conn: 'local:script', shown: false })).toMatchObject({ ok: false, error: 'NOT_SHOWN' })
    w.brain.clientDetached('local:window')
    w.brain.clientAttached('local:window')
    // A connection that is not an attached window (a tool, a relayed socket) is refused outright.
    expect(await w.act({ requestId: 'r3', id, choice: 'y' }, { conn: 'local:tool' })).toMatchObject({ ok: false, error: 'UI_ONLY' })
    // Shown and keyed in the same breath: too soon.
    w.brain.onShown('local:window', { id })
    const replies: Frame[] = []
    await w.brain.onKey('local:window', { requestId: 'r4', id, choice: 'y' }, (f) => replies.push(f))
    expect(replies[0].payload).toMatchObject({ ok: false, error: 'TOO_SOON' })
    expect(w.remote.answers).toEqual([])
    // A moment later, it counts.
    await settle(ARM_MS)
    replies.length = 0
    await w.brain.onKey('local:window', { requestId: 'r5', id, choice: 'y' }, (f) => replies.push(f))
    expect(replies[0].payload).toMatchObject({ ok: true, machineId: 'machine-b' })
    // A window that went away takes its acknowledgements with it.
    w.brain.clientDetached('local:window')
    expect(await w.act({ requestId: 'r6', id, choice: 'n' }, { shown: false })).toMatchObject({ ok: false, error: 'UI_ONLY' })
  })

  it('a lesson key needs both: its line shown here ARM_MS before, and the person (the nonce is the line id)', async () => {
    const nonce = 'a'.repeat(32)
    const id = `lesson:L1:${nonce}`
    const act = vi.fn(async (key: string) => key === id ? { ok: true, learned: 'run-tests-first' } : { ok: false, error: 'GONE' })
    let person: { ok: true } | { ok: false; error: string; detail: string } = { ok: false, error: 'INSIDE_HARNESS', detail: 'a process inside a harness never approves a lesson' }
    const w = world({ proposals: { owns: (key) => key.startsWith('lesson:'), act, pending: () => [] }, lessonKey: async () => person })
    w.brain.clientAttached('local:window')
    await settle()
    w.voice.say({ id, about: { machineId: 'machine-a', agentId: '' }, mood: 'ask', line: '[y/n/s] teach your agents "run-tests-first"?', actions: [], ttlMs: DISPLAY_MS, detail: 'the lesson' })
    // Not drawn on this window, or keyed in the same breath: nothing reaches the learner.
    expect(await w.act({ requestId: 'r1', id, choice: 'y' }, { shown: false })).toMatchObject({ ok: false, error: 'NOT_SHOWN' })
    w.brain.onShown('local:window', { id })
    const replies: Frame[] = []
    await w.brain.onKey('local:window', { requestId: 'r2', id, choice: 'y' }, (f) => replies.push(f))
    expect(replies[0].payload).toMatchObject({ ok: false, error: 'TOO_SOON' })
    await settle(ARM_MS)
    // Shown, armed, but not the person: refused.
    expect(await w.act({ requestId: 'r3', id, choice: 'y' }, { shown: false })).toMatchObject({ ok: false, error: 'INSIDE_HARNESS' })
    // A guessed nonce was never sent to this window, so it was never shown on it.
    person = { ok: true }
    const guessed = `lesson:L1:${'b'.repeat(32)}`
    w.brain.onShown('local:window', { id: guessed })
    await settle(ARM_MS)
    expect(await w.act({ requestId: 'r4', id: guessed, choice: 'y' }, { shown: false })).toMatchObject({ ok: false, error: 'NOT_SHOWN' })
    expect(act).not.toHaveBeenCalled()
    // Both hold: the learner gets the key, and checks the nonce is its live line's.
    expect(await w.act({ requestId: 'r5', id, choice: 'y' }, { shown: false })).toMatchObject({ ok: true, learned: 'run-tests-first' })
    expect(act).toHaveBeenCalledWith(id, 'y')
    // A daemon that cannot tell who pressed it teaches nothing.
    const bare = world({ proposals: { owns: (key) => key.startsWith('lesson:'), act, pending: () => [] } })
    bare.brain.clientAttached('local:window')
    await settle()
    bare.voice.say({ id, about: { machineId: 'machine-a', agentId: '' }, mood: 'ask', line: 'teach?', actions: [], ttlMs: DISPLAY_MS })
    expect(await bare.act({ requestId: 'r6', id, choice: 'y' })).toMatchObject({ ok: false, error: 'PERSON_ONLY' })
    expect(act).toHaveBeenCalledTimes(1)
  })

  it('replaces the template in place when an opted-in model answers in time — never waits for it', async () => {
    let answer: (text: string) => void = () => {}
    const w = world({ oneshot: () => new Promise((resolve) => { answer = resolve }), model: true })
    w.brain.clientAttached('local:window')
    await settle()
    w.local.question('web', 'q_1', ask('Approve Bash command: npm test'), permit('npm test'))
    await settle(10)
    expect(w.says()).toEqual([expect.objectContaining({ line: '[y/n/g] web: Approve Bash command: npm test  (bell)' })])
    answer('{"line": "web wants to run the tests.", "recommend": null}')
    await settle(10)
    const replaced = w.frames.filter((f) => f.type === 'daemon_say').map((f) => f.payload as DaemonSay)
    expect(replaced.map((s) => [s.id, s.line])).toEqual([[replaced[0].id, '[y/n/g] web: Approve Bash command: npm test  (bell)'], [replaced[0].id, '[y/n/g] web wants to run the tests.']])
  })

  it('never speaks about the pane the person is looking at', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    w.brain.onPresence('local:window', { active: true, focusAgentId: 'web' })
    await settle()
    w.local.question('web', 'q_1', ask('Approve Bash command: npm test'), permit('npm test'))
    w.local.failed('web', 'the engine exited')
    await settle(200)
    expect(w.says()).toEqual([])
    expect((w.brain.state().needs as Frame[]).map((n) => n.agentId)).toEqual(['web'])
    w.brain.onPresence('local:window', { focusAgentId: null })
    w.local.question('api', 'q_2', ask('Approve Bash command: ls'), permit('ls'))
    await settle(200)
    expect(w.says().map((s) => s.about.agentId)).toEqual(['api'])
  })

  it('a reconnect does not repeat a line — neither the laptop\'s relay nor the window', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    w.remote.sensor.question('api', 'q_1', ask('Bash: npm test'))
    await settle(200)
    expect(w.says()).toHaveLength(1)
    // The relay drops; the laptop is reached again on the next sync and its snapshot still holds the question.
    w.remote.links[0].drop()
    await settle(61_000)
    expect(w.fleet.machines().find((m) => m.machineId === 'machine-b')?.status).toBe('ok')
    // The window reconnects: it is sent the state, not the line again. It was the only window, so its
    // return starts the brain, and a start is told to every window attached (this one).
    const statesBefore = w.frames.filter((f) => f.type === 'daemon_state').length
    w.brain.clientDetached('local:window')
    w.brain.clientAttached('local:window')
    expect(w.frames.filter((f) => f.type === 'daemon_state').length).toBe(statesBefore + 1)
    await settle(200)
    expect(w.says()).toHaveLength(1)
    expect(w.frames.filter((f) => f.type === 'daemon_state').at(-1)?.payload).toMatchObject({ needs: [{ requestId: 'q_1' }] })
  })

  it('a question already open when the brain starts watching is a baseline: no line', async () => {
    const w = world()
    w.remote.sensor.question('api', 'q_old', ask('Allow the edit?'))
    w.local.question('web', 'q_mine', ask('Allow the read?'))
    w.brain.clientAttached('local:window')
    await settle(200)
    expect(w.says()).toEqual([])
    expect((w.brain.state().needs as unknown[]).length).toBe(2)
  })

  it('counts finished turns instead of saying them (cleared when the person looks); says a failure', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    w.local.turnStarted('web')
    w.local.turnEnded('web')
    w.local.recap('web', 'Fixed the login redirect.')
    w.local.turnStarted('api')
    w.local.turnEnded('api', { aborted: true })
    w.remote.sensor.turnStarted('api')
    w.remote.sensor.turnEnded('api')
    await settle(200)
    expect(w.says()).toEqual([])
    expect(w.brain.state().done).toEqual({ count: 2, last: [
      expect.objectContaining({ machineId: 'machine-b', name: 'api@laptop', recap: null }),
      expect.objectContaining({ machineId: 'machine-a', name: 'web', recap: 'Fixed the login redirect.' }),
    ] })
    w.brain.onPresence('local:window', { doneSeen: true })
    expect(w.brain.state().done).toEqual({ count: 0, last: [] })
    w.remote.sensor.failed('api', 'the engine exited')
    await settle(200)
    expect(w.says().map((s) => [s.mood, s.line])).toEqual([['fail', '[g] api@laptop failed: the engine exited  (pane is dead)']])
    expect(w.brain.state().failing).toEqual([expect.objectContaining({ name: 'api', reason: 'the engine exited' })])
  })

  it('answered elsewhere sends daemon_unsay', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    w.remote.sensor.question('api', 'q_1', ask('Bash: npm test'))
    await settle(200)
    const id = w.says()[0].id
    w.remote.sensor.questionGone('api', 'q_1')
    await settle(200)
    expect(w.unsays()).toEqual([{ id, reason: 'answered' }])
    expect(w.brain.state().needs).toEqual([])
  })

  it('daemon_act reaches the machine that owns the harness', async () => {
    const w = world()
    w.remote.reply({ ok: true })
    w.brain.clientAttached('local:window')
    await settle()
    w.remote.sensor.question('api', 'q_remote', ask('Approve Bash command: npm test'), permit('npm test'))
    await settle(200)
    const remoteSay = w.says()[0]
    expect(await w.act({ requestId: 'r1', id: remoteSay.id, choice: 'y' })).toEqual({ requestId: 'r1', id: remoteSay.id, ok: true, machineId: 'machine-b' })
    // No `by` on the wire: the owning machine decides who asked from how it arrived.
    expect(w.remote.answers).toEqual([{ agentId: 'api', requestId: 'q_remote', expectRequestId: 'q_remote', choice: 'Yes' }])
    // Journaled on this machine too, with the window it came from.
    expect(w.local.journal({}).entries.filter((e) => e.kind === 'relayed')).toEqual([expect.objectContaining({
      target: 'machine-b', origin: 'local:window', agentId: 'api', requestId: 'q_remote', text: 'relayed "Yes" to api@laptop: answered' })])
    expect(w.answer).not.toHaveBeenCalled()
    await tick()
    w.local.question('web', 'q_local', ask('Read src/auth.ts?'), { permission: true, dialog: 'Read file\n\n  /etc/hosts\n\nDo you want to proceed?\n1. Yes\n2. No' })
    await settle(200)
    const localSay = w.says()[1]
    expect(await w.act({ requestId: 'r2', id: localSay.id, choice: 'n' })).toMatchObject({ ok: true, machineId: 'machine-a' })
    expect(w.answer).toHaveBeenCalledWith({ agentId: 'web', requestId: 'q_local', choice: 'No' })
    expect(await w.act({ requestId: 'r3', id: localSay.id, choice: 'g' })).toMatchObject({ ok: false, error: 'GONE' })
    expect(w.unsays().map((u) => u.id)).toEqual([remoteSay.id, localSay.id])
  })

  it('[g] only opens the pane; at autonomy watch the lines carry nothing else and no key answers', async () => {
    const w = world({ autonomy: 'watch' })
    w.brain.clientAttached('local:window')
    await settle()
    w.local.question('web', 'q_1', ask('Approve Bash command: npm test'), permit('npm test'))
    await settle(200)
    const say = w.says()[0]
    expect(say.actions).toEqual([{ key: 'g', label: 'open', choice: 'open' }])
    expect(say.line).toBe('[g] web: Approve Bash command: npm test  (bell)')
    expect(await w.act({ requestId: 'r1', id: say.id, choice: 'g' })).toMatchObject({ ok: true, open: { machineId: 'machine-a', agentId: 'web' } })
    expect(await w.act({ requestId: 'r2', id: say.id, choice: 'y' })).toMatchObject({ ok: false, error: 'NOT_OFFERED' })
    expect(w.answer).not.toHaveBeenCalled()
  })

  it('a stale answer sends no keys: the question on the harness is no longer the one the line was about', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    w.local.question('web', 'q_first', ask('Read src/auth.ts?'))
    await settle(200)
    const first = w.says()[0]
    // The dialog moved on before the key arrived (the watcher reports a different question).
    w.local.question('web', 'q_second', ask('Bash: git push origin main'))
    expect(await w.act({ requestId: 'r1', id: first.id, choice: 'n' })).toMatchObject({ ok: false, error: expect.stringMatching(/GONE|STALE_QUESTION/) })
    expect(w.answer).not.toHaveBeenCalled()
  })

  it('surfaces the dialog\'s own STALE_QUESTION in daemon_act_result, from this machine and from another', async () => {
    const w = world({ answer: async () => ({ ok: false, error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' }) })
    w.remote.reply({ error: 'STALE_QUESTION', detail: 'That question is no longer open.' })
    w.brain.clientAttached('local:window')
    await settle()
    w.local.question('web', 'q_local', ask('Approve Bash command: ls'), permit('ls'))
    await settle(200)
    const localSay = w.says()[0]
    expect(await w.act({ requestId: 'r1', id: localSay.id, choice: 'y' }))
      .toEqual({ requestId: 'r1', id: localSay.id, ok: false, machineId: 'machine-a', error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' })
    await tick()
    w.remote.sensor.question('api', 'q_remote', ask('Approve Bash command: npm test'), permit('npm test'))
    await settle(200)
    const remoteSay = w.says()[1]
    expect(await w.act({ requestId: 'r2', id: remoteSay.id, choice: 'y' }))
      .toEqual({ requestId: 'r2', id: remoteSay.id, ok: false, machineId: 'machine-b', error: 'STALE_QUESTION', detail: 'That question is no longer open.' })
    expect(w.remote.answers[0]).toMatchObject({ expectRequestId: 'q_remote' })
    expect(w.remote.answers[0]).not.toHaveProperty('by')
    // Nothing was typed, and those keys can never work again: both lines go, as stale.
    expect(w.unsays()).toEqual([{ id: localSay.id, reason: 'stale' }, { id: remoteSay.id, reason: 'stale' }])
  })

  it('reads the WHOLE dialog: a wrapped `&& git push` is deny-class, and gets no [y] from any key', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    // The clipped title shows only the first line; the second line pushes.
    w.local.question('web', 'q_push', ask('Approve Bash command: npm test &&'), { permission: true, dialog: 'Bash command\n\n  npm test &&\n  git push origin main\n  Test then push\n\nDo you want to proceed?\n1. Yes\n2. No' })
    await settle(200)
    const say = w.says()[0]
    expect(w.local.snapshot().harnesses[0].question).toMatchObject({ deny: true, allow: false })
    expect(say.actions.map((a) => a.key)).toEqual(['n', 'g'])
    expect(await w.act({ requestId: 'r1', id: say.id, choice: 'Yes' })).toMatchObject({ ok: false, error: 'NOT_OFFERED' })
    expect(await w.act({ requestId: 'r2', id: say.id, choice: 'y' })).toMatchObject({ ok: false, error: 'NOT_OFFERED' })
    expect(w.answer).not.toHaveBeenCalled()
  })

  it('reports what a rule or the pair did on its own, afterwards; a key\'s own act is not reported', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await settle()
    w.local.turnStarted('web')
    w.local.acted({ agentId: 'web', name: 'web', engine: 'codex' }, { by: 'rule', action: 'answer', text: 'answered "Yes" to "Bash: npm test"' })
    await settle(200)
    expect(w.says().map((s) => [s.mood, s.line])).toEqual([['auto', 'rule: web answered "Yes" to "Bash: npm test"']])
    w.local.acted({ agentId: 'web', name: 'web', engine: 'codex' }, { by: 'key', action: 'stop', text: 'stopped the turn' })
    await settle(200)
    expect((w.brain.state().acted as Frame[]).map((a) => a.by)).toEqual(['rule'])
  })

  it('a laptop that is not linked is never dialled; a sleeping one is asleep, not failing; one too old is named', async () => {
    const unlinked = world({ linked: false })
    const open = vi.spyOn(unlinked.remote, 'open')
    unlinked.brain.clientAttached('local:window')
    await settle()
    expect(open).not.toHaveBeenCalled()
    expect(unlinked.fleet.machines()[1].status).toBe('unlinked')

    // One the account already lists as offline (a sleeping laptop) is asleep, without a dial.
    const dial = vi.fn(async () => { throw new Error('unused') })
    const asleep = new PairFleet({
      local: { machineId: () => 'a', name: () => 'desk', snapshot: () => ({ machineId: 'a', epoch: 'e', seq: 0, rev: 0, harnesses: [] }), subscribe: () => () => {}, journal: () => ({ epoch: 'e', seq: 0, entries: [] }) },
      machines: () => [{ machineId: 'b', name: 'laptop', linked: true, online: false }],
      open: dial, onChange: () => {},
    })
    asleep.start()
    await settle()
    expect(dial).not.toHaveBeenCalled()
    expect(asleep.machines()[1].status).toBe('asleep')
    asleep.stop()

    let fleetStatus = ''
    const old = new PairFleet({
      local: { machineId: () => 'a', name: () => 'desk', snapshot: () => ({ machineId: 'a', epoch: 'e', seq: 0, rev: 0, harnesses: [] }), subscribe: () => () => {}, journal: () => ({ epoch: 'e', seq: 0, entries: [] }) },
      machines: () => [{ machineId: 'b', name: 'old-mac', linked: true }],
      open: async () => ({ request: async () => ({ error: 'UNSUPPORTED' }), close: () => {} }),
      onChange: (c) => { if (c.status) fleetStatus = c.status },
    })
    old.start()
    await settle()
    expect(fleetStatus).toBe('old')
    old.stop()
  })

  it('pairing coming on tells the window already on the socket, never a tool client or the cloud', async () => {
    const socket = new BackendSocket('token')
    const internals = socket as unknown as { queue: Array<{ data: string }>; enqueue: (m: unknown) => void }
    const enqueued: string[] = []
    const enqueue = internals.enqueue.bind(socket)
    internals.enqueue = (msg: unknown) => { enqueued.push(JSON.stringify(msg)); enqueue(msg) }
    const windowFrames: Frame[] = []
    const toolFrames: Frame[] = []
    socket.registerLocalClient('local:window', { sendFrame: (f) => { windowFrames.push(f); return true }, sendBinary: () => true })
    socket.registerLocalClient('local:tool', { sendFrame: (f) => { toolFrames.push(f); return true }, sendBinary: () => true }, { tool: true })
    let paired: string | null = null
    const fleet = new PairFleet({
      local: { machineId: () => socket.machineId, name: () => 'desk', snapshot: () => ({ machineId: socket.machineId, epoch: 'e', seq: 0, rev: 0, harnesses: [] }), subscribe: () => () => {}, journal: () => ({ epoch: 'e', seq: 0, entries: [] }) },
      machines: () => [], open: async () => { throw new Error('NO_PEER_LINK') }, onChange: () => {},
    })
    const brain = new PairBrain({
      pairing: { enabled: () => paired !== null, pairedDaemon: () => paired }, fleet,
      triage: new PairTriage({ oneshot: null, now: Date.now }),
      voice: new PairVoice({ sendLocal: (f) => socket.sendLocal(f), now: Date.now }),
      sendLocal: (f) => socket.sendLocal(f), sendLocalTo: (c, f) => socket.sendLocalTo(c, f),
      answer: async () => ({ ok: false, error: 'UNSUPPORTED' }), now: Date.now,
    })
    // As cli.ts does: the windows already here (never the tool), then pairing comes on and it refreshes.
    for (const connId of socket.localClientIds()) brain.clientAttached(connId)
    expect(brain.clientIds()).toEqual(['local:window'])
    expect(windowFrames.filter((f) => f.type === 'daemon_state')).toEqual([])
    paired = 'tim'
    brain.refresh()
    brain.refresh()
    await settle(500)
    expect(windowFrames.filter((f) => f.type === 'daemon_state').map((f) => (f.payload as Frame).pair)).toEqual(['tim'])
    paired = null
    brain.refresh()
    expect(windowFrames.filter((f) => f.type === 'daemon_state').map((f) => (f.payload as Frame).pair)).toEqual(['tim', null])
    expect(toolFrames.filter((f) => String(f.type).startsWith('daemon_'))).toEqual([])
    expect(enqueued.filter((m) => m.includes('daemon_'))).toEqual([])
    await socket.unregisterLocalClient('local:window')
    await socket.unregisterLocalClient('local:tool')
    await socket.stop()
  })

  it('sends daemon_* only through sendLocal: nothing reaches the cloud queue', async () => {
    const socket = new BackendSocket('token')
    const internals = socket as unknown as { queue: Array<{ data: string }>; enqueue: (m: unknown) => void }
    const enqueued: string[] = []
    const enqueue = internals.enqueue.bind(socket)
    internals.enqueue = (msg: unknown) => { enqueued.push(JSON.stringify(msg)); enqueue(msg) }
    const windowFrames: Frame[] = []
    socket.registerLocalClient('local:window', { sendFrame: (f) => { windowFrames.push(f); return true }, sendBinary: () => true })
    const local = sensorFor(socket.machineId)
    let brain: PairBrain | null = null
    const fleet = new PairFleet({
      local: { machineId: () => socket.machineId, name: () => 'desk', snapshot: () => local.snapshot(), subscribe: (l) => local.subscribe(l), journal: (p) => local.journal(p) },
      machines: () => [], open: async () => { throw new Error('NO_PEER_LINK') }, onChange: (c) => brain?.onFleetChange(c),
    })
    brain = new PairBrain({
      pairing: { enabled: () => true, pairedDaemon: () => 'tim' }, fleet,
      triage: new PairTriage({ oneshot: null, now: Date.now }),
      voice: new PairVoice({ sendLocal: (f) => socket.sendLocal(f), now: Date.now }),
      sendLocal: (f) => socket.sendLocal(f), sendLocalTo: (c, f) => socket.sendLocalTo(c, f),
      answer: async () => ({ ok: false, error: 'UNSUPPORTED' }), now: Date.now,
    })
    socket.onLocalClient = (connId, attached) => attached ? brain!.clientAttached(connId) : brain!.clientDetached(connId)
    brain.clientAttached('local:window')
    local.turnStarted('api')
    local.question('api', 'q_1', ask('Bash: npm test'))
    await settle(200)
    local.questionGone('api', 'q_1')
    local.turnEnded('api')
    local.recap('api', 'ran the tests')
    local.failed('web', 'the engine exited')
    await settle(2_000)
    await brain.onAct({ requestId: 'r', id: 'nope', choice: 'y' }, (f) => { socket.sendLocalTo('local:window', f) })
    const types = windowFrames.map((f) => f.type)
    expect(types).toEqual(expect.arrayContaining(['daemon_state', 'daemon_say', 'daemon_unsay', 'daemon_act_result']))
    expect(enqueued.filter((m) => m.includes('daemon_'))).toEqual([])
    expect(internals.queue.map((q) => q.data).filter((d) => d.includes('daemon_'))).toEqual([])
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })
})

describe('the relay opener', () => {
  it('correlates pair_* results by requestId, hands pair_event on, and stops the watch on close', async () => {
    const sent: Frame[] = []
    let sink: { sendFrame: (f: Frame) => boolean } | null = null
    let detached = false
    const events: PairEvent[] = []
    let n = 0
    const open = relayPairLinkOpener({
      acquire: async (_m, s) => { sink = s; return { send: async (f) => { sent.push(f) }, detach: () => { detached = true } } },
      newId: () => `id-${++n}`,
    })
    const link = await open('machine-b', { event: (e) => events.push(e), closed: () => {} })
    const pending = link.request('pair_journal', { at: 5 }, 1_000)
    expect(sent[0]).toEqual({ type: 'pair_journal', payload: { at: 5, requestId: 'id-1' } })
    sink!.sendFrame({ type: 'connected', payload: {} })
    sink!.sendFrame({ type: 'pair_event', payload: { machineId: 'machine-b', rev: 1, agentId: 'api', harness: null } })
    sink!.sendFrame({ type: 'pair_journal_result', payload: { requestId: 'id-1', entries: [] } })
    expect(await pending).toEqual({ requestId: 'id-1', entries: [] })
    expect(events).toHaveLength(1)
    const late = expect(link.request('pair_watch', {}, 500)).rejects.toThrow('timeout')
    await settle(500)
    await late
    link.close()
    expect(sent.at(-1)).toMatchObject({ type: 'pair_watch', payload: { off: true } })
    expect(detached).toBe(true)
  })
})

describe('memory inbox review receipts', () => {
  it('issues a review only to its verified window, then requires its display receipt and reading delay', async () => {
    const id = 'lesson:beef:review-capability'
    const act = vi.fn(async () => ({ ok: true, learned: 'viewer-layout' }))
    const review = vi.fn(() => ({ ok: true, reviewId: id, text: 'Viewer left, agent terminal right.' }))
    const w = world({ lessonKey: async conn => conn === 'local:window' ? { ok: true } : { ok: false, error: 'PERSON_ONLY', detail: 'not a person' },
      lessonReview: review, proposals: { owns: value => value.startsWith('lesson:'), act, pending: () => [] } })
    expect(await w.brain.reviewLesson('tool', 'beef')).toMatchObject({ error: 'UI_ONLY' })
    w.brain.clientAttached('local:window'); w.brain.clientAttached('local:other')
    expect(await w.brain.reviewLesson('local:other', 'beef')).toMatchObject({ error: 'PERSON_ONLY' })
    expect(await w.brain.reviewLesson('local:window', 'beef')).toMatchObject({ ok: true, reviewId: id })
    const payload = { requestId: 'review-approval', id, choice: 'y' }
    expect(await w.act(payload, { shown: false })).toMatchObject({ error: 'NOT_SHOWN' })
    expect(await w.act(payload, { conn: 'local:other' })).toMatchObject({ error: 'NOT_SHOWN' })
    w.brain.onShown('local:window', { id })
    expect(await w.act(payload, { shown: false })).toMatchObject({ error: 'TOO_SOON' })
    expect(act).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(ARM_MS)
    expect(await w.act(payload, { shown: false })).toMatchObject({ ok: true, learned: 'viewer-layout' })
    expect(act).toHaveBeenCalledTimes(1)
    w.brain.clientDetached('local:window'); w.brain.clientDetached('local:other')
  })
})
