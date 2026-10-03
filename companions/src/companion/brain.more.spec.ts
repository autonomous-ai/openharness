/**
 * The brain's edges (pair/brain.ts) beyond brain.spec.ts, driven through a scripted fleet so each case sets
 * exactly the harness state a key lands on: the real voice, triage (no model) and shown-lines record, a
 * fake clock. What is pinned: a key never answers when the question moved, turned deny-class, or the dial
 * went to watch; a failure anywhere (the answer, a proposal, the talk, the lesson check) is a reply, never a
 * throw; what the brain says and stops saying as pairing, presence and the gate change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairBrain, TALK_COST_NOTE, type AnswerResult, type PairBrainDeps } from './brain.js'
import { PairVoice, UNSOLICITED_GAP_MS } from './voice.js'
import { PairTriage } from './triage.js'
import { ARM_MS, ShownLines } from './shown.js'
import type { FleetChange, FleetHarness, MachineJournal, PairFleet } from './fleet.js'
import type { DaemonSay, PairHarness, PairJournalEntry, PairQuestion } from './protocol.js'
import type { Autonomy } from './floor.js'
import type { ConfirmRequest, GateEvent } from './gate.js'

type Frame = Record<string, unknown>

const q = (over: Partial<PairQuestion> = {}): PairQuestion => ({
  requestId: 'q1', text: 'Approve Bash command: npm test', options: ['1. Yes', '2. No'], multi: false, deny: false, allow: true, permission: true, since: 1,
  dialog: 'Bash command\n\n  npm test\n\nDo you want to proceed?\n1. Yes\n2. No', ...over,
})
const h = (agentId: string, over: Partial<PairHarness> = {}): PairHarness => ({
  agentId, name: agentId, engine: 'claude', working: false, question: null, failing: null, lastDoneAt: null, recap: null, ...over,
})
let seq = 0
const entry = (kind: PairJournalEntry['kind'], agentId: string, over: Partial<PairJournalEntry> = {}): PairJournalEntry =>
  ({ epoch: 'e', seq: ++seq, at: Date.now(), kind, agentId, name: agentId, engine: 'claude', ...over })

/** A fleet whose harnesses the spec sets: machine-a is this computer, machine-b a laptop. */
function scriptedFleet() {
  const harnesses = new Map<string, FleetHarness>()
  let journals: (at: number, timeoutMs: number) => Promise<MachineJournal[]> = async () => []
  const request = vi.fn(async (_m: string, _t: string, _p: Frame): Promise<Frame> => ({ ok: true }))
  const fleet = {
    start: vi.fn(), stop: vi.fn(),
    machines: () => [
      { machineId: 'machine-a', name: 'desk', status: 'ok' as const, local: true },
      { machineId: 'machine-b', name: 'laptop', status: 'ok' as const, local: false },
    ],
    harnesses: () => [...harnesses.values()],
    find: (machineId: string, agentId: string) => harnesses.get(`${machineId}/${agentId}`) ?? null,
    request,
    journals: vi.fn((at: number, t: number) => journals(at, t)),
  }
  const set = (machineId: string, harness: PairHarness | null, agentId = harness?.agentId ?? '') => {
    if (!harness) { harnesses.delete(`${machineId}/${agentId}`); return }
    harnesses.set(`${machineId}/${harness.agentId}`, { machineId, machine: machineId === 'machine-a' ? 'desk' : 'laptop', local: machineId === 'machine-a', harness })
  }
  return { fleet, set, request, setJournals: (fn: typeof journals) => { journals = fn } }
}

function world(opts: Partial<Pick<PairBrainDeps, 'talk' | 'lessonKey' | 'proposals' | 'gate' | 'relayed' | 'onGuestConsent' | 'onGuestPair' | 'onGuestAutonomy' | 'onActiveChanged'>> & {
  enabled?: boolean; daemonId?: string | null; autonomy?: Autonomy; answer?: PairBrainDeps['answer']; noShown?: boolean; noAutonomy?: boolean } = {}) {
  let enabled = opts.enabled !== false
  let daemonId: string | null = opts.daemonId === undefined ? 'tim' : opts.daemonId
  let autonomy: Autonomy = opts.autonomy ?? 'suggest'
  const f = scriptedFleet()
  const frames: Frame[] = []
  const toClient: Array<{ connId: string; frame: Frame }> = []
  let brain: PairBrain | null = null
  const shown = new ShownLines(Date.now)
  const sendLocal = shown.sender((fr) => frames.push(fr), () => brain?.clientIds() ?? [])
  const voice = new PairVoice({ sendLocal, now: Date.now })
  const answer = vi.fn(opts.answer ?? (async (): Promise<AnswerResult> => ({ ok: true })))
  brain = new PairBrain({
    pairing: { enabled: () => enabled, pairedDaemon: () => daemonId },
    fleet: f.fleet as unknown as PairFleet,
    triage: new PairTriage({ oneshot: null, now: Date.now }),
    voice, sendLocal,
    sendLocalTo: shown.senderTo((connId, frame) => { toClient.push({ connId, frame }); return true }),
    answer,
    ...(opts.noAutonomy ? {} : { autonomy: () => autonomy }),
    ...(opts.noShown ? {} : { shown }),
    now: Date.now,
    ...Object.fromEntries(Object.entries(opts).filter(([k]) => ['talk', 'lessonKey', 'proposals', 'gate', 'relayed', 'onGuestConsent', 'onGuestPair', 'onGuestAutonomy', 'onActiveChanged'].includes(k))),
  })
  const change = (machineId: string, harness: PairHarness | null, e: PairJournalEntry | null, extra: Partial<FleetChange['event'] & object> = {}, agentId?: string) => {
    f.set(machineId, harness, agentId)
    const id = harness?.agentId ?? agentId ?? ''
    brain!.onFleetChange({ machineId, machine: machineId === 'machine-a' ? 'desk' : 'laptop', local: machineId === 'machine-a',
      event: { machineId, rev: ++seq, agentId: id, harness, ...(e ? { entry: e } : {}), ...extra } })
  }
  const says = () => frames.filter((fr) => fr.type === 'daemon_say').map((fr) => fr.payload as DaemonSay)
  const unsays = () => frames.filter((fr) => fr.type === 'daemon_unsay').map((fr) => fr.payload as Frame)
  const states = () => frames.filter((fr) => fr.type === 'daemon_state').map((fr) => fr.payload as Frame)
  const key = async (payload: Frame, conn = 'local:window'): Promise<Frame> => {
    brain!.onShown(conn, { id: payload.id })
    await vi.advanceTimersByTimeAsync(ARM_MS)
    const replies: Frame[] = []
    await brain!.onKey(conn, payload, (fr) => replies.push(fr))
    return replies[0]!.payload as Frame
  }
  const act = async (payload: Frame): Promise<Frame> => {
    const replies: Frame[] = []
    await brain!.onAct(payload, (fr) => replies.push(fr))
    return replies[0]!.payload as Frame
  }
  return {
    brain, f, frames, toClient, voice, answer, says, unsays, states, change, key, act, shown,
    setEnabled: (v: boolean) => { enabled = v }, setDaemon: (v: string | null) => { daemonId = v }, setAutonomy: (a: Autonomy) => { autonomy = a },
  }
}

/** A question line said about `agentId` on `machineId`: its id. */
async function asked(w: ReturnType<typeof world>, machineId = 'machine-a', agentId = 'api', question = q()): Promise<string> {
  // One unsolicited line every two minutes (pair/voice.ts): each question here is asked after that gap.
  await vi.advanceTimersByTimeAsync(UNSOLICITED_GAP_MS)
  w.change(machineId, h(agentId, { question }), entry('question', agentId, { requestId: question.requestId, text: question.text }))
  await vi.advanceTimersByTimeAsync(1)
  const say = w.says().find((s) => s.about.agentId === agentId && s.about.requestId === question.requestId)
  expect(say).toBeDefined()
  return say!.id
}

beforeEach(() => { vi.useFakeTimers({ now: 5_000_000 }); seq = 0 })
afterEach(() => { vi.useRealTimers() })

describe('the brain: on and off', () => {
  it('thinks only while paired and attached; pairing going off stops the fleet and tells the window once', async () => {
    const active = vi.fn()
    const w = world({ onActiveChanged: active })
    expect(w.brain.isActive).toBe(false)
    w.brain.clientAttached('local:window')
    expect(w.brain.isActive).toBe(true)
    expect(w.f.fleet.start).toHaveBeenCalledTimes(1)
    w.setEnabled(false)
    w.brain.refresh()
    w.brain.refresh()
    expect(w.brain.isActive).toBe(false)
    expect(w.f.fleet.stop).toHaveBeenCalledTimes(1)
    expect(active.mock.calls).toEqual([[true], [false]])
    // The state it sends when off says nothing about any harness.
    expect(w.states().at(-1)).toMatchObject({ pair: null, needs: [], machines: [], asks: [], acted: [] })
  })

  it('a window attached before pairing came on is told the state when it does: to every window, once', async () => {
    const w = world({ enabled: false })
    w.brain.clientAttached('local:window')
    w.brain.clientAttached('local:hn')
    expect(w.brain.isActive).toBe(false)
    expect(w.states()).toEqual([])
    // The zoo got a paired daemon and the person's consent (or the daemons switch came on): cli.ts refreshes.
    w.setEnabled(true)
    w.brain.refresh()
    expect(w.brain.isActive).toBe(true)
    expect(w.f.fleet.start).toHaveBeenCalledTimes(1)
    // One frame through sendLocal reaches every window at once; none is sent one of its own.
    expect(w.states()).toHaveLength(1)
    expect(w.states()[0]).toMatchObject({ pair: 'tim', autonomy: 'suggest', needs: [], confirms: [] })
    expect(w.toClient).toEqual([])
    // Asked again with nothing changed (the zoo re-read, the switch's own refresh after pairing's): nothing more.
    w.brain.refresh(); w.brain.refresh()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.states()).toHaveLength(1)
    expect(w.f.fleet.start).toHaveBeenCalledTimes(1)
    // Another daemon paired, or the dial moved, while it thinks: said once each.
    w.setDaemon('ping')
    w.brain.refresh(); w.brain.refresh()
    w.setAutonomy('watch')
    w.brain.refresh(); w.brain.refresh()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.states().map((s) => [s.pair, s.autonomy])).toEqual([['tim', 'suggest'], ['ping', 'suggest'], ['ping', 'watch']])
  })

  it('the daemons switch going off tells every window the off result, once; idle, only a change is said', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    w.brain.clientAttached('local:hn')
    expect(w.states()).toHaveLength(1)
    // Daemons off takes pairing with it (the sensor unpairs), then the switch refreshes the brain again.
    w.setEnabled(false)
    w.brain.refresh()
    w.brain.refresh()
    expect(w.brain.isActive).toBe(false)
    expect(w.f.fleet.stop).toHaveBeenCalledTimes(1)
    expect(w.states()).toHaveLength(2)
    expect(w.states()[1]).toMatchObject({ pair: null, needs: [], working: 0, failing: [], machines: [], asks: [], acted: [] })
    // Idle: the switch coming back on with nothing paired says nothing new...
    w.brain.refresh()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.states()).toHaveLength(2)
    // ...a dial that moved is said, once.
    w.setAutonomy('watch')
    w.brain.refresh(); w.brain.refresh()
    expect(w.states()).toHaveLength(3)
    expect(w.states()[2]).toMatchObject({ pair: null, autonomy: 'watch' })
    // With no window attached nobody is told anything.
    w.brain.clientDetached('local:window')
    w.brain.clientDetached('local:hn')
    w.setEnabled(true)
    w.brain.refresh()
    expect(w.brain.isActive).toBe(false)
    expect(w.states()).toHaveLength(3)
    // The only frame of its own: the state to `hn`, which attached while it was thinking.
    expect(w.toClient.map((t) => t.connId)).toEqual(['local:hn'])
  })

  it('no duplicate: a window that attaches while it thinks is sent the state alone, the others nothing', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    expect(w.states()).toHaveLength(1)
    w.brain.clientAttached('local:hn')
    expect(w.states()).toHaveLength(1)
    expect(w.toClient.map((t) => [t.connId, t.frame.type])).toEqual([['local:hn', 'daemon_state']])
    w.brain.refresh()
    w.brain.clientDetached('local:hn')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.states()).toHaveLength(1)
    expect(w.toClient).toHaveLength(1)
    // The last window leaves and one comes back: the brain starts again, and that start is said to it —
    // even when the state is the very one said before it stopped.
    w.brain.clientDetached('local:window')
    expect(w.brain.isActive).toBe(false)
    w.brain.clientAttached('local:window')
    expect(w.states()).toHaveLength(2)
    expect(w.states()[1]).toEqual(w.states()[0])
  })

  it('while not thinking, fleet changes and state changes are ignored; an act answers PAIR_OFF', async () => {
    const w = world({ enabled: false })
    w.brain.clientAttached('local:window')
    w.change('machine-a', h('api', { question: q() }), entry('question', 'api', { requestId: 'q1' }))
    w.brain.stateChanged()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.says()).toEqual([])
    expect(w.states()).toEqual([])
    expect(await w.act({ requestId: 'r', id: 'need:x', choice: 'y' })).toEqual({ requestId: 'r', id: 'need:x', ok: false, error: 'PAIR_OFF' })
  })

  it('stateChanged while thinking sends the state (debounced, once for many)', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    const before = w.states().length
    w.brain.stateChanged(); w.brain.stateChanged(); w.brain.stateChanged()
    w.f.set('machine-a', h('api', { working: true }))
    await vi.advanceTimersByTimeAsync(200)
    expect(w.states().length).toBe(before + 1)
    expect(w.states().at(-1)).toMatchObject({ pair: 'tim', working: 1 })
  })

  it('with no autonomy dial it is watch: a line carries only [g]', async () => {
    const w = world({ noAutonomy: true })
    w.brain.clientAttached('local:window')
    const id = await asked(w)
    expect(w.says().find((s) => s.id === id)!.actions.map((a) => a.key)).toEqual(['g'])
    expect(w.brain.state().autonomy).toBe('watch')
  })
})

describe('the brain: what the fleet reports', () => {
  it('a harness that goes away takes its lines with it ("gone")', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    const id = await asked(w)
    w.change('machine-a', null, null, { removed: true }, 'api')
    expect(w.unsays()).toEqual([{ id, reason: 'gone' }])
  })

  it('a question entry that does not match the harness\'s open question says nothing; nor does one with no daemon', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    w.change('machine-a', h('api', { question: q({ requestId: 'q2' }) }), entry('question', 'api', { requestId: 'q1' }))
    w.change('machine-a', h('web'), entry('question', 'web', { requestId: 'q3' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(w.says()).toEqual([])
    w.setDaemon(null)
    w.change('machine-a', h('api', { question: q({ requestId: 'q4' }) }), entry('question', 'api', { requestId: 'q4' }))
    w.change('machine-a', h('api', { failing: 'boom' }), entry('fail', 'api', { text: 'boom' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(w.says()).toEqual([])
  })

  it('a turn finished on the pane being looked at is not counted; a recap for a turn it did not count is dropped', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    // Focus with no `active` said yet: taken as present and looking.
    w.brain.onPresence('local:window', { focusAgentId: 'api' })
    expect(w.brain.isFocused('machine-a', 'api')).toBe(true)
    expect(w.brain.isFocused('machine-b', 'api')).toBe(false)
    w.change('machine-a', h('api'), entry('done', 'api'))
    w.change('machine-a', h('web'), entry('recap', 'web', { text: 'did things' }))
    await vi.advanceTimersByTimeAsync(200)
    expect(w.brain.state().done).toEqual({ count: 0, last: [] })
    // An interrupted turn is not a finished one either.
    w.change('machine-a', h('web'), entry('done', 'web', { text: 'interrupted' }))
    await vi.advanceTimersByTimeAsync(200)
    expect(w.brain.state().done).toEqual({ count: 0, last: [] })
    // A focus on another machine names it; clearing the focus lets the next turn count.
    w.brain.onPresence('local:window', { focusAgentId: 'api', focusMachineId: 'machine-b' })
    expect(w.brain.isFocused('machine-b', 'api')).toBe(true)
    w.brain.onPresence('local:window', { focusAgentId: null })
    w.change('machine-a', h('api'), entry('done', 'api'))
    w.change('machine-a', h('api'), entry('recap', 'api', { text: '' }))
    await vi.advanceTimersByTimeAsync(200)
    expect(w.brain.state().done).toMatchObject({ count: 1, last: [{ agentId: 'api', recap: null }] })
  })

  it('an act another machine asked for is listed, not spoken; one by a key is neither', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    w.change('machine-b', h('web'), entry('act', 'web', { by: 'remote', action: 'answer', text: 'answered "Yes"' }))
    w.change('machine-a', h('api'), entry('act', 'api', { by: 'key', action: 'send', text: 'sent' }))
    w.change('machine-a', h('api'), entry('act', 'api', { by: 'rule' }))
    await vi.advanceTimersByTimeAsync(200)
    expect(w.brain.state().acted).toEqual([
      expect.objectContaining({ agentId: 'api', by: 'rule', action: '', text: '' }),
      expect.objectContaining({ machineId: 'machine-b', name: 'web@laptop', by: 'remote', action: 'answer', text: 'answered "Yes"' }),
    ])
    expect(w.says().map((s) => s.mood)).toEqual(['auto'])
    expect(w.says()[0]!.line).toContain('acted')
  })
})

describe('the brain: the gate', () => {
  const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({ id: 'confirm:autonomy:n1', kind: 'autonomy', nonce: 'n1', line: '[y/n] let tim act on key?',
    detail: 'act-on-key: …', actions: [{ key: 'y', label: 'confirm', choice: 'y' }, { key: 'n', label: 'keep', choice: 'n' }], at: 1, level: 'act-on-key', ...over })

  it('asked, changed and dropped are said whatever the limits; the state lists what waits and what was asked for', async () => {
    const requests: ConfirmRequest[] = [request()]
    const w = world({ gate: { requests: () => requests, requestedAutonomy: () => 'act-on-key', confirm: () => ({ ok: true, kind: 'autonomy' }) } })
    w.brain.clientAttached('local:window')
    const events: GateEvent[] = [
      { type: 'asked', request: request() },
      { type: 'changed', kind: 'autonomy', line: 'tim now acts on key.' },
      { type: 'dropped', request: request(), reason: 'declined' },
    ]
    for (const e of events) w.brain.onGate(e)
    expect(w.says().map((s) => [s.mood, s.from])).toEqual([['ask', 'daemon'], ['say', 'daemon']])
    expect(w.says()[0]).toMatchObject({ confirm: { kind: 'autonomy', nonce: 'n1' }, detail: 'act-on-key: …' })
    expect(w.unsays()).toEqual([{ id: 'confirm:autonomy:n1', reason: 'declined' }])
    expect(w.brain.state()).toMatchObject({ autonomy: 'suggest', autonomyRequested: 'act-on-key', confirms: [expect.objectContaining({ id: 'confirm:autonomy:n1', level: 'act-on-key' })] })
  })

  it('a gate change while idle reaches a window that is here, at once; with nobody here it goes nowhere', async () => {
    const w = world({ enabled: false, gate: { requests: () => [request({ level: undefined })], requestedAutonomy: () => 'suggest', confirm: () => ({ ok: true, kind: 'rules' }) } })
    w.brain.onGate({ type: 'changed', kind: 'rules', line: 'rules on.' })
    expect(w.states()).toEqual([])
    w.brain.clientAttached('local:window')
    w.brain.onGate({ type: 'changed', kind: 'rules', line: 'rules off.' })
    expect(w.states().at(-1)).toMatchObject({ pair: null, confirms: [expect.not.objectContaining({ level: expect.anything() })] })
    expect(w.states().at(-1)).not.toHaveProperty('autonomyRequested')
  })

  it('a confirm: only from a window, only with a gate, only once shown; a refusal keeps its detail', async () => {
    let result: { ok: true; kind: string } | { ok: false; error: string; detail?: string } = { ok: false, error: 'STALE', detail: 'asked again since' }
    const confirm = vi.fn((_kind: string, _nonce: string, _accept: boolean) => result)
    const w = world({ gate: { requests: () => [], requestedAutonomy: () => 'suggest', confirm } })
    const replies: Frame[] = []
    const send = (fr: Frame) => replies.push(fr.payload as Frame)
    w.brain.onConfirm('local:stranger', { requestId: 'r', kind: 'autonomy', nonce: 'n1' }, send)
    w.brain.clientAttached('local:window')
    w.brain.onConfirm('local:window', { requestId: 'r', kind: 'autonomy', nonce: 'n1' }, send)
    w.brain.onGate({ type: 'asked', request: request() })
    w.brain.onShown('local:window', { id: 'confirm:autonomy:n1' })
    await vi.advanceTimersByTimeAsync(ARM_MS)
    w.brain.onConfirm('local:window', { requestId: 'r', kind: 'autonomy', nonce: 'n1', accept: false }, send)
    result = { ok: false, error: 'NO_REQUEST' }
    w.brain.onConfirm('local:window', { requestId: 'r', kind: 'autonomy', nonce: 'n1' }, send)
    result = { ok: true, kind: 'autonomy' }
    w.brain.onConfirm('local:window', { requestId: 'r', kind: 'autonomy', nonce: 'n1' }, send)
    expect(replies.map((r) => [r.ok, r.error, r.detail, r.accepted])).toEqual([
      [false, 'UI_ONLY', undefined, undefined],
      [false, 'NOT_SHOWN', undefined, undefined],
      [false, 'STALE', 'asked again since', undefined],
      [false, 'NO_REQUEST', undefined, undefined],
      [true, undefined, undefined, true],
    ])
    expect(confirm.mock.calls.map((c) => c[2])).toEqual([false, true, true])

    const bare = world()
    bare.brain.clientAttached('local:window')
    const r2: Frame[] = []
    bare.brain.onConfirm('local:window', { requestId: 'r', kind: 'autonomy', nonce: 'n1' }, (fr) => r2.push(fr.payload as Frame))
    expect(r2).toEqual([{ requestId: 'r', kind: 'autonomy', nonce: 'n1', ok: false, error: 'UNSUPPORTED' }])

    // Without a shown-lines record nothing counts as shown.
    const blind = world({ noShown: true, gate: { requests: () => [], requestedAutonomy: () => 'suggest', confirm } })
    blind.brain.clientAttached('local:window')
    const r3: Frame[] = []
    blind.brain.onConfirm('local:window', { requestId: 'r', kind: 'autonomy', nonce: 'n1' }, (fr) => r3.push(fr.payload as Frame))
    expect(r3[0]).toMatchObject({ ok: false, error: 'NOT_SHOWN' })
  })
})

describe('the brain: talk', () => {
  it('empty words, no pair harness, a talk that fails (with or without a message): each a reply with the cost', async () => {
    let talk: ((text: string) => Promise<Frame>) | undefined
    const w = world({ talk: (text) => talk!(text) })
    w.brain.clientAttached('local:window')
    const replies: Frame[] = []
    const send = (fr: Frame) => replies.push(fr.payload as Frame)
    await w.brain.onTalk('local:window', { requestId: 'r1', text: '   ' }, send)
    talk = async () => { throw new Error('the pair harness would not start') }
    await w.brain.onTalk('local:window', { requestId: 'r2', text: 'hi' }, send)
    talk = async () => { throw 42 }
    await w.brain.onTalk('local:window', { requestId: 'r3', text: 'hi' }, send)
    talk = async (text) => ({ ok: true, heard: text })
    await w.brain.onTalk('local:window', { requestId: 'r4', text: '  hello tim  ' }, send)
    expect(replies).toEqual([
      { requestId: 'r1', ok: false, error: 'EMPTY', cost: TALK_COST_NOTE },
      { requestId: 'r2', ok: false, error: 'FAILED', detail: 'the pair harness would not start', cost: TALK_COST_NOTE },
      { requestId: 'r3', ok: false, error: 'FAILED', detail: undefined, cost: TALK_COST_NOTE },
      { requestId: 'r4', ok: true, heard: 'hello tim', cost: TALK_COST_NOTE },
    ])

    const none = world()
    none.brain.clientAttached('local:window')
    const r: Frame[] = []
    await none.brain.onTalk('local:window', { requestId: 'r', text: 'hi' }, (fr) => r.push(fr.payload as Frame))
    expect(r).toEqual([{ requestId: 'r', ok: false, error: 'UNSUPPORTED', cost: TALK_COST_NOTE }])
  })
})

describe('the brain: a key', () => {
  it('a line id nobody drew here, or with no shown-lines record, is NOT_SHOWN', async () => {
    const w = world({ noShown: true })
    w.brain.clientAttached('local:window')
    const replies: Frame[] = []
    await w.brain.onKey('local:window', { requestId: 'r', id: 'need:x', choice: 'y' }, (fr) => replies.push(fr.payload as Frame))
    expect(replies).toEqual([{ requestId: 'r', id: 'need:x', ok: false, error: 'NOT_SHOWN', detail: 'That line was never shown on this window (daemon_shown).' }])
    // A shown for a window that is not attached is not recorded.
    w.brain.onShown('local:stranger', { id: 'need:x' })
    w.brain.onShown('local:window', {})
  })

  it('a lesson key: no check configured is PERSON_ONLY; a check that throws is UNVERIFIED', async () => {
    const lessonLine = (w: ReturnType<typeof world>) => w.voice.say({ id: 'lesson:abc:nonce', about: { machineId: 'machine-a', agentId: '' }, mood: 'ask', from: 'daemon', line: '[y/n/s] teach "run tests"?',
      actions: [{ key: 'y', label: 'teach', choice: 'y' }], ttlMs: 60_000 })
    const open = world()
    open.brain.clientAttached('local:window')
    lessonLine(open)
    expect(await open.key({ requestId: 'r', id: 'lesson:abc:nonce', choice: 'y' })).toMatchObject({ ok: false, error: 'PERSON_ONLY' })
    const broken = world({ lessonKey: async () => { throw new Error('lsof missing') } })
    broken.brain.clientAttached('local:window')
    lessonLine(broken)
    expect(await broken.key({ requestId: 'r', id: 'lesson:abc:nonce', choice: 'y' })).toMatchObject({ ok: false, error: 'UNVERIFIED', detail: 'The daemon could not tell who pressed it.' })
  })

  it('a proposal\'s key: what it learned, skipped or shows rides back; a proposal that throws is a reply', async () => {
    let act: (id: string, choice: string) => Promise<Frame> = async () => ({ ok: true, learned: 'run tests', skipped: 'x', lesson: 'body', results: [{ ok: true }], detail: 'd' })
    const w = world({ proposals: { owns: (id) => id.startsWith('ask:'), act: (id, c) => act(id, c), pending: () => [] } })
    w.brain.clientAttached('local:window')
    expect(await w.act({ requestId: 'r', id: 'ask:1', choice: 'y' })).toEqual({ requestId: 'r', id: 'ask:1', ok: true, detail: 'd', results: [{ ok: true }], learned: 'run tests', skipped: 'x', lesson: 'body' })
    act = async () => { throw new Error(`proposal broke ${'x'.repeat(100)}`) }
    const failed = await w.act({ requestId: 'r', id: 'ask:2', choice: 'y' })
    expect(failed).toMatchObject({ ok: false })
    expect(String(failed.error)).toHaveLength(60)
    act = async () => { throw 'nope' }
    expect(await w.act({ requestId: 'r', id: 'ask:3', choice: 'y' })).toEqual({ requestId: 'r', id: 'ask:3', ok: false, error: 'FAILED' })
  })

  it('a key after the dial went to watch answers nothing', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    const id = await asked(w)
    w.setAutonomy('watch')
    expect(await w.key({ requestId: 'r', id, choice: 'y' })).toMatchObject({ ok: false, error: 'AUTONOMY_WATCH' })
    expect(w.answer).not.toHaveBeenCalled()
  })

  it('a key on a harness that is gone is stale, and the line is taken back', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    const id = await asked(w)
    w.f.set('machine-a', null, 'api')
    expect(await w.key({ requestId: 'r', id, choice: 'y' })).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(w.unsays()).toContainEqual({ id, reason: 'stale' })
    expect(w.answer).not.toHaveBeenCalled()
  })

  it('[y] on a question that turned deny-class (or stopped being allow-class) under the line is refused here', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    const id = await asked(w)
    w.f.set('machine-a', h('api', { question: q({ deny: true }) }))
    expect(await w.key({ requestId: 'r', id, choice: 'y' })).toMatchObject({ ok: false, error: 'DENY_CLASS' })
    w.f.set('machine-a', h('api', { question: q({ allow: false }) }))
    expect(await w.key({ requestId: 'r2', id, choice: '1. Yes' })).toMatchObject({ ok: false, error: 'DENY_CLASS' })
    expect(w.answer).not.toHaveBeenCalled()
  })

  it('another machine: [n] on a question no longer allow-class is not relayed', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    const id = await asked(w, 'machine-b', 'web')
    w.f.set('machine-b', h('web', { question: q({ allow: false }) }))
    expect(await w.key({ requestId: 'r', id, choice: 'n' })).toMatchObject({ ok: false, error: 'REMOTE_ANSWERS_ONLY' })
    expect(w.f.request).not.toHaveBeenCalled()
  })

  it('an answer that throws is a refusal with its message; a non-Error is FAILED; the line stays', async () => {
    let answer: () => Promise<AnswerResult> = async () => { throw new Error('tmux went away') }
    const w = world({ answer: () => answer() })
    w.brain.clientAttached('local:window')
    const id = await asked(w)
    expect(await w.key({ requestId: 'r', id, choice: 'y' })).toEqual({ requestId: 'r', id, ok: false, machineId: 'machine-a', error: 'tmux went away' })
    answer = async () => { throw 7 }
    expect(await w.key({ requestId: 'r2', id, choice: 'y' })).toMatchObject({ ok: false, error: 'FAILED' })
    answer = async () => ({ ok: false, error: 'BUSY', detail: 'typing' })
    expect(await w.key({ requestId: 'r3', id, choice: 'y' })).toMatchObject({ ok: false, error: 'BUSY', detail: 'typing' })
    expect(w.unsays()).toEqual([])
    expect(w.voice.get(id)).not.toBeNull()
  })

  it('a relayed key is journaled here with what came of it: refused with its error, or FAILED when there was none', async () => {
    const relayed = vi.fn()
    const w = world({ relayed })
    w.brain.clientAttached('local:window')
    const id = await asked(w, 'machine-b', 'web')
    w.f.request.mockResolvedValueOnce({ error: 'STALE_QUESTION', detail: 'moved on' })
    expect(await w.key({ requestId: 'r', id, choice: 'y' })).toEqual({ requestId: 'r', id, ok: false, machineId: 'machine-b', error: 'STALE_QUESTION', detail: 'moved on' })
    expect(w.unsays()).toEqual([{ id, reason: 'stale' }])
    expect(relayed).toHaveBeenLastCalledWith(expect.objectContaining({ target: 'machine-b', origin: 'local:window', text: 'relayed "1. Yes" to web@laptop: refused STALE_QUESTION' }))

    const id2 = await asked(w, 'machine-b', 'web', q({ requestId: 'q2' }))
    w.f.request.mockResolvedValueOnce({ ok: false })
    expect(await w.key({ requestId: 'r2', id: id2, choice: 'y' })).toEqual({ requestId: 'r2', id: id2, ok: false, machineId: 'machine-b' })
    expect(relayed).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'relayed "1. Yes" to web@laptop: refused FAILED' }))
    // Straight through onAct (no window): the origin is this daemon.
    const id3 = await asked(w, 'machine-b', 'web', q({ requestId: 'q3' }))
    w.f.request.mockResolvedValueOnce({ ok: true, error: 7 })
    expect(await w.act({ requestId: 'r3', id: id3, choice: 'y' })).toMatchObject({ ok: true })
    expect(relayed).toHaveBeenLastCalledWith(expect.objectContaining({ origin: 'this daemon', text: 'relayed "1. Yes" to web@laptop: answered' }))
  })

  it('a question from an older daemon (no dialog) carries no detail anywhere; its refusal may carry no detail', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    const id = await asked(w, 'machine-b', 'web', q({ dialog: undefined }))
    const say = w.says().find((s) => s.id === id)!
    expect(say).not.toHaveProperty('detail')
    await vi.advanceTimersByTimeAsync(200)
    const need = (w.states().at(-1)!.needs as Frame[])[0]!
    expect(need).toMatchObject({ agentId: 'web', requestId: 'q1', id })
    expect(need).not.toHaveProperty('detail')
    w.f.request.mockResolvedValueOnce({ error: 'BUSY' })
    expect(await w.key({ requestId: 'r', id, choice: 'y' })).toEqual({ requestId: 'r', id, ok: false, machineId: 'machine-b', error: 'BUSY' })
    // A failure with no reason is still said, naming the harness on its machine.
    await vi.advanceTimersByTimeAsync(UNSOLICITED_GAP_MS)
    w.change('machine-b', h('web', { failing: 'x' }), entry('fail', 'web', { text: undefined }))
    const fail = w.says().find((s) => s.mood === 'fail')
    expect(fail?.about).toEqual({ machineId: 'machine-b', agentId: 'web' })
  })

  it('a line that is not a question has nothing to answer: GONE', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    w.change('machine-a', h('api', { failing: 'boom' }), entry('fail', 'api', { text: 'boom' }))
    const fail = w.says().find((s) => s.mood === 'fail')!
    expect(fail.line.startsWith('[g] ')).toBe(true)
    expect(await w.act({ requestId: 'r', id: fail.id, choice: 'g' })).toMatchObject({ ok: false, error: 'GONE' })
  })
})

describe('the brain: a return', () => {
  it('no brief without a paired daemon, or once it stopped thinking while the journals were read', async () => {
    const w = world({ daemonId: null })
    w.brain.clientAttached('local:window')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    w.brain.onPresence('local:window', { active: false })
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    w.brain.onPresence('local:window', { active: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(w.f.fleet.journals).not.toHaveBeenCalled()

    const late = world()
    let release: (j: MachineJournal[]) => void = () => {}
    late.f.setJournals(() => new Promise((resolve) => { release = resolve }))
    late.brain.clientAttached('local:window')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    late.brain.onPresence('local:window', { active: false, desk: 'desk-1' })
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    late.brain.onPresence('local:window', { active: true, desk: 'desk-1' })
    expect(late.f.fleet.journals).toHaveBeenCalledTimes(1)
    late.setEnabled(false)
    late.brain.refresh()
    release([])
    await vi.advanceTimersByTimeAsync(10)
    expect(late.says().filter((s) => s.mood === 'back')).toEqual([])
  })

  it('a return with nothing to report says the back line and sends no brief', async () => {
    const w = world()
    w.brain.clientAttached('local:window')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    w.brain.onPresence('local:window', { active: false })
    // Going inactive twice keeps the first departure.
    await vi.advanceTimersByTimeAsync(60_000)
    w.brain.onPresence('local:window', { active: false })
    await vi.advanceTimersByTimeAsync(19 * 60_000)
    w.brain.onPresence('local:window', { active: true, awayMs: Number.POSITIVE_INFINITY })
    await vi.advanceTimersByTimeAsync(10)
    expect(w.says().map((s) => s.mood)).toEqual(['back'])
    expect(w.frames.filter((fr) => fr.type === 'daemon_brief')).toEqual([])
  })
})

describe('the brain: a guest window', () => {
  it('its pair, dial and consent count only from a window bound here; a non-string is null', () => {
    const pair = vi.fn()
    const autonomy = vi.fn()
    const consent = vi.fn()
    const w = world({ onGuestPair: pair, onGuestAutonomy: autonomy, onGuestConsent: consent })
    w.brain.onPresence('local:hn', { pair: 'ada', autonomy: 'suggest', consent: true }, { ui: false })
    expect([pair.mock.calls, autonomy.mock.calls, consent.mock.calls]).toEqual([[], [], []])
    w.brain.onPresence('local:window', { pair: 7, autonomy: null, consent: 'yes' })
    w.brain.onPresence('local:window', { pair: 'ada', autonomy: 'act-on-key', consent: true })
    expect(pair.mock.calls).toEqual([[null, undefined], ['ada', undefined]])
    expect(autonomy.mock.calls).toEqual([[null], ['act-on-key']])
    expect(consent.mock.calls).toEqual([[false], [true]])
  })

  it('a presence that says nothing about activity keeps what the window said before', () => {
    const w = world()
    w.brain.clientAttached('local:window')
    w.brain.onPresence('local:window', { active: false })
    expect(w.brain.present()).toBe(false)
    w.brain.onPresence('local:window', { focusAgentId: 'api' })
    expect(w.brain.present()).toBe(false)
    // Focus from an inactive window is not looking.
    expect(w.brain.isFocused('machine-a', 'api')).toBe(false)
    w.brain.onPresence('local:other', {})
    expect(w.brain.present()).toBe(false)
  })
})
