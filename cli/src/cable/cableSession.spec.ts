// The protocol, driven through a loopback port — no dial, no tmux, no network.
//
// What is worth testing here is not that JSON round-trips. It is the three rules the header names, each of
// which was paid for on real hardware and each of which is invisible until it is wrong:
//
//   · every `hello` is answered, but only an unfamiliar dial gets the whole state pushed again
//   · silence reopens the port, because a dead handle keeps accepting writes
//   · a voice turn with no agent named goes through the router before it goes anywhere
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { CableSession, type CableAgent, type CableHost, type CableMachine, type CablePort } from './cableSession.js'
import { DialLog } from './dialLog.js'

/** A port whose two ends are both in this process. */
class LoopbackPort implements CablePort {
  readonly path = '/dev/loopback'
  isOpen = true
  /** Everything the daemon wrote, decoded back into messages. */
  readonly sent: Array<Record<string, unknown>> = []
  /** The raw bytes of every frame written, so a test can assert the 8 KB cap holds. */
  readonly frames: Uint8Array[] = []
  closedWith: string | null = null

  private decoder = new CableDecoder()

  constructor(
    private readonly onData: (chunk: Buffer) => void,
    private readonly onClosed: (why: string) => void = () => {},
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    this.frames.push(bytes)
    this.decoder.feed(Buffer.from(bytes), (frame) => {
      if (frame.type === CableType.Json) {
        this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>)
      }
    })
  }

  async close(why = 'closed'): Promise<void> {
    if (!this.isOpen) return
    this.isOpen = false
    this.closedWith = why
    // SerialLink announces its own close; a fake that stays quiet makes "the dial went away" untestable.
    this.onClosed(why)
  }

  /** Speak as the dial. */
  say(msg: Record<string, unknown>): void {
    this.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg), 'utf8'))))
  }

  pcm(bytes: Buffer): void {
    this.onData(Buffer.from(encodeCableFrame(CableType.Pcm, bytes)))
  }

  /** A framed ESP_LOG line, as the dial sends while the daemon holds its only port. */
  logLine(text: string): void {
    this.onData(Buffer.from(encodeCableFrame(CableType.Log, Buffer.from(text, 'utf8'))))
  }

  /** Only the `t` of each message the daemon sent, in order. */
  types(): string[] {
    return this.sent.map((m) => m.t as string)
  }
}

const LOCAL_ROW: CableMachine = { id: 'mac-local', name: 'MacBook Pro', state: 'ready', local: true }

const AGENTS: CableAgent[] = [
  { id: 'a1', name: 'Fix login screen', engine: 'claude' },
  { id: 'a2', name: 'Device firmware voice', engine: 'codex' },
]

function makeHost(over: Partial<CableHost> = {}) {
  const host: CableHost = {
    localMachine: () => ({ id: 'mac-local', name: 'MacBook Pro' }),
    listMachines: async () => ({ machines: [LOCAL_ROW], source: 'backend' as const }),
    selectedMachine: () => 'mac-local',
    selectMachine: async () => ({ ok: true as const }),
    listSwarms: () => ({ selected: '', swarms: [], tiles: [] }),
    listUnread: () => [],
    selectSwarm: vi.fn(),
    appName: () => 'harness',
    voiceLang: () => 'en',
    listAgents: async () => AGENTS,
    agentTotal: () => AGENTS.length,
    activeSwarm: () => 't1',
    describe: (id) => { const a = AGENTS.find((x) => x.id === id); return a ? { name: a.name, engine: a.engine ?? '', machine: a.machine ?? '' } : undefined },
    sendTurn: vi.fn(),
    stopTurn: vi.fn(),
    scrolled: vi.fn(),
    answer: vi.fn(),
    focus: vi.fn(),
    openAgent: vi.fn(),
    forkAgent: async (id) => ({ ok: true as const, agentId: `${id}-fork` }),
    updateAgent: vi.fn(),
    listModels: async () => ['runtime-v1:s1:claude:opus@high', 'runtime-v1:s1:claude:sonnet@low'],
    recentSummaries: async () => [],
    transcribe: async () => 'fix the login screen',
    route: async () => ({ agentId: 'a1', confidence: 0.9, reason: 'name matched' }),
    log: () => {},
    ...over,
  }
  return host
}

/** Start a session on a loopback and hand back both ends. Never touches the real serial layer. */
/** A throwaway log directory per session, so no test reads another's lines. */
function tmpLog() { return new DialLog(mkdtempSync(join(tmpdir(), 'cable-'))) }

async function connect(host: CableHost = makeHost(), log = tmpLog()) {
  let port!: LoopbackPort
  const session = new CableSession(host, log, async (onData, onClosed) => {
    port = new LoopbackPort(onData, onClosed)
    return port
  })
  session.start()
  await vi.waitFor(() => expect(port).toBeDefined())
  return { session, port, host }
}

/** Let the microtask queue drain — every send is async. */
const settle = () => new Promise((r) => setTimeout(r, 0))

/** For a push that only the session's own tick sends: it ticks every second, and a change made just after a
 *  tick waits a whole one. vi.waitFor's default second raced that tick, and lost under load (a full unit run
 *  with 12 busy loops, load 93). Several ticks' room. */
const NEXT_TICKS = { timeout: 5_000 }

describe('cable session', () => {
  const companionSettings = {
    brightness: 40, character: 2, face: 466, muted: true, quiet: false,
    straightTitle: false, focusFace: false, scrollReversed: false, round: true,
    voiceLang: 'en', followCompanion: true, companion: null as string | null,
  }

  it('preserves dial settings and sends no automatic companion presentation', async () => {
    const { session, port } = await connect()
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', proto: 3, settings: companionSettings })
      await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
      await session.focusAgent('a1')
      await settle()
      expect(port.types().filter(type => type.startsWith('companion.'))).toEqual([])
      expect(port.types()).not.toContain('settings.set')
    } finally { await session.stop() }
  })

  it('recovers the selected terminal footer without a transcript start event and bounds captures', async () => {
    const activityText = vi.fn(async () => 'Coalescing...')
    const { session, port } = await connect(makeHost({ activityText }))
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
      await session.focusAgent('a1')
      port.sent.length = 0
      await session['refreshFocusedActivity']()
      expect(port.sent).toEqual([
        { t: 'turn.started', agentId: 'a1', text: 'Coalescing...' },
        { t: 'turn.activity', agentId: 'a1', text: 'Coalescing...' },
      ])
      await session['refreshFocusedActivity']()
      expect(activityText).toHaveBeenCalledTimes(1)
      // A different selected pane is checked immediately, without forwarding the old word.
      activityText.mockResolvedValueOnce('Working')
      await session.focusAgent('a2')
      await session['refreshFocusedActivity']()
      expect(port.sent.at(-1)).toEqual({ t: 'turn.activity', agentId: 'a2', text: 'Working' })
    } finally { await session.stop() }
  })

  it.each(['done', 'summary', 'error', 'focus', 'disconnect'])(
    'does not recover stale work if %s happens during a footer capture', async end => {
      let finish!: (text: string | null) => void
      const activityText = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve }))
      const { session, port } = await connect(makeHost({ activityText }))
      try {
        port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
        await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
        await session.focusAgent('a1')
        port.sent.length = 0
        const pending = session['refreshFocusedActivity'](); await settle()
        await session['refreshFocusedActivity']()
        expect(activityText).toHaveBeenCalledTimes(1)
        if (end === 'done') await session.turnDone('a1')
        else if (end === 'summary') await session.summary('a1', 'Completed.', 'Completed. All checks passed.')
        else if (end === 'error') await session.turnError('a1', 'Stopped')
        else if (end === 'focus') await session.focusAgent('a2')
        else await session.stop()
        finish('Coalescing...'); await pending
        expect(port.types()).not.toContain('turn.activity')
        expect(port.types()).not.toContain('turn.started')
        if (end === 'done' || end === 'summary' || end === 'error') {
          await session['refreshFocusedActivity']()
          expect(activityText).toHaveBeenCalledTimes(1)
        }
      } finally { await session.stop() }
    })

  it('does not read before connection or invent liveness when no native footer exists', async () => {
    const activityText = vi.fn(async () => null)
    const { session, port } = await connect(makeHost({ activityText }))
    try {
      await session.focusAgent('a1')
      await session['refreshFocusedActivity']()
      expect(activityText).not.toHaveBeenCalled()
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
      port.sent.length = 0
      await session['refreshFocusedActivity']()
      expect(port.sent).toEqual([{ t: 'turn.activity', agentId: 'a1', text: '' }])
    } finally { await session.stop() }
  })

  it('sends the exact terminal activity without delaying turn liveness', async () => {
    let finish!: (text: string | null) => void
    const { session, port } = await connect(makeHost({ activityText: () => new Promise(resolve => { finish = resolve }) }))
    try {
      const pending = session.turnStarted('a1', 'Processing'); await settle()
      expect(port.sent).toEqual([{ t: 'turn.started', agentId: 'a1', text: 'Processing' }])
      finish('Coalescing...'); await pending
      expect(port.sent.at(-1)).toEqual({ t: 'turn.activity', agentId: 'a1', text: 'Coalescing...' })
    } finally { await session.stop() }
  })

  it.each(['done', 'summary', 'error', 'disconnect'])(
    'drops a terminal activity read arriving after %s', async end => {
      let finish!: (text: string | null) => void
      const { session, port } = await connect(makeHost({ activityText: () => new Promise(resolve => { finish = resolve }) }))
      try {
        const pending = session.turnStarted('a1', 'Processing'); await settle()
        if (end === 'done') await session.turnDone('a1')
        else if (end === 'summary') await session.summary('a1', 'Done.', 'Done. All checks passed.')
        else if (end === 'error') await session.turnError('a1', 'Stopped')
        else await session.stop()
        finish('Coalescing...'); await pending
        expect(port.sent.some(message => message.t === 'turn.activity')).toBe(false)
      } finally { await session.stop() }
    })

  it('keeps a newer activity read and clears a disappeared footer without inventing a label', async () => {
    const finishes: Array<(text: string | null) => void> = []
    const { session, port } = await connect(makeHost({ activityText: () => new Promise(resolve => finishes.push(resolve)) }))
    try {
      const older = session.turnStarted('a1', 'Processing'); await settle()
      const newer = session.turnStarted('a1', 'Processing'); await settle()
      finishes[1]('Boogieing...'); await newer
      finishes[0]('Coalescing...'); await older
      expect(port.sent.filter(message => message.t === 'turn.activity').map(message => message.text)).toEqual(['Boogieing...'])
      const cleared = session.turnStarted('a1', 'Processing'); await settle()
      finishes[2](null); await cleared
      expect(port.sent.at(-1)).toEqual({ t: 'turn.activity', agentId: 'a1', text: '' })
    } finally { await session.stop() }
  })

  it('extends a live short recap from the supplied body', async () => {
    const { session, port } = await connect()
    try {
      await session.summary('a1', 'Yes.', 'Yes. The fix is installed.')
      expect(port.sent.at(-1)).toMatchObject({ t: 'summary', recap: 'Yes. The fix is installed.', text: 'Yes. The fix is installed.' })
    } finally { await session.stop() }
  })
  it('does not restore an old inbox after a newer empty snapshot', async () => {
    let finish!: (value: Array<{ recap: string; text: string }>) => void
    const history = new Promise<Array<{ recap: string; text: string }>>(resolve => { finish = resolve })
    const { session, port } = await connect(makeHost({ recentSummaries: () => history }))
    try {
      const older = session.replaceNotifications([{ agentId: 'a1', machineId: 'mac-local', question: false, text: '' }])
      await session.replaceNotifications([])
      finish([{ recap: 'Old result.', text: 'Old result.' }]); await older
      expect(port.sent).toEqual([{ t: 'notif.replace', items: [] }])
    } finally { await session.stop() }
  })

  it('keeps a completion seen during a slow restore cleared without losing other questions', async () => {
    let finish!: (value: Array<{ recap: string; text: string }>) => void
    const history = new Promise<Array<{ recap: string; text: string }>>(resolve => { finish = resolve })
    const { session, port } = await connect(makeHost({ recentSummaries: () => history }))
    try {
      const older = session.replaceNotifications([
        { agentId: 'a1', machineId: 'mac-local', question: false, text: '' },
        { agentId: 'a2', machineId: 'mac-local', question: true, text: 'Which branch?' },
      ])
      await session.agentSeen('a1')
      await session.agentSeen('a2')
      finish([{ recap: 'Old result.', text: 'Old result.' }]); await older
      expect(port.sent.at(-1)).toMatchObject({ t: 'notif.replace', items: [
        { agentId: 'a2', question: true, summary: 'Which branch?' },
      ] })
      // A later completion for the same agent is new news, not permanently suppressed.
      await session.replaceNotifications([{ agentId: 'a1', machineId: 'mac-local', question: false, text: 'New result.' }])
      expect(port.sent.at(-1)).toMatchObject({ t: 'notif.replace', items: [
        { agentId: 'a1', question: false, summary: 'New result.' },
      ] })
    } finally { await session.stop() }
  })

  it('carries read tokens through snapshots and accepts only bounded read receipts', async () => {
    const readNotification = vi.fn(), openAgent = vi.fn()
    const { session, port } = await connect(makeHost({ readNotification, openAgent }))
    try {
      await session.replaceNotifications([{ agentId: 'a1', machineId: 'mac-local', question: true, text: 'Which branch?', readToken: 'question-2' }])
      expect(port.sent.at(-1)).toMatchObject({ t: 'notif.replace', items: [{ readToken: 'question-2' }] })
      port.say({ t: 'notif.read', agentId: 'a1', readToken: 'question-2' })
      for (const readToken of ['', 42, null, 'a'.repeat(64), 'line\nbreak']) port.say({ t: 'notif.read', agentId: 'a1', readToken })
      await settle()
      expect(readNotification).toHaveBeenCalledExactlyOnceWith('a1', 'question-2')
      expect(openAgent).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it.each(['turn-1', 'turn-2'])('a late read of %s cannot clear a newer snapshot occurrence', async readToken => {
    let finish!: (value: Array<{ recap: string; text: string }>) => void
    const history = new Promise<Array<{ recap: string; text: string }>>(resolve => { finish = resolve })
    const { session, port } = await connect(makeHost({ recentSummaries: () => history }))
    try {
      const pending = session.replaceNotifications([{ agentId: 'a1', machineId: 'mac-local', question: false, text: '', readToken: 'turn-2' }])
      await session.agentSeen('a1', readToken)
      finish([{ recap: 'Same words.', text: 'Same words.' }]); await pending
      const items = port.sent.at(-1)!.items as unknown[]
      expect(items).toHaveLength(readToken === 'turn-2' ? 0 : 1)
    } finally { await session.stop() }
  })

  it('fetches the chosen agent question and submits its reviewed token once', async () => {
    const answerReviewed = vi.fn<NonNullable<CableHost['answerReviewed']>>(async () => ({ ok: true as const }))
    const { session, port } = await connect(makeHost({ answerReviewed }))
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      const questions = [{ key: 'scope', q: 'Which scope?', options: ['File', 'Project'], multi: false }]
      await session.question('a1', 'first', questions)
      await session.question('a2', 'second', questions)
      port.say({ t: 'question.read', agentId: 'a1', requestId: 'read-1' })
      await vi.waitFor(() => expect(port.types()).toContain('question.state'))
      const state = port.sent.find(m => m.t === 'question.state')!
      expect(state).toMatchObject({ ok: true, agentId: 'a1', id: 'first', requestId: 'read-1' })
      const submit = { t: 'answer.reviewed', agentId: 'a1', requestId: 'send-1', token: state.token, choices: [2] }
      port.say(submit); port.say(submit)
      await vi.waitFor(() => expect(port.types().filter(t => t === 'answer.receipt')).toHaveLength(2))
      expect(answerReviewed).toHaveBeenCalledTimes(1)
      expect(answerReviewed.mock.calls[0][0]).toMatchObject({ agentId: 'a1', requestId: 'first', answers: { scope: 'Project' } })
      await session.questionClose('a1', 'first')
      port.say(submit); await settle()
      expect(answerReviewed).toHaveBeenCalledTimes(1)
    } finally { await session.stop() }
  })

  it('carries exact text to another explicit recipient, and consumes it only when sending', async () => {
    const selectPassage = vi.fn<NonNullable<CableHost['selectPassage']>>(async command => command.op === 'pin'
      ? { ok: true, selectionId: 'pick-1', revision: 4, rows: 2, extending: true,
          excerpt: 'source output', text: '  source line\nsecond line' }
      : { ok: false, error: 'Closed' })
    const host = makeHost({ selectPassage, transcribe: vi.fn(async () => 'Compare this with your plan.'), route: vi.fn(),
      appFocus: () => ({ machineId: 'mac-local', agentId: 'a1' }) })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      port.say({ t: 'carry.prepare', carryId: 'carry-1', requestId: 'carry-request', agentId: 'a1', selectionId: 'pick-1', revision: 3 })
      await vi.waitFor(() => expect(port.types()).toContain('carry.state'))
      expect(port.sent.find(x => x.t === 'carry.state')).toMatchObject({ active: true, carryId: 'carry-1', rows: 2 })
      expect(port.sent.find(x => x.t === 'carry.state')).not.toHaveProperty('text')
      expect(host.sendTurn).not.toHaveBeenCalled()
      port.say({ t: 'voice.begin', uploadId: 'carried', agentId: 'a2', carryId: 'carry-1' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalledOnce())
      const sent = vi.mocked(host.sendTurn).mock.calls[0]!
      expect(sent[0]).toBe('a2')
      expect(sent[1]).toContain('Compare this with your plan.\n\nContext I selected from harness ')
      expect(sent[1]).toContain('>   source line\n> second line')
      expect(host.route).not.toHaveBeenCalled()
      expect(port.sent.find(x => x.t === 'voice.transcript')).toMatchObject({ carryId: 'carry-1', agentId: 'a2' })
      port.say({ t: 'voice.begin', uploadId: 'duplicate', agentId: 'a2', carryId: 'carry-1' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.sent.some(x => x.t === 'voice.error' && x.uploadId === 'duplicate')).toBe(true))
      expect(host.sendTurn).toHaveBeenCalledOnce()
    } finally { await session.stop() }
  })

  it.each([{}, { carryId: null }, { carryId: 'expired', agentId: 'a2' },
    { carryId: 'expired', formId: 'f', formRevision: 1 }, { carryId: 'expired', agentId: 'a2', selectionId: 'pick' }])(
    'invalid carried voice never falls back to bare words or inferred routing: %j', async fields => {
      const host = makeHost({ transcribe: vi.fn(), route: vi.fn(), routeInWindow: vi.fn() })
      const { session, port } = await connect(host)
      try {
        port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
        port.say({ t: 'voice.begin', uploadId: 'invalid-carry', carryId: 'missing', ...fields })
        port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
        await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
        expect(host.transcribe).not.toHaveBeenCalled()
        expect(host.sendTurn).not.toHaveBeenCalled()
        expect(host.route).not.toHaveBeenCalled()
        expect(host.routeInWindow).not.toHaveBeenCalled()
      } finally { await session.stop() }
    })

  it('dropping carried text during transcription prevents later delivery', async () => {
    let finish!: (s: string) => void
    const host = makeHost({
      selectPassage: async command => command.op === 'pin'
        ? { ok: true, selectionId: 'p', revision: 2, rows: 1, extending: false, excerpt: 'source', text: 'source' }
        : { ok: false, error: 'Closed' },
      transcribe: vi.fn(() => new Promise<string>(resolve => { finish = resolve })),
    })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      port.say({ t: 'carry.prepare', carryId: 'carry-drop', requestId: 'r', agentId: 'a1', selectionId: 'p', revision: 1 })
      await vi.waitFor(() => expect(port.types()).toContain('carry.state'))
      port.say({ t: 'voice.begin', uploadId: 'drop', agentId: 'a2', carryId: 'carry-drop' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(host.transcribe).toHaveBeenCalledOnce())
      port.say({ t: 'carry.cancel', carryId: 'carry-drop' }); await settle()
      finish('Explain this'); await settle()
      expect(host.sendTurn).not.toHaveBeenCalled()
      expect(port.types()).not.toContain('voice.transcript')
    } finally { await session.stop() }
  })

  it('a refused recipient keeps the passage for an explicit retry', async () => {
    const host = makeHost({
      selectPassage: async command => command.op === 'pin'
        ? { ok: true, selectionId: 'p', revision: 2, rows: 1, extending: false, excerpt: 'source', text: 'source' }
        : { ok: false, error: 'Closed' },
      sendTurn: vi.fn().mockReturnValueOnce({ ok: false, reason: 'offline' }).mockReturnValue({ ok: true }),
    })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      port.say({ t: 'carry.prepare', carryId: 'carry-retry', requestId: 'r', agentId: 'a1', selectionId: 'p', revision: 1 })
      await vi.waitFor(() => expect(port.types()).toContain('carry.state'))
      port.say({ t: 'voice.begin', uploadId: 'refused', agentId: 'a2', carryId: 'carry-retry' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
      expect(port.types()).not.toContain('voice.transcript')
      expect(host.sendTurn).toHaveBeenCalledOnce()
      port.say({ t: 'voice.begin', uploadId: 'retry', agentId: 'a2', carryId: 'carry-retry' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.types()).toContain('voice.transcript'))
      expect(host.sendTurn).toHaveBeenCalledTimes(2)
      expect(vi.mocked(host.sendTurn).mock.calls[1]![1]).toContain('> source')
    } finally { await session.stop() }
  })

  it('routes form choices without terminal input and acknowledges the exact device request', async () => {
    const form = vi.fn<NonNullable<CableHost['form']>>(async () => ({
      ok: true, active: true, revision: 2, label: 'Codex', position: 1, total: 3, busy: false, enabled: true }))
    const host = makeHost({ form }), { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      port.say({ t: 'form', op: 'move', formId: 'form-one', requestId: 'form-2', revision: 1, delta: 1 })
      await vi.waitFor(() => expect(port.sent.some(x => x.t === 'form.state')).toBe(true))
      expect(form).toHaveBeenCalledExactlyOnceWith({ op: 'move', formId: 'form-one', revision: 1, delta: 1 })
      expect(port.sent.find(x => x.t === 'form.state')).toMatchObject({ requestId: 'form-2', formId: 'form-one', label: 'Codex' })
      expect(host.openAgent).not.toHaveBeenCalled()
      expect(host.sendTurn).not.toHaveBeenCalled()
      expect(host.answer).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it('visits and returns with correlated acknowledgements and no terminal actions', async () => {
    const visit = vi.fn<NonNullable<CableHost['visit']>>(async command => ({
      ok: true, active: command.op === 'open', agentId: command.op === 'open' ? 'a2' : 'a1', label: 'My work' }))
    const host = makeHost({ visit })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      port.say({ t: 'visit', op: 'open', visitId: 'visit-one', requestId: 'open-one', agentId: 'a2' })
      await vi.waitFor(() => expect(port.sent.some(x => x.t === 'visit.state')).toBe(true))
      expect(port.sent.find(x => x.t === 'visit.state')).toMatchObject({ requestId: 'open-one', visitId: 'visit-one', active: true, agentId: 'a2' })
      port.say({ t: 'visit', op: 'back', visitId: 'visit-one', requestId: 'back-one' }); await settle()
      expect(port.sent.find(x => x.requestId === 'back-one')).toMatchObject({ active: false, agentId: 'a1' })
      expect(host.openAgent).not.toHaveBeenCalled()
      expect(host.sendTurn).not.toHaveBeenCalled()
      expect(host.answer).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it('latest-output requests use the visit receipt and never become agent input', async () => {
    const visit = vi.fn<NonNullable<CableHost['visit']>>(async () => ({
      ok: true, active: true, agentId: 'a1', label: 'Your reading' }))
    const host = makeHost({ visit })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      port.say({ t: 'visit', op: 'latest', visitId: 'visit-reading', requestId: 'reading-1', agentId: 'a1' })
      await vi.waitFor(() => expect(port.sent.some(x => x.t === 'visit.state')).toBe(true))
      expect(visit).toHaveBeenCalledExactlyOnceWith({ op: 'latest', visitId: 'visit-reading', agentId: 'a1' })
      expect(port.sent.find(x => x.t === 'visit.state')).toMatchObject({
        requestId: 'reading-1', visitId: 'visit-reading', active: true, agentId: 'a1' })
      expect(host.openAgent).not.toHaveBeenCalled()
      expect(host.sendTurn).not.toHaveBeenCalled()
      expect(host.answer).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it('pins selected terminal text at voice start and sends it with the spoken instruction', async () => {
    const selectPassage = vi.fn<CableHost['selectPassage'] & {}>(async command => command.op === 'pin'
      ? { ok: true, selectionId: 'selection-1', revision: 4, rows: 2, extending: true,
          excerpt: 'quoted output', text: '  first line\nsecond line' }
      : { ok: false, error: 'Selection closed.' })
    const host = makeHost({ selectPassage, transcribe: vi.fn(async () => 'Explain this.'),
      appFocus: () => ({ machineId: 'mac-local', agentId: 'a1' }) })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await settle()
      port.say({ t: 'voice.begin', uploadId: 'quoted', agentId: 'a2', selectionId: 'selection-1', selectionRevision: 3 })
      await settle()
      expect(selectPassage).toHaveBeenCalledWith({ op: 'pin', agentId: 'a2', selectionId: 'selection-1', revision: 3 })
      port.pcm(Buffer.alloc(3200))
      port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalledOnce())
      expect(host.sendTurn).toHaveBeenCalledWith('a2', 'Explain this.\n\nContext I selected from this agent\'s terminal:\n>   first line\n> second line')
      expect(port.sent.find(x => x.t === 'voice.transcript')).toMatchObject({ text: 'Explain this.', uploadId: 'quoted' })
    } finally { await session.stop() }
  })

  it('refuses quoted voice when the selected text changed, without submitting bare words', async () => {
    const host = makeHost({ selectPassage: vi.fn(async () => ({ ok: false as const, error: 'That text changed. Choose it again.' })),
      transcribe: vi.fn(async () => 'explain this') })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await settle()
      port.say({ t: 'voice.begin', uploadId: 'changed', agentId: 'a2', selectionId: 'old', selectionRevision: 1 })
      port.pcm(Buffer.alloc(3200))
      port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
      expect(host.sendTurn).not.toHaveBeenCalled()
      expect(host.transcribe).not.toHaveBeenCalled()
      expect(port.sent.find(x => x.t === 'voice.error')).toMatchObject({ uploadId: 'changed', message: 'That text changed. Choose it again.' })
    } finally { await session.stop() }
  })

  it('discard during a pending text pin cannot send or revive the recording', async () => {
    let pin!: (result: import('./windowSelection.js').SelectionResult) => void
    const host = makeHost({ selectPassage: command => command.op === 'pin'
      ? new Promise(resolve => { pin = resolve }) : Promise.resolve({ ok: false, error: 'Closed' }),
      transcribe: vi.fn(async () => 'explain') })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await settle()
      port.say({ t: 'voice.begin', uploadId: 'cancelled-quote', agentId: 'a1', selectionId: 'selected', selectionRevision: 1 })
      port.pcm(Buffer.alloc(3200))
      port.say({ t: 'voice.end' })
      await settle()
      port.say({ t: 'voice.abort', uploadId: 'cancelled-quote' })
      pin({ ok: true, selectionId: 'selected', revision: 2, rows: 1, excerpt: 'a', extending: false, text: 'a' })
      await settle()
      expect(host.sendTurn).not.toHaveBeenCalled()
      expect(host.transcribe).not.toHaveBeenCalled()
      expect(port.types()).not.toContain('voice.transcript')
    } finally { await session.stop() }
  })

  it('answers hello with welcome and pushes the agent list once', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', fw: '0.1.0', proto: 1, mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))

    expect(port.types()).toEqual(
      // Machines FIRST: the dial paints its machine name from this list, so an agent list that lands
      // ahead of it shows a nameless placeholder for a frame. Swarms next, for the same reason: the line
      // naming the tab is drawn on the tile the agent list is about to build.
      //
      // `notif.replace` LAST, and that order is the point too: it names agents, and a drawer row for one
      // the carousel does not hold yet has nothing to draw itself against. A dial that has just greeted
      // us is the one moment its drawer is known to be empty — its rows live in RAM.
      ['welcome', 'machines.begin', 'machine', 'machines.end', 'swarms', 'agents.begin', 'agent', 'agent', 'agents.end', 'notif.replace'],
    )
    const welcome = port.sent[0]
    expect(welcome).toMatchObject({ t: 'welcome', app: 'harness', machine: { name: 'MacBook Pro' } })
    // Streamed one per message: a hundred agents do not fit in one 8 KB frame, and the dial must not have
    // to reassemble anything.
    expect(port.sent.find((m) => m.t === 'agent')).toMatchObject({ t: 'agent', id: 'a1', name: 'Fix login screen', engine: 'claude' })
    await session.stop()
  })

  it('advertises only the optional device controls this host implements', async () => {
    const core = await connect()
    core.port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(core.port.types()).toContain('welcome'))
    expect(core.port.sent[0].features).toEqual(['voice.draft', 'agents.refresh', 'settings'])
    await core.session.stop()

    const advanced = await connect(makeHost({
      form: async () => ({ ok: false, active: false, error: 'test' }),
      visit: async () => ({ ok: false, active: false, error: 'test' }),
      selectPassage: async () => ({ ok: false, error: 'test' }),
      answerReviewed: async () => ({ ok: false, error: 'test' }),
    }))
    advanced.port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(advanced.port.types()).toContain('welcome'))
    expect(advanced.port.sent[0].features).toEqual(['voice.draft', 'agents.refresh', 'form', 'selection', 'visit', 'question.review', 'settings'])
    await advanced.session.stop()
  })

  it('carries the device settings both ways, and lets a refusal correct the window', async () => {
    /*
     * The device owns these. This computer proposes, and what comes back is what the device HOLDS —
     * read back from its own NVS, not echoed from the request. That is what makes a refusal
     * self-correcting: a window that asked for a character this image does not have is told the real
     * one rather than left showing its own optimism.
     */
    const seen: unknown[] = []
    const lines: string[] = []
    const { session, port } = await connect(makeHost({ onDialStatus: (s) => seen.push(s), log: (l) => lines.push(l) }))
    const settings = {
      brightness: 80, character: 0, face: 466, muted: false, quiet: false, straightTitle: false,
      focusFace: false, scrollReversed: false, round: true, voiceLang: 'vi',
    }
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '0.0.90', proto: 3, settings })
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ attached: true, settings }))

    // Only the named field crosses. Two windows open on one device must not overwrite each other with
    // whatever each of them last saw.
    await session.setSettings({ character: 9 })
    expect(port.sent.at(-1)).toEqual({ t: 'settings.set', character: 9 })
    await session.setSettings({})
    expect(port.sent.at(-1)).toEqual({ t: 'settings.set', character: 9 })   // nothing to say, nothing sent

    port.say({ t: 'settings.state', ok: false, error: 'This device has no such character.', settings })
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ settings }))
    expect(lines.some((l) => l.includes('refused a settings change: This device has no such character.'))).toBe(true)

    // A change made on the glass arrives unprompted and moves the pane.
    const quieter = { ...settings, quiet: true, brightness: 20 }
    port.say({ t: 'settings.state', ok: true, settings: quieter })
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ settings: quieter }))

    // Half an object is refused whole: a default here is a value this computer invented, and the pane
    // would then show a setting the device does not have.
    port.say({ t: 'settings.state', ok: true, settings: { brightness: 50 } })
    await settle()
    expect(seen.at(-1)).toMatchObject({ settings: quieter })
    await session.stop()
  })

  it('answers a repeat hello WITHOUT re-pushing the list', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    // The dial greets every 15 s for as long as it is plugged in. Re-attaching on each of those re-sends
    // the whole state four times a minute and undoes the "say nothing when nothing changed" rule.
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    expect(port.types()).toEqual(['welcome'])
    await session.stop()
  })

  it('tells the host the dial is there, on which firmware, and when it leaves — never on a keepalive', async () => {
    // What a window draws in its rail. Attach and detach are the two facts; a repeat greeting is
    // neither, and a rail that redraws four times a minute to say "still here" is noise.
    const seen: unknown[] = []
    const { session, port } = await connect(makeHost({ onDialStatus: (status) => seen.push(status) }))
    port.say({ t: 'hello', product: 'harness', fw: '0.0.58', proto: 1, mac: 'aa:bb' })
    await vi.waitFor(() => expect(seen).toEqual([{ attached: true, fw: '0.0.58', mac: 'aa:bb' }]))

    port.say({ t: 'hello', product: 'harness', fw: '0.0.58', proto: 1, mac: 'aa:bb' })
    await settle()
    expect(seen).toHaveLength(1)

    // Unplugged still says WHICH device left. A desk can hold two, and the settings pane has to know
    // whose rows to show read-only rather than dropping a robot off the list.
    await port.close('unplugged')
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ attached: false, mac: 'aa:bb' }))
    await session.stop()
  })

  it('re-attaches for a DIFFERENT dial', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'hello', product: 'harness', mac: 'cc:dd' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.types()).toEqual(
      // Machines FIRST: the dial paints its machine name from this list, so an agent list that lands
      // ahead of it shows a nameless placeholder for a frame. Swarms next, for the same reason: the line
      // naming the tab is drawn on the tile the agent list is about to build.
      //
      // `notif.replace` LAST, and that order is the point too: it names agents, and a drawer row for one
      // the carousel does not hold yet has nothing to draw itself against. A dial that has just greeted
      // us is the one moment its drawer is known to be empty — its rows live in RAM.
      ['welcome', 'machines.begin', 'machine', 'machines.end', 'swarms', 'agents.begin', 'agent', 'agent', 'agents.end', 'notif.replace'],
    )
    await session.stop()
  })

  it('names the swarms once and again only when they change, and relays a pick', async () => {
    let swarms = { selected: 's1', swarms: [{ id: 's1', name: 'Workshop', agents: 2, panes: 2 }, { id: 's2', name: 'Launch', agents: 0, panes: 0 }], tiles: [] }
    const host = makeHost({ listSwarms: () => swarms })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.sent.filter((m) => m.t === 'swarms')).toEqual([
      { t: 'swarms', selected: 's1', items: [{ id: 's1', name: 'Workshop', agents: 2, panes: 2 }, { id: 's2', name: 'Launch', agents: 0, panes: 0 }], tiles: [] },
    ])

    // Ticks with nothing new say nothing new — the same rule as the wheel.
    await settle()
    expect(port.sent.filter((m) => m.t === 'swarms')).toHaveLength(1)

    // The dial picks. The host is told and nothing is answered on the wire: the window's new desk is
    // the answer, and it arrives as the next swarms/ring push.
    port.say({ t: 'swarm.select', swarmId: 's2' })
    await settle()
    expect(host.selectSwarm).toHaveBeenCalledWith('s2')
    swarms = { ...swarms, selected: 's2' }
    await vi.waitFor(() => expect(port.sent.filter((m) => m.t === 'swarms')).toHaveLength(2), NEXT_TICKS)
    expect(port.sent.filter((m) => m.t === 'swarms')[1]).toMatchObject({ selected: 's2' })
    await session.stop()
  })

  it('pushes again when a tab gains a tile but no agent', async () => {
    // The change this field exists for: a terminal opened on a tab that holds no agent moves the
    // TILE count and nothing else. A diff watching only `agents` swallowed that push and left the
    // dial showing a row it still believed was empty — the row it would then refuse to list.
    let swarms = { selected: 's1', swarms: [{ id: 's1', name: 'Shell', agents: 0, panes: 0 }], tiles: [] }
    const host = makeHost({ listSwarms: () => swarms })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.sent.filter((m) => m.t === 'swarms')).toHaveLength(1))

    swarms = { selected: 's1', swarms: [{ id: 's1', name: 'Shell', agents: 0, panes: 1 }], tiles: [] }
    await vi.waitFor(() => expect(port.sent.filter((m) => m.t === 'swarms')).toHaveLength(2), NEXT_TICKS)
    expect(port.sent.filter((m) => m.t === 'swarms')[1]).toMatchObject({
      items: [{ id: 's1', agents: 0, panes: 1 }],
    })
    await session.stop()
  })

  it('delivers a turn through the host, not through the protocol', async () => {
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'turn.send', agentId: 'a2', text: 'flash it' })
    await settle()
    expect(host.sendTurn).toHaveBeenCalledWith('a2', 'flash it')
    await session.stop()
  })

  it('says so when the port is another product\'s, or never speaks at all, and never of a real dial', async () => {
    // Told to whoever owns discovery, so a second ESP32 on the desk stops being opened every minute.
    // A port that has been a dial is never reported: a hung or rebooting dial goes quiet and comes back.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    try {
      const reports: Array<[string, string]> = []
      const host = makeHost({ onForeignPort: (path, why) => { reports.push([path, why]) } })

      // 1. Another product's greeting.
      const other = await connect(host)
      other.port.say({ t: 'hello', product: 'grid', fw: '0.1.2', proto: 1, mac: 'aa:bb' })
      await settle()
      expect(reports).toEqual([['/dev/loopback', "greeted as 'grid'"]])
      await other.session.stop()

      // 2. A port that never says anything.
      reports.length = 0
      const quiet = await connect(host)
      await settle()
      for (let sec = 0; sec < 25; sec++) { vi.advanceTimersByTime(1_000); await settle() }
      expect(reports).toEqual([['/dev/loopback', 'silent']])
      await quiet.session.stop()

      // 3. A real dial that then goes quiet is not written off.
      reports.length = 0
      const dial = await connect(host)
      dial.port.say({ t: 'hello', product: 'harness', fw: '0.1.0', proto: 1, mac: 'aa:bb' })
      await settle()
      for (let sec = 0; sec < 25; sec++) { vi.advanceTimersByTime(1_000); await settle() }
      expect(reports).toEqual([])
      await dial.session.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses a dial that names another product, and lets go of its port", async () => {
    // The framing magic should already have made this greeting unreadable — reaching here means something
    // this code cannot see has changed (a re-unified magic, a fork of the firmware, a third product). The
    // safe reading of "I do not recognise you" is never "you are probably mine".
    const host = makeHost()
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'grid', fw: '0.1.2', proto: 1, mac: 'aa:bb' })
    await settle()

    // No welcome: a welcome is what starts a session, and there is no session to have with someone
    // else's dial. And the port is released, because two daemons reading one tty take turns stealing
    // each other's bytes — a stalemate that breaks BOTH links, not just this one.
    expect(port.types()).not.toContain('welcome')
    expect(port.closedWith).toBe('another product')
    await session.stop()
  })

  it('refuses a greeting that names no product at all', async () => {
    // Absence has to mean no. Reading it as "probably ours" puts the hole straight back: the firmware
    // that predates this field is exactly the firmware the sibling product can still capture.
    const host = makeHost()
    const { session, port } = await connect(host)

    port.say({ t: 'hello', fw: '0.0.39', proto: 2, mac: 'aa:bb' })
    await settle()

    expect(port.types()).not.toContain('welcome')
    await session.stop()
  })

  it('writes a given image to a given dial once, however many sessions it takes', async () => {
    // `offered` is per SESSION and every flash ends in a reboot that starts a new one, so it cannot see a
    // loop. Two daemons disagreeing about who owns a board flash it every fifteen seconds — 3 MB a time,
    // ~700 MB an hour — and the dial pays in erase cycles. This is the memory that outlives the port.
    const image = Buffer.alloc(2048, 9)
    const host = makeHost({
      firmwareFor: async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }),
    })
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' })
    await settle()
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)

    // A new session for the same dial — what a reboot looks like from here.
    port.sent.length = 0
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' })
    await settle()
    expect(port.types()).not.toContain('fw.offer')
    await session.stop()
  })

  it('offers the image to a SECOND dial, even after a first one took it', async () => {
    // Found in the field: one dial updated, was unplugged, and a second still on the old image was plugged
    // into the same daemon and never offered anything. `offered` held bare version strings, so it was a
    // statement about the IMAGE rather than about the board — the second dial was refused because that
    // version had been offered to someone else, and nothing in the log said so.
    const image = Buffer.alloc(2048, 9)
    const host = makeHost({
      firmwareFor: async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }),
    })
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' })
    await settle()
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)

    // The first dial takes it and reboots. Without this the transfer is still in flight and the guard
    // that refuses a SECOND concurrent offer would be what answers below — a different rule, and the
    // wrong one to be testing here.
    port.say({ t: 'fw.done' })
    await settle()

    // A different board, same daemon, same port — the port does not close when a dial reboots, which is
    // why the session's memory of what it has offered outlives the dial it offered to.
    port.sent.length = 0
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'cc:dd' })
    await settle()
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)
    await session.stop()
  })

  it('does not wedge forever when opening the port hangs', async () => {
    // The `opening` guard keeps two opens from racing on one tty — a race that once left five read loops
    // shredding a single byte stream. But a guard released only when the attempt FINISHES is a guard held
    // forever by an attempt that never does, and the dial is then gone until the daemon is restarted:
    // no error, no retry, no line in the log saying why. Seen once in the field — the link closed and
    // nothing tried again for twelve minutes, after the dial re-enumerated mid-flash.
    vi.useFakeTimers()
    try {
      let attempts = 0
      const session = new CableSession(makeHost(), tmpLog(), async (onData, onClosed) => {
        attempts += 1
        if (attempts === 1) return new Promise<never>(() => {})   // the hang
        return new LoopbackPort(onData, onClosed)
      })
      session.start()
      // Comfortably past OPEN_TIMEOUT_MS plus the reopen tick. It used to advance exactly 20s, which was
      // fine while the budget was 8s and became a coin toss the moment the budget itself became 20 —
      // the retry lands after the deadline, not on it.
      await vi.advanceTimersByTimeAsync(35_000)

      expect(attempts).toBeGreaterThan(1)
      await session.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('brings the dial to the agent the window opened', async () => {
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    await session.followApp('', 'a2')
    await settle()

    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a2'])
    await session.stop()
  })

  it('pushes the ring BEFORE the focus that needs it', async () => {
    // Reported from the desk: clicking a rail agent that has NO tile yet moves the window and leaves the
    // dial where it was — often, not always.
    //
    // A focus names a tile the dial has to centre, and the dial centres only what its ring WALKS; an
    // agent with no tile can be sitting off that ring entirely, where the device drops the focus with
    // nothing to move to. The click is what changes the ring — it opens a tile — so the list and the
    // focus are one transaction, and the list has to go first.
    let agents: CableAgent[] = [{ id: 'a1', name: 'one' }, { id: 'a2', name: 'two' }]
    const { session, port } = await connect(makeHost({ listAgents: async () => agents }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    agents = [{ id: 'a2', name: 'two' }, { id: 'a1', name: 'one' }]   // the click re-shaped the desk
    await session.followApp('', 'a2')
    await settle()

    const order = port.types().filter((t) => t === 'agents.end' || t === 'focus')
    expect(order[0]).toBe('agents.end')                      // the ring the focus lands on, first
    expect(order).toContain('focus')
    expect(port.sent.filter((m) => m.t === 'focus').every((m) => m.agentId === 'a2')).toBe(true)
    await session.stop()
  })

  it('hands an open to the host with why the dial sent it — a tap says nothing, a question says so', async () => {
    // A question screen that came up on its own opens with reason 'question'; the window then only brings
    // the agent forward. A tap carries no reason, and so does anything the daemon does not know.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'agent.open', agentId: 'a2' })
    port.say({ t: 'agent.open', agentId: 'a2', reason: 'question' })
    port.say({ t: 'agent.open', agentId: 'a2', reason: 'whim' })
    await settle()

    expect(vi.mocked(host.openAgent).mock.calls).toEqual([['a2', undefined], ['a2', 'question'], ['a2', undefined]])
    await session.stop()
  })

  it("never echoes the dial's own move back at it", async () => {
    // THE RING: the dial's carousel reports `focus` up, the daemon hands that to the window, the window
    // opens that agent's terminal, and a window opening a terminal is exactly what calls followApp. Left
    // unguarded that answers the dial with the move it just made. It settles today only because the far
    // end does not re-report a carousel that never moved — a property of its UI, not of this protocol.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'focus', agentId: 'a2' })   // the dial moved itself
    await settle()
    port.sent.length = 0

    await session.followApp('', 'a2')          // the window caught up
    await settle()

    expect(port.sent.filter((m) => m.t === 'focus')).toEqual([])
    await session.stop()
  })

  it('says again where the window is looking after the list is re-sorted', async () => {
    // The gap left by making re-anchors silent: the dial rebuilds when a re-sorted list lands, and if it
    // lands on the wrong tile nobody notices. Measured — a swipe pulled `a2` into a pane, the window
    // showed `a2`, the dial sat on the first agent. The daemon is the only side that knows both, so it
    // repeats itself after every push.
    let agents: CableAgent[] = [{ id: 'a1', name: 'one' }, { id: 'a2', name: 'two' }]
    const { session, port } = await connect(makeHost({ listAgents: async () => agents }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    await session.followApp('', 'a2')          // the window is on a2
    await settle()
    port.sent.length = 0

    agents = [{ id: 'a2', name: 'two' }, { id: 'a1', name: 'one' }]   // the desk re-sorted the ring
    port.say({ t: 'focus', agentId: 'a1' })    // and the dial drifted onto another tile
    await settle()
    await session.pushAgents()
    await settle()

    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a2'])
    await session.stop()
  })

  it('a re-push after the window FOLLOWED the dial does not send it back', async () => {
    // Reported from the desk as a tile going 3 → 4 → 3 → 4 on its own.
    //
    // There were two memories of the same fact: where the dial was, and what the window last said. When
    // the window follows the DIAL, followApp returns early — the dial is already there — so the window's
    // memory kept an OLDER agent, and the next list push re-asserted that stale one. The dial jumped back
    // to it, the window's next report pulled it forward, and the two took turns.
    let agents: CableAgent[] = [{ id: 'a3', name: 'three' }, { id: 'a4', name: 'four' }]
    const { session, port } = await connect(makeHost({ listAgents: async () => agents }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    await session.followApp('', 'a3')     // the window led: both screens on a3
    await settle()

    port.say({ t: 'focus', agentId: 'a4' })   // a hand turns the dial to a4
    await settle()
    await session.followApp('', 'a4')          // the window follows — early return, nothing commanded
    await settle()
    port.sent.length = 0

    agents = [{ id: 'a4', name: 'four' }, { id: 'a3', name: 'three' }]   // the desk re-sorts the ring
    await session.pushAgents()
    await settle()

    // The re-assert says a4 — where both screens actually are — and never a3.
    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a4'])
    await session.stop()
  })

  it('a swipe made DURING a slow machine switch still reaches the window', async () => {
    // Measured on the real desk: selecting a remote machine took ten seconds, and for all ten every dial
    // report was discarded as "the window is mid-switch". The dial walked on, the window stayed put, and
    // the two screens named different agents with nothing left to correct them.
    //
    // The repaint this guards against answers the command at once. A hand, seconds later, does not.
    let finishSelection!: () => void
    const gate = new Promise<void>((resolve) => { finishSelection = resolve })
    const focus = vi.fn()
    const host = makeHost({
      focus,
      selectMachine: vi.fn(async () => { await gate; return { ok: true as const } }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    const following = session.followApp('remote-machine', 'r1')
    await settle()
    port.say({ t: 'focus', agentId: 'a1' })      // the switch's own repaint: discarded
    await settle()
    expect(focus).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + 5_000)          // the switch is still going
    port.say({ t: 'focus', agentId: 'a2' })      // …and a hand turns the dial
    await settle()
    expect(focus).toHaveBeenCalledWith('a2')

    finishSelection()
    await following
    vi.useRealTimers()
    await session.stop()
  })

  it('a swipe a second after the window clicked is a SWIPE, not an echo', async () => {
    // This window was 4s for one afternoon, to catch a re-anchor the dial should never have reported in
    // the first place. It caught real swipes instead: click something in the window, turn the dial within
    // four seconds, and the move vanished — the two screens then sat on different agents with nothing to
    // correct them, which is exactly the report that followed.
    //
    // The echo is stopped at its source now: a dial told where to look moves through code, and a move made
    // by code is not reported at all. So a report arriving a second later is a hand.
    const focus = vi.fn()
    const { session, port } = await connect(makeHost({ focus }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    await session.followApp('', 'a2')
    await settle()
    focus.mockClear()

    vi.setSystemTime(Date.now() + 1_000)
    port.say({ t: 'focus', agentId: 'a1' })
    await settle()

    expect(focus).toHaveBeenCalledWith('a1')
    vi.useRealTimers()
    await session.stop()
  })

  it('ignores stale dial focus while the app switches to a remote machine', async () => {
    let selected = 'mac-local'
    let finishSelection!: () => void
    const selectionGate = new Promise<void>((resolve) => { finishSelection = resolve })
    const host = makeHost({
      selectedMachine: () => selected,
      selectMachine: vi.fn(async (machineId: string) => {
        await selectionGate
        selected = machineId
        return { ok: true as const }
      }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    const following = session.followApp('remote-machine', 'r1')
    await settle()
    port.say({ t: 'focus', agentId: 'a1' }) // old tile reported while the list is rebuilding
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    finishSelection()
    await following
    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toContain('r1')

    port.say({ t: 'focus', agentId: 'a1' }) // stale old tile, delivered just after the switch completed
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    port.say({ t: 'focus', agentId: 'r1' }) // echo of the app-driven focus
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    port.say({ t: 'focus', agentId: 'r2' }) // a real subsequent dial move
    await settle()
    expect(host.focus).toHaveBeenCalledWith('r2')
    await session.stop()
  })

  it('sends the focus without waiting for the new machine\'s history', async () => {
    // THE BUG, measured on the desk: clicking from a local agent to a remote one left the dial on the old
    // tile for 1.5 s. `selectMachine` awaited `pushRestores`, and a restore asks every agent's own machine
    // what it was last doing — one cloud round trip per remote agent, in a serial loop, ahead of the one
    // frame the person was actually waiting for. History is `restore: true`; it can land afterwards.
    let releaseHistory!: () => void
    const history = new Promise<void>((resolve) => { releaseHistory = resolve })
    let selected = 'mac-local'
    const host = makeHost({
      selectedMachine: () => selected,
      selectMachine: vi.fn(async (machineId: string) => { selected = machineId; return { ok: true as const } }),
      listAgents: async () => [{ id: 'r1', name: 'Remote Claude', engine: 'claude' }],
      recentSummaries: async () => { await history; return [{ recap: 'shipped it', text: 'shipped it' }] },
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    await session.followApp('remote-machine', 'r1')

    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toContain('r1')
    expect(port.types()).not.toContain('summary')   // nothing of the history has been waited on

    releaseHistory()
    await vi.waitFor(() => expect(port.types()).toContain('summary'))
    await session.stop()
  })

  it('does not bounce a local app selection back to the previous remote agent', async () => {
    let selected = 'remote-machine'
    let finishSelection!: () => void
    const selectionGate = new Promise<void>((resolve) => { finishSelection = resolve })
    const host = makeHost({
      selectedMachine: () => selected,
      selectMachine: vi.fn(async (machineId: string) => {
        await selectionGate
        selected = machineId
        return { ok: true as const }
      }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    const following = session.followApp('mac-local', 'a2')
    await settle()
    port.say({ t: 'focus', agentId: 'r1' })
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    finishSelection()
    await following
    port.say({ t: 'focus', agentId: 'r1' }) // late report from the previous remote tile
    await settle()
    expect(host.focus).not.toHaveBeenCalled()

    port.say({ t: 'focus', agentId: 'a2' }) // acknowledgement of the commanded local tile
    await settle()
    port.say({ t: 'focus', agentId: 'r2' }) // subsequent physical dial move still works
    await settle()
    expect(host.focus).toHaveBeenCalledTimes(1)
    expect(host.focus).toHaveBeenCalledWith('r2')
    await session.stop()
  })

  it('coalesces quick app selections so the newest one focuses last', async () => {
    let selected = 'mac-local'
    let finishFirstSelection!: () => void
    const firstSelectionGate = new Promise<void>((resolve) => { finishFirstSelection = resolve })
    let selections = 0
    const host = makeHost({
      selectedMachine: () => selected,
      selectMachine: vi.fn(async (machineId: string) => {
        selections += 1
        if (selections === 1) await firstSelectionGate
        selected = machineId
        return { ok: true as const }
      }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    const oldSelection = session.followApp('remote-machine', 'r1')
    await settle()
    const newestSelection = session.followApp('mac-local', 'a2')
    finishFirstSelection()
    await Promise.all([oldSelection, newestSelection])

    expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a2'])
    expect(selected).toBe('mac-local')
    await session.stop()
  })

  it.each([{ selections: ['a2'] }, { selections: ['a1', 'a2'] }])('delivers the latest focus when $selections supersedes an unsent selection', async ({ selections }) => {
    const { session, port, host } = await connect()
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await settle()
      port.sent.length = 0
      let finish!: () => void
      vi.spyOn(host, 'listAgents').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(AGENTS) }))
      const first = session.followApp('mac-local', 'a2')
      await vi.waitFor(() => expect(finish).toBeDefined())
      const pending = selections.map(agentId => session.followApp('mac-local', agentId))
      finish()
      await Promise.all([first, ...pending])
      expect(port.sent.filter(m => m.t === 'focus')).toEqual([{ t: 'focus', agentId: 'a2' }])
    } finally { await session.stop() }
  })

  it('forwards a whole stroke, including the reports that carry no travel', async () => {
    // The ends of a stroke are the point of the message, not padding around it: a `down` with nothing in
    // it is what stops a fling still running on the far side, and an `up` with nothing in it is a finger
    // that came to rest before it lifted and must land as a stop rather than a throw. A forwarder that
    // "optimised away" the empty ones would leave the window holding a drag forever.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'scroll', phase: 'down', dy: 0 })
    port.say({ t: 'scroll', phase: 'move', dy: 12 })
    port.say({ t: 'scroll', phase: 'up', dy: 3, v: -1800 })
    await settle()

    expect(host.scrolled).toHaveBeenNthCalledWith(1, 'down', 0, 0)
    expect(host.scrolled).toHaveBeenNthCalledWith(2, 'move', 12, 0)
    expect(host.scrolled).toHaveBeenNthCalledWith(3, 'up', 3, -1800)
    await session.stop()
  })

  it('drops a stroke whose phase is not one of the three', async () => {
    // The dial is the only thing that speaks this today, but the decoder hands up whatever arrives, and a
    // phase nobody understands must not reach the window as a drag it can never close.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'scroll', phase: 'sideways', dy: 40 })
    await settle()

    expect(host.scrolled).not.toHaveBeenCalled()
    await session.stop()
  })

  it('forwards Finder as a distinct surface without focusing or typing into an agent', async () => {
    const form = vi.fn(async () => ({ ok: true, active: true, title: 'Find Harness', revision: 1 }))
    const host = makeHost({ form }), { session, port } = await connect(host)
    try {
      port.say({ t: 'form', formId: 'find-one', requestId: 'request-one', op: 'open', surface: 'find' })
      await vi.waitFor(() => expect(port.types()).toContain('form.state'))
      expect(form).toHaveBeenCalledWith({ formId: 'find-one', op: 'open', surface: 'find', revision: undefined, delta: undefined })
      expect(host.focus).not.toHaveBeenCalled(); expect(host.sendTurn).not.toHaveBeenCalled()
      expect(port.sent.at(-1)).toMatchObject({ formId: 'find-one', requestId: 'request-one', title: 'Find Harness' })
    } finally { await session.stop() }
  })

  it('uses spoken form text only as a pinned query, never a task', async () => {
    const form = vi.fn(async (c: import('./windowForm.js').FormCommand) => ({
      ok: true, active: true, canQuery: true, queryId: c.queryId, revision: 2,
    }))
    const route = vi.fn(), routeInWindow = vi.fn()
    const host = makeHost({ form, route, routeInWindow, transcribe: async () => 'Codex.' })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'voice.begin', formId: 'form-one', formRevision: 2, uploadId: 'speech' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.types()).toContain('voice.form'))
      expect(form.mock.calls.map(([c]) => c.op)).toEqual(['query.begin', 'query', 'query.cancel'])
      expect(form).toHaveBeenCalledWith({ op: 'query', formId: 'form-one', revision: 2, queryId: 'speech', text: 'Codex.' })
      expect(host.sendTurn).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled(); expect(routeInWindow).not.toHaveBeenCalled()
      expect(port.sent.at(-1)).toMatchObject({ t: 'voice.form', uploadId: 'speech', formId: 'form-one' })
    } finally { await session.stop() }
  })

  it.each([{ formId: 17 }, { formId: 'form-one', formRevision: 2, agentId: 'a1' },
    { formId: 'form-one', formRevision: -1 }, { formRevision: 2 }])('malformed form voice cannot fall back to routing: %j', async metadata => {
    const transcribe = vi.fn(), route = vi.fn(), routeInWindow = vi.fn()
    const host = makeHost({ transcribe, route, routeInWindow })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'voice.begin', uploadId: 'speech', ...metadata })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
      expect(transcribe).not.toHaveBeenCalled(); expect(host.sendTurn).not.toHaveBeenCalled()
      expect(route).not.toHaveBeenCalled(); expect(routeInWindow).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it('discard during transcription releases its field and ignores the late words', async () => {
    let complete!: (s: string) => void
    const transcribe = vi.fn(() => new Promise<string>(resolve => { complete = resolve }))
    const form = vi.fn(async (c: import('./windowForm.js').FormCommand) => ({ ok: true, active: true, canQuery: true, queryId: c.queryId }))
    const host = makeHost({ form, transcribe })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'voice.begin', formId: 'form-one', formRevision: 2, uploadId: 'speech' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
      port.say({ t: 'voice.abort', uploadId: 'speech' }); await settle()
      complete('Codex'); await settle()
      expect(form.mock.calls.map(([c]) => c.op)).toEqual(['query.begin', 'query.cancel'])
      expect(host.sendTurn).not.toHaveBeenCalled(); expect(port.types()).not.toContain('voice.form')
    } finally { await session.stop() }
  })

  it.each(['cancelled', 'abandoned', 'sent'] as const)('ignores a discarded home route that later replies %s', async (outcome) => {
    let complete!: (value: { t: 'cancelled' } | { t: 'abandoned' } | { t: 'sent'; agentId: string }) => void
    const routeInWindow = vi.fn(() => new Promise<{ t: 'cancelled' } | { t: 'abandoned' } | { t: 'sent'; agentId: string }>((resolve) => { complete = resolve }))
    const host = makeHost({ routeInWindow })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'voice.begin', uploadId: 'old' })
      port.pcm(Buffer.alloc(3200))
      port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(routeInWindow).toHaveBeenCalled())
      port.say({ t: 'voice.abort', uploadId: 'old' })
      port.say({ t: 'voice.begin', uploadId: 'new', agentId: 'a1' })
      port.pcm(Buffer.alloc(3200))
      // This can arrive after the replacement starts: it still belongs to the old turn.
      port.say({ t: 'voice.abort', uploadId: 'old' })
      complete(outcome === 'sent' ? { t: 'sent', agentId: 'a2' } : { t: outcome })
      await settle()
      expect(port.sent.filter((m) => String(m.t).startsWith('voice.'))).toEqual([])
      port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalledWith('a1', 'fix the login screen'))
      expect(host.sendTurn).toHaveBeenCalledTimes(1)
      expect(port.sent.filter((m) => String(m.t).startsWith('voice.'))).toEqual([
        expect.objectContaining({ t: 'voice.transcript', uploadId: 'new', agentId: 'a1' }),
      ])
    } finally { await session.stop() }
  })

  it('does not route or submit a recording discarded during transcription', async () => {
    let complete!: (text: string) => void
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { complete = resolve }))
    const routeInWindow = vi.fn()
    const host = makeHost({ transcribe, routeInWindow })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'voice.begin', uploadId: 'discarded' })
      port.pcm(Buffer.alloc(3200))
      port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
      port.say({ t: 'voice.abort', uploadId: 'discarded' })
      complete('discard this instruction')
      await settle()
      expect(routeInWindow).not.toHaveBeenCalled()
      expect(host.sendTurn).not.toHaveBeenCalled()
      expect(port.sent.filter((m) => String(m.t).startsWith('voice.'))).toEqual([])
    } finally { await session.stop() }
  })

  it('tags transcription errors with the recording id', async () => {
    const host = makeHost({ transcribe: async () => { throw new Error('retry voice') } })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'voice.begin', uploadId: 'failed' })
      port.pcm(Buffer.alloc(3200))
      port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.sent).toContainEqual({ t: 'voice.error', uploadId: 'failed', message: 'retry voice' }))
    } finally { await session.stop() }
  })

  it('routes a voice turn that names no agent', async () => {
    const host = makeHost({ appFocus: () => ({ machineId: 'mac-local', agentId: 'a2' }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    port.say({ t: 'voice.begin', lang: 'vi' })
    port.pcm(Buffer.alloc(3200, 7))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.transcript'))

    // The transcript went to the router's pick, and the dial was told which tile to land on.
    expect(host.sendTurn).toHaveBeenCalledWith('a1', 'fix the login screen')
    expect(port.sent.at(-1)).toMatchObject({ t: 'voice.transcript', agentId: 'a1', agentName: 'Fix login screen' })
    await session.stop()
  })

  it('lets the window route a spoken task, and does NOT send it a second time', async () => {
    // The window DELIVERS what its palette picks. Sending here as well is one sentence arriving twice.
    const route = vi.fn()
    const routeInWindow = vi.fn(async () => ({ t: 'sent' as const, agentId: 'a2' }))
    const host = makeHost({ route, routeInWindow })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    port.say({ t: 'voice.begin', lang: 'en' })
    port.pcm(Buffer.alloc(3200, 7))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.transcript'))

    expect(routeInWindow).toHaveBeenCalledWith('fix the login screen', undefined)
    expect(host.sendTurn).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
    // The dial is still told where the words went, so it lands on that tile and drops the overlay.
    expect(port.sent.at(-1)).toMatchObject({ t: 'voice.transcript', agentId: 'a2', agentName: 'Device firmware voice' })
    await session.stop()
  })

  it('carries the command word to the window, so /goal stays a goal', async () => {
    const routeInWindow = vi.fn(async () => ({ t: 'sent' as const, agentId: 'a1' }))
    const host = makeHost({ routeInWindow })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'voice.begin', lang: 'en', cmd: 'goal' })
    port.pcm(Buffer.alloc(3200, 7))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(routeInWindow).toHaveBeenCalled())

    expect(routeInWindow).toHaveBeenCalledWith('fix the login screen', 'goal')
    await session.stop()
  })

  it('sends nothing when a person closes the palette, and says so', async () => {
    const route = vi.fn()
    const host = makeHost({ route, routeInWindow: async () => ({ t: 'cancelled' as const }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    port.say({ t: 'voice.begin', lang: 'en' })
    port.pcm(Buffer.alloc(3200, 7))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))

    // Cancelling must not fall through to routing here — that would deliver what the person just refused.
    expect(host.sendTurn).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
    await session.stop()
  })

  it('will not race a pick that is still coming when the window goes quiet', async () => {
    const route = vi.fn()
    const host = makeHost({ route, routeInWindow: async () => ({ t: 'abandoned' as const }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0

    port.say({ t: 'voice.begin', lang: 'en' })
    port.pcm(Buffer.alloc(3200, 7))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))

    expect(host.sendTurn).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
    await session.stop()
  })

  it('routes here when no window is listening', async () => {
    const host = makeHost({ routeInWindow: async () => ({ t: 'unavailable' as const }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'voice.begin', lang: 'en' })
    port.pcm(Buffer.alloc(3200, 7))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalled())

    // The dial keeps working with the window shut — this is the whole reason the old router stays.
    expect(host.sendTurn).toHaveBeenCalledWith('a1', 'fix the login screen')
    await session.stop()
  })

  it('sends a voice turn straight to the agent the dial named', async () => {
    const route = vi.fn()
    const host = makeHost({ route })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'voice.begin', agentId: 'a2', lang: 'en' })
    port.pcm(Buffer.alloc(3200, 1))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalled())

    // Naming a tile IS the decision. Asking a router to confirm it is latency spent to reach the same answer.
    expect(route).not.toHaveBeenCalled()
    expect(host.sendTurn).toHaveBeenCalledWith('a2', 'fix the login screen')
    await session.stop()
  })

  it('pins ordinary dictation to the pane focused when recording begins, even if the dial is stale', async () => {
    let focused = 'a2'
    let finish!: (text: string) => void
    const transcribe = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const host = makeHost({
      appFocus: () => ({ machineId: 'mac-local', agentId: focused }),
      transcribe,
      route: vi.fn(),
    })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await settle()
      port.say({ t: 'voice.begin', agentId: 'a1', uploadId: 'focused-pane' })
      port.pcm(Buffer.alloc(3200, 1))
      // Focus can change during capture and during the asynchronous transcription.
      focused = 'a1'
      port.say({ t: 'voice.end', uploadId: 'focused-pane' })
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
      finish('one two three four five')
      await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalledOnce())
      expect(host.sendTurn).toHaveBeenCalledWith('a2', 'one two three four five')
      expect(host.route).not.toHaveBeenCalled()
      expect(port.sent).toContainEqual(expect.objectContaining({ t: 'voice.transcript', agentId: 'a2' }))
    } finally { await session.stop() }
  })

  it('restores the focused pane when a dial attaches after the window selected it', async () => {
    const host = makeHost({ appFocus: () => ({ machineId: 'mac-local', agentId: 'a2' }) })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.sent).toContainEqual({ t: 'focus', agentId: 'a2' }))
      expect(port.types().indexOf('agents.end')).toBeLessThan(port.types().indexOf('focus'))
    } finally { await session.stop() }
  })

  it('transcribes at the rate the dial states, not a guess', async () => {
    // 8 kHz described as 16 kHz is not slightly-off speech: the container lies about itself and the
    // transcriber answers with an empty string.
    let sawRate = 0
    const host = makeHost({
      transcribe: async (_pcm, rate) => { sawRate = rate; return 'xin chào' },
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'voice.begin', lang: 'vi', sr: 8000 })
    port.pcm(Buffer.alloc(1600, 3))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(sawRate).toBe(8000))
    await session.stop()
  })

  it('says so rather than guessing when transcription fails', async () => {
    const host = makeHost({
      transcribe: async () => {
        throw new Error('Voice needs CABLE_STT_API_KEY')
      },
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'voice.begin', lang: 'en' })
    port.pcm(Buffer.alloc(64))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))

    expect(port.sent.at(-1)).toMatchObject({ t: 'voice.error', message: 'Voice needs CABLE_STT_API_KEY' })
    expect(host.sendTurn).not.toHaveBeenCalled()
    await session.stop()
  })

  it('corrects a list it sent before the registry was ready', async () => {
    // THE BUG THIS EXISTS FOR: a daemon that has just restarted answers `hello` before its registry has
    // finished loading, so the honest answer at that instant is "no agents" — and under a rule that only
    // speaks when something changed, that one answer stood forever. The dial removed every tile and sat
    // empty while the daemon knew about two.
    let agents: CableAgent[] = []
    const { session, port } = await connect(makeHost({ listAgents: async () => agents }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.sent.filter((m) => m.t === 'agent')).toHaveLength(0)

    port.sent.length = 0
    agents = AGENTS                                    // the registry finishes loading
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'), { timeout: 3000 })
    expect(port.sent.filter((m) => m.t === 'agent')).toHaveLength(2)
    await session.stop()
  })

  it('stays quiet while the list is unchanged', async () => {
    // The other half of the same rule. A push per tick would re-send the whole board every second and
    // undo the thing that keeps an idle link idle.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0
    await new Promise((r) => setTimeout(r, 2500))      // two ticks
    expect(port.types().filter((t) => t.startsWith('agents'))).toEqual([])
    await session.stop()
  })

  it('sends the account-wide count and the tab beside the list, not the rows behind them', async () => {
    // The dial draws one number on the overview; the seventy rows behind it stay here. And `tab` is what
    // tells a shut window from an empty tab when both send zero agents.
    const { session, port } = await connect(makeHost({ agentTotal: () => 71, activeSwarm: () => 'tab-9' }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await session.pushAgents()

    expect(port.sent.filter((m) => m.t === 'agents.end').at(-1)).toMatchObject({ total: 71, tab: 'tab-9' })
    expect(port.sent.filter((m) => m.t === 'agents.end').at(-1)).not.toHaveProperty('ring')
    await session.stop()
  })

  it('pushes the same zero rows again when the window shuts, and not when only the tab changes', async () => {
    // Empty tab → shut app is a change the dial draws ("Nothing on this tab" → "Run OpenHarness"); empty
    // tab A → empty tab B is not — the `swarms` frame carries the tab's name — and pushing on it made
    // every tab switch cost two list pushes.
    let tab = 'a'
    const { session, port } = await connect(makeHost({ listAgents: async () => [], activeSwarm: () => tab }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    tab = 'b'
    await session.syncAgents()
    expect(port.types().filter((t) => t === 'agents.end')).toEqual([])
    tab = ''
    await session.syncAgents()
    expect(port.sent.filter((m) => m.t === 'agents.end').at(-1)).toMatchObject({ tab: '' })
    await session.stop()
  })

  it('keeps streamed pane rows and their workspace metadata in the same snapshot', async () => {
    let tab = 'old-tab', total = 2
    const { session, port } = await connect(makeHost({ activeSwarm: () => tab, agentTotal: () => total }))
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      const write = port.write.bind(port)
      port.write = async bytes => {
        await write(bytes)
        if (port.sent.at(-1)?.t === 'agent') { tab = 'new-tab'; total = 99 }
      }
      await session.syncAgents(true)
      expect(port.sent.find(m => m.t === 'agents.end')).toMatchObject({ tab: 'old-tab', total: 2 })
      expect(port.sent.filter(m => m.t === 'agent').map(m => m.id)).toEqual(['a1', 'a2'])
    } finally { await session.stop() }
  })

  it.each(['agents.refresh', 'agents.list'])('acknowledges an empty-workspace refresh via %s', async command => {
    let tab = 'empty-a'
    const { session, port } = await connect(makeHost({ activeSwarm: () => tab, listAgents: async () => [] }))
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      tab = 'empty-b'; await session.syncAgents()
      expect(port.sent).toEqual([]) // Unchanged rows are normally deduplicated.
      port.say({ t: command })
      await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
      if (command === 'agents.refresh') expect(port.types()).toEqual(['agents.begin', 'agents.end'])
      else expect(port.types()).toContain('swarms') // Legacy full state push is still a valid receipt.
      expect(port.sent.find(m => m.t === 'agents.end')).toMatchObject({ total: 2, tab: 'empty-b' })
      expect(port.types()).not.toContain('voice.transcript')
    } finally { await session.stop() }
  })

  it('forks on the dial\'s agent.fork and toasts only a refusal', async () => {
    const forkAgent = vi.fn(async (id: string) => id === 'a1'
      ? { ok: true as const, agentId: 'a1-fork' }
      : { ok: false as const, error: 'AGENT_BUSY', detail: 'Wait for it to finish, then fork.' })
    const { session, port } = await connect(makeHost({ forkAgent }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'agent.fork', agentId: 'a1' })
    await vi.waitFor(() => expect(forkAgent).toHaveBeenCalledWith('a1'))
    await new Promise((r) => setTimeout(r, 20))
    // The window is told through the host (`opened`); the dial hears nothing on success.
    expect(port.types().filter((t) => t === 'toast')).toEqual([])

    port.say({ t: 'agent.fork', agentId: 'a2' })
    await vi.waitFor(() => expect(port.sent.find((m) => m.t === 'toast')).toMatchObject({ text: 'Wait for it to finish, then fork.' }))
    await session.stop()
  })

  it('names the agent on every summary and question, for one the dial does not hold', async () => {
    const { session, port } = await connect(makeHost({}))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })

    await session.summary('a2', 'recap', 'body')
    await session.question('a1', 'q1', [{ key: 'k' }])
    // An id this daemon never listed: the fields travel empty rather than the frame being withheld.
    await session.summary('ghost', 'recap', 'body')

    expect(port.sent.find((m) => m.t === 'summary' && m.agentId === 'a2'))
      .toMatchObject({ name: 'Device firmware voice', engine: 'codex', machine: '' })
    expect(port.sent.find((m) => m.t === 'question')).toMatchObject({ name: 'Fix login screen', engine: 'claude', id: 'q1' })
    expect(port.sent.find((m) => m.t === 'summary' && m.agentId === 'ghost')).toMatchObject({ name: '', engine: '' })
    await session.stop()
  })

  it('marks a summary quiet when the window already has that agent on screen', async () => {
    const { session, port } = await connect(makeHost({}))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })

    await session.summary('a1', 'recap one', 'body one')
    await session.summary('a2', 'recap two', 'body two', true)

    const sent = port.sent.filter((m) => m.t === 'summary' && !m.restore)
    // Absent, not false, on the ordinary path: firmware that predates the flag must keep notifying
    // exactly as it did, and it reads a missing field as false.
    expect(sent.find((m) => m.agentId === 'a1')).not.toHaveProperty('quiet')
    // The recap still travels — the tile draws it either way. Only the beep and the drawer are withheld.
    expect(sent.find((m) => m.agentId === 'a2')).toMatchObject({ quiet: true, recap: 'recap two' })

    // A sub-agent's turn: silent — no beep, no drawer row — and the recap still travels.
    await session.summary('a1', 'recap three', 'body three', false, true)
    const silent = port.sent.filter((m) => m.t === 'summary' && m.agentId === 'a1').pop()
    expect(silent).toMatchObject({ silent: true, recap: 'recap three' })
    expect(silent).not.toHaveProperty('quiet')
  })

  it('redraws a reattached dial with what each agent was last doing', async () => {
    // The summaries were on disk the whole time; a tile with a name and no recap has forgotten the work
    // it belongs to. Newest LAST on the wire so it ends up on top of the tile's stack.
    const host = makeHost({
      recentSummaries: async (id) =>
        id === 'a1' ? [{ recap: 'newest', text: 'b2' }, { recap: 'older', text: 'b1' }] : [],
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types().filter((t) => t === 'summary')).toHaveLength(2))

    const restores = port.sent.filter((m) => m.t === 'summary')
    expect(restores.map((m) => m.recap)).toEqual(['older', 'newest'])
    // Every one is marked history. Without this, plugging the cable in announces every turn that
    // finished while it was unplugged — a beep and a notification each.
    expect(restores.every((m) => m.restore === true)).toBe(true)
    await session.stop()
  })

  it('answers models.list even when the catalog is empty', async () => {
    // The dial BLOCKS on this one message — it cannot draw a picker until the catalog is in hand. Silence
    // strands it on a spinner until its own timeout, which reads as a hang rather than "no choices here".
    const { session, port } = await connect(makeHost({ listModels: async () => [] }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.sent.length = 0
    port.say({ t: 'models.list', agentId: 'a1', mode: 'model' })
    await vi.waitFor(() => expect(port.types()).toContain('models'))
    expect(port.sent.at(-1)).toMatchObject({ t: 'models', agentId: 'a1', items: [] })
    await session.stop()
  })

  it('answers models.list when the provider throws', async () => {
    const { session, port } = await connect(makeHost({ listModels: async () => { throw new Error('no engine') } }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.say({ t: 'models.list', agentId: 'a1' })
    await vi.waitFor(() => expect(port.types()).toContain('models'))
    await session.stop()
  })

  it('echoes bounded model request serials and preserves legacy replies', async () => {
    const { session, port } = await connect(makeHost({ listModels: async () => ['test-model'] }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    for (const request of [1, 0x7fffffff, undefined, 0, -1, 1.5, 0x80000000, '12', { value: 1 }]) {
      port.sent.length = 0
      port.say({ t: 'models.list', agentId: 'a1', request })
      await vi.waitFor(() => expect(port.types()).toContain('models'))
      const reply = port.sent.find((m) => m.t === 'models')!
      expect(reply).toMatchObject({ agentId: 'a1', items: [{ id: 'test-model' }] })
      if (request === 1 || request === 0x7fffffff) expect(reply.request).toBe(request)
      else expect(reply).not.toHaveProperty('request')
    }
    await session.stop()
  })

  it('names the board a dial greets with, and lives without it', async () => {
    // Two dials ship on one image; the firmware says which it is in `hw`. A firmware from before the
    // field greets without it, and that is not an error — only a shorter line.
    const lines: string[] = []
    const seen: unknown[] = []
    const { session, port } = await connect(makeHost({ log: (l) => lines.push(l), onDialStatus: (s) => seen.push(s) }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '0.0.68', proto: 3, hw: 'cst816s' })
    await vi.waitFor(() => expect(lines.some((l) => l.includes('on fw 0.0.68 proto 3 hw cst816s'))).toBe(true))
    expect(seen).toEqual([{ attached: true, fw: '0.0.68', hw: 'cst816s', mac: 'aa:bb' }])
    port.say({ t: 'hello', product: 'harness', mac: 'cc:dd', fw: '0.0.67', proto: 3 })
    await vi.waitFor(() => expect(lines.some((l) => l.includes('dial cc:dd on fw 0.0.67 proto 3'))).toBe(true))
    expect(seen.at(-1)).toEqual({ attached: true, fw: '0.0.67', mac: 'cc:dd' })
    await session.stop()
  })

  it('files framed device logs instead of losing them', async () => {
    // The dial has ONE USB port, shared by its console and this protocol. While the daemon holds it,
    // these frames are the only copy of that console which exists anywhere — `idf.py monitor` cannot open
    // the port at the same time.
    const log = tmpLog()
    const { session, port } = await connect(makeHost(), log)
    port.logLine('I (1234) cable: link up')
    await vi.waitFor(() => expect(readFileSync(log.currentPath, 'utf8')).toContain('I (1234) cable: link up'))
    // The daemon's side of the story lands in the SAME file, marked as the daemon's.
    expect(readFileSync(log.currentPath, 'utf8')).toMatch(/\[daemon\] open on /)
    await session.stop()
  })

  it('drops audio that arrives outside a turn', async () => {
    // A dial that rebooted mid-capture starts sending PCM again with no `voice.begin` in front of it.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    port.pcm(Buffer.alloc(3200, 9))
    port.say({ t: 'voice.end' })
    await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
    expect(host.sendTurn).not.toHaveBeenCalled()
    await session.stop()
  })
  // ── the machine wheel ─────────────────────────────────────────────────────────────────────────────

  it('streams the machine list and names the selected one', async () => {
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('machines.end'))

    expect(port.sent.find((m) => m.t === 'machine')).toMatchObject({
      t: 'machine', id: 'mac-local', name: 'MacBook Pro', state: 'ready', local: true,
    })
    expect(port.sent.find((m) => m.t === 'machines.end')).toMatchObject({ selected: 'mac-local', source: 'backend' })
    await session.stop()
  })

  it('names the CABLED computer in welcome, not the dial', async () => {
    // Until proto 2 this carried the dial's own MAC as the machine id — a value nothing could ever select.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('welcome'))
    expect(port.sent[0]).toMatchObject({ t: 'welcome', machine: { id: 'mac-local' }, selected: 'mac-local' })
    await session.stop()
  })

  it('says nothing about machines when nothing changed', async () => {
    // The 15s hello cadence and every port reopen would otherwise re-push a list the dial already has —
    // the flap that measured out at 31 session restarts an hour, with the agent list wiped each time.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('machines.end'))
    const before = port.types().filter((t) => t === 'machines.begin').length

    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })   // same dial, same firmware: a keepalive
    await settle()
    expect(port.types().filter((t) => t === 'machines.begin')).toHaveLength(before)
    await session.stop()
  })

  it('acks a select, then pushes THAT machine\'s agents', async () => {
    const other: CableMachine = { id: 'm2', name: 'office-imac', state: 'ready', local: false }
    const remote: CableAgent[] = [{ id: 'r1', name: 'api refactor', engine: 'codex' }]
    let selected = 'mac-local'
    const host = makeHost({
      listMachines: async () => ({ machines: [LOCAL_ROW, other], source: 'backend' as const }),
      selectedMachine: () => selected,
      selectMachine: async (id: string) => { selected = id; return { ok: true as const } },
      listAgents: async () => (selected === 'm2' ? remote : AGENTS),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'm2' })
    await vi.waitFor(() => expect(port.types()).toContain('machine.selected'))
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    expect(port.sent.filter((m) => m.t === 'agent')).toHaveLength(1)
    expect(port.sent.find((m) => m.t === 'agent')).toMatchObject({ id: 'r1' })
    await session.stop()
  })

  it('re-sends neither the list nor the history when a select changes neither', async () => {
    // The carousel spans every machine: `listAgentsFlat` reads the same agents whichever row wears the ✓,
    // so moving the ✓ changes the machine wheel and nothing else. This used to force both pushes anyway —
    // 55 frames of a list and a history the dial already had, down a cable the `focus` the person just
    // clicked has to share. Measured on the desk: the focus was written in 20 ms and landed 1.7 s later.
    const everywhere: CableAgent[] = [...AGENTS]
    let selected = 'mac-local'
    const host = makeHost({
      listMachines: async () => ({
        machines: [LOCAL_ROW, { id: 'm2', name: 'twin', state: 'ready' as const, local: false }],
        source: 'backend' as const,
      }),
      selectedMachine: () => selected,
      selectMachine: async (id: string) => { selected = id; return { ok: true as const } },
      listAgents: async () => everywhere,
      recentSummaries: async () => [{ recap: 'shipped it', text: 'shipped it' }],
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    await vi.waitFor(() => expect(port.types()).toContain('summary'))   // the attach DOES restore
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'm2' })
    await vi.waitFor(() => expect(port.types()).toContain('machine.selected'))
    await settle()

    expect(port.types()).toContain('machines.end')    // the ✓ moved, so the wheel is re-sent
    expect(port.types()).not.toContain('agent')       // the tiles did not
    expect(port.types()).not.toContain('summary')     // nor the history behind them
    await session.stop()
  })

  it('restores a tile that appears after the attach, and only that one', async () => {
    // A remote machine's agents reach the cache seconds after the greeting, so the attach's restore ran
    // before they existed. They must still arrive with their history — without dragging every tile that
    // already has one back down the cable behind them.
    let agents: CableAgent[] = [{ id: 'a1', name: 'one' }]
    const asked: string[] = []
    const { session, port } = await connect(makeHost({
      listAgents: async () => agents,
      recentSummaries: async (agentId: string) => { asked.push(agentId); return [{ recap: 'shipped it', text: '' }] },
    }))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('summary'))
    port.sent.length = 0
    asked.length = 0

    agents = [...agents, { id: 'r1', name: 'the remote one' }]   // that machine's list just landed
    await session.syncAgents()
    await vi.waitFor(() => expect(port.types()).toContain('summary'))

    expect(asked).toEqual(['r1'])
    expect(port.sent.filter((m) => m.t === 'summary').map((m) => m.agentId)).toEqual(['r1'])
    await session.stop()
  })

  it('reports a refused select and leaves the selection alone', async () => {
    const host = makeHost({
      selectMachine: async () => ({ ok: false as const, code: 'NEEDS_LINK', message: 'Run harness link import' }),
    })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'm2' })
    await vi.waitFor(() => expect(port.types()).toContain('machine.error'))
    expect(port.sent.find((m) => m.t === 'machine.error')).toMatchObject({
      machineId: 'm2', code: 'NEEDS_LINK', message: 'Run harness link import',
    })
    expect(port.types()).not.toContain('agents.begin')   // the old machine's tiles stay put
    await session.stop()
  })

  it('answers a select of the machine already selected instead of going quiet', async () => {
    // Silence here strands the dial on its spinner until its own deadline, which reads as a hang.
    const { session, port } = await connect()
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
    port.sent.length = 0

    port.say({ t: 'machine.select', machineId: 'mac-local' })
    await vi.waitFor(() => expect(port.types()).toContain('machine.selected'))
    await session.stop()
  })

  it('shows one row and says why when there is no lane to anywhere else', async () => {
    const host = makeHost({ listMachines: async () => ({ machines: [LOCAL_ROW], source: 'signed-out' as const }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.types()).toContain('machines.end'))
    expect(port.sent.filter((m) => m.t === 'machine')).toHaveLength(1)
    expect(port.sent.find((m) => m.t === 'machines.end')).toMatchObject({ source: 'signed-out' })
    await session.stop()
  })

  it('forwards a question answer verbatim, keyed by the QUESTION keys', async () => {
    // The dial has always sent {agentId, requestId, answers}; this case used to demand {id, optionId} and
    // silently dropped every answer the question screen produced.
    const host = makeHost()
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()

    port.say({ t: 'answer', agentId: 'a1', requestId: 'req-7', answers: { scope: 'wide', mode: 'plan' } })
    await vi.waitFor(() => expect(host.answer).toHaveBeenCalled())
    expect(host.answer).toHaveBeenCalledWith('a1', 'req-7', { scope: 'wide', mode: 'plan' })
    await session.stop()
  })

  it('fits ten machines with long names into single frames', async () => {
    const many: CableMachine[] = Array.from({ length: 10 }, (_, i) => ({
      id: `machine-${String(i).padStart(30, 'x')}`,
      name: 'x'.repeat(39),
      state: 'ready' as const,
      local: i === 0,
    }))
    const host = makeHost({ listMachines: async () => ({ machines: many, source: 'backend' as const }) })
    const { session, port } = await connect(host)
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(port.sent.filter((m) => m.t === 'machine')).toHaveLength(10))
    for (const frame of port.frames) expect(frame.length).toBeLessThan(8192)
    await session.stop()
  })
  it('never interleaves two streamed pushes', async () => {
    // MEASURED ON HARDWARE, 2026-08-25, first plug-in of the proto-2 firmware: the dial reported EIGHT
    // machines while the daemon's own log said it had sent four, three times.
    //
    // `onMessage` is fired from the decoder and never awaited, so a dial that greets and then asks for
    // both lists has three pushes in flight at once — and each row parks on an await. Unserialised, the
    // wire carried `begin begin begin row×6 end end end`: the dial reset its staging on every begin,
    // accumulated every push's rows, and committed the pile on the first end.
    //
    // THE SLOW PORT IS THE TEST. With a write that resolves synchronously the three pushes run to
    // completion one at a time and this passes with or without the fix — which is exactly what the first
    // version of this test did, and why it proved nothing. A real tty accepts a few hundred bytes at a
    // time; every frame parks.
    class SlowPort implements CablePort {
      readonly path = 'slow'
      isOpen = true
      readonly sent: Array<Record<string, unknown>> = []
      private decoder = new CableDecoder()
      constructor(private readonly onData: (chunk: Buffer) => void) {}
      async write(bytes: Uint8Array): Promise<void> {
        await new Promise((r) => setTimeout(r, 0))
        this.decoder.feed(Buffer.from(bytes), (frame) => {
          if (frame.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')))
        })
      }
      async close(): Promise<void> { this.isOpen = false }
      say(msg: Record<string, unknown>): void {
        this.onData(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg), 'utf8'))))
      }
    }

    const rows: CableMachine[] = [
      LOCAL_ROW,
      { id: 'm2', name: 'office-imac', state: 'ready', local: false },
    ]
    const host = makeHost({ listMachines: async () => ({ machines: rows, source: 'backend' as const }) })
    let port!: SlowPort
    const session = new CableSession(host, tmpLog(), async (onData) => {
      port = new SlowPort(onData)
      return port
    })
    session.start()
    await vi.waitFor(() => expect(port).toBeTruthy())

    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    port.say({ t: 'machines.list' })
    port.say({ t: 'agents.list' })
    await vi.waitFor(() => {
      expect(port.sent.filter((m) => m.t === 'machines.end').length).toBeGreaterThanOrEqual(3)
      expect(port.sent.filter((m) => m.t === 'agents.end').length).toBeGreaterThanOrEqual(2)
      expect(port.sent.filter((m) => m.t === 'notif.replace').length).toBeGreaterThanOrEqual(2)
    })

    // Walk the wire: a `begin` may never open inside another, and each pair must hold the rows of ONE list.
    let open = ''
    let seen = 0
    for (const m of port.sent) {
      if (m.t === 'machines.begin' || m.t === 'agents.begin') {
        expect(open, 'a begin arrived inside another begin').toBe('')
        open = m.t === 'machines.begin' ? 'machine' : 'agent'; seen = 0
      } else if (m.t === 'machine' || m.t === 'agent') {
        expect(open, 'a row arrived outside its own begin/end pair').toBe(m.t); seen++
      } else if (m.t === 'machines.end' || m.t === 'agents.end') {
        expect(open).toBe(m.t === 'machines.end' ? 'machine' : 'agent')
        expect(seen).toBe(open === 'machine' ? rows.length : AGENTS.length); open = ''
      }
    }
    expect(open, 'a begin was never closed').toBe('')
    await session.stop()
  })
  it('tells the host when the dial arrives and when it goes', async () => {
    // The daemon's cloud lane is held on the dial's behalf, so these two are what open and close it. A
    // port that goes silent must look identical to a cable that was pulled — both are "no dial".
    const host = makeHost()
    host.onDialAttached = vi.fn()
    host.onDialGone = vi.fn()
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(host.onDialAttached).toHaveBeenCalledTimes(1))

    // A keepalive greeting from the same dial is not a new arrival — re-opening the lane on every one
    // would dial the cloud every fifteen seconds for as long as the dial sits there.
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await settle()
    expect(host.onDialAttached).toHaveBeenCalledTimes(1)

    await session.stop()
    expect(host.onDialGone).toHaveBeenCalled()
  })
})

describe('speak an answer, then review', () => {
  const qs = [{ key: 'scope', q: 'Which scope?', options: ['File', 'Project'], multi: false, canText: true }]
  async function prepare(over: Partial<CableHost> = {}) {
    const answerReviewed = vi.fn<NonNullable<CableHost['answerReviewed']>>(async () => ({ ok: true }))
    const host = makeHost({ answerReviewed, canSpeakQuestion: () => true, transcribe: async () => 'Only the parser, please.', ...over })
    const c = await connect(host)
    c.port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
    await c.session.question('a1', 'q-speak', qs)
    c.port.say({ t: 'question.read', agentId: 'a1', requestId: 'read' })
    await vi.waitFor(() => expect(c.port.types()).toContain('question.state'))
    const token = c.port.sent.find(m => m.t === 'question.state')!.token
    return { ...c, token, answerReviewed }
  }
  it('returns recognized words for review with no agent input, then delivers the exact approved draft once', async () => {
    const { session, port, host, token, answerReviewed } = await prepare()
    try {
      port.say({ t: 'voice.begin', agentId: 'a1', questionToken: token, questionIndex: 0, uploadId: 'speech-q' })
      port.pcm(Buffer.alloc(640)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.types()).toContain('voice.question'))
      const draft = port.sent.find(m => m.t === 'voice.question')!
      expect(draft).toMatchObject({ agentId: 'a1', token, questionIndex: 0, text: 'Only the parser, please.', uploadId: 'speech-q' })
      expect(answerReviewed).not.toHaveBeenCalled(); expect(host.sendTurn).not.toHaveBeenCalled()
      const submit = { t: 'answer.reviewed', agentId: 'a1', requestId: 'send', token, choices: [0], drafts: [draft.draftId] }
      port.say(submit); port.say(submit)
      await vi.waitFor(() => expect(answerReviewed).toHaveBeenCalledTimes(1))
      expect(answerReviewed.mock.calls[0][0]).toMatchObject({ freeTextKeys: ['scope'], answers: { scope: 'Only the parser, please.' } })
    } finally { await session.stop() }
  })
  it.each(['discard', 'close', 'replace', 'disconnect'] as const)('drops a late transcript after %s', async reason => {
    let resolve!: (s: string) => void
    const transcribe = vi.fn(() => new Promise<string>(r => { resolve = r }))
    const { session, port, host, token, answerReviewed } = await prepare({ transcribe })
    try {
      port.say({ t: 'voice.begin', agentId: 'a1', questionToken: token, questionIndex: 0, uploadId: 'speech-q' })
      port.pcm(Buffer.alloc(640)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
      if (reason === 'discard') port.say({ t: 'voice.abort', uploadId: 'speech-q' })
      if (reason === 'close') await session.questionClose('a1', 'q-speak')
      if (reason === 'replace') await session.question('a1', 'q-new', qs)
      if (reason === 'disconnect') await port.close()
      resolve('This must not send'); await settle(); await settle()
      expect(port.types()).not.toContain('voice.question')
      expect(answerReviewed).not.toHaveBeenCalled(); expect(host.sendTurn).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })
  it.each([{ questionIndex: 0 }, { questionToken: 'wrong', questionIndex: 0 },
    { questionToken: 'bad', questionIndex: -1 }, { questionToken: null }])('never routes malformed question voice: %j', async metadata => {
    const transcribe = vi.fn(async () => 'wrong'), route = vi.fn()
    const { session, port, host, answerReviewed } = await prepare({ transcribe, route })
    try {
      port.say({ t: 'voice.begin', agentId: 'a1', ...metadata, uploadId: 'speech-q' })
      port.pcm(Buffer.alloc(640)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
      expect(transcribe).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled()
      expect(answerReviewed).not.toHaveBeenCalled(); expect(host.sendTurn).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })
  it('does not offer speech without a capable local receiver', async () => {
    const { session, port } = await prepare({ canSpeakQuestion: () => false })
    try {
      const state = port.sent.find(m => m.t === 'question.state')!
      expect(state.questions).toMatchObject([{ canText: false }])
    } finally { await session.stop() }
  })
})

describe('task voice draft over the cable', () => {
  async function recorded(port: LoopbackPort, fields: Record<string, unknown> = {}, review = true) {
    const uploadId = `draft-${port.sent.length}`
    port.say({ t: 'voice.begin', uploadId, ...fields }); port.pcm(Buffer.alloc(320))
    port.say({ t: 'voice.end', uploadId, review })
    await vi.waitFor(() => expect(port.sent.some(m => m.uploadId === uploadId && ['voice.draft','voice.error','voice.transcript'].includes(m.t as string))).toBe(true))
    return port.sent.find(m => m.uploadId === uploadId && m.t !== 'voice.quota')!
  }
  async function command(port: LoopbackPort, page: Record<string,unknown>, op: string, fields:Record<string,unknown>={}) {
    const requestId=`draft-cmd-${port.sent.length}`
    port.say({ t:'draft.command', draftId:page.id, revision:page.revision, requestId, op, ...fields })
    await vi.waitFor(()=>expect(port.sent.some(m=>m.requestId===requestId)).toBe(true))
    return port.sent.find(m=>m.requestId===requestId)!
  }
  it('reviews, replaces a section, appends, undoes, and sends once to the original recipient', async () => {
    const transcribe=vi.fn().mockResolvedValueOnce('First idea.').mockResolvedValueOnce('Better idea.').mockResolvedValueOnce('Keep the tests.')
    const host=makeHost({transcribe}), {session,port}=await connect(host)
    try {
      let p=await recorded(port,{agentId:'a2'})
      expect(p).toMatchObject({ t:'voice.draft', agentId:'a2', text:'First idea.', active:true })
      expect(host.sendTurn).not.toHaveBeenCalled()
      p=await recorded(port,{draftId:p.id,draftRevision:p.revision,draftOp:'replace'},false)
      expect(p.text).toBe('Better idea.')
      p=await recorded(port,{draftId:p.id,draftRevision:p.revision,draftOp:'append'},false)
      expect(p.text).toBe('Better idea.\n\nKeep the tests.')
      p=await command(port,p,'undo'); expect(p.text).toBe('Better idea.')
      const receipt=await command(port,p,'send'); expect(receipt.sent).toBe(true)
      await command(port,p,'send')
      expect(host.sendTurn).toHaveBeenCalledExactlyOnceWith('a2','Better idea.')
      expect(host.focus).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })
  it('keeps selected text frozen through re-speaking and sending', async () => {
    const selectPassage=vi.fn<NonNullable<CableHost['selectPassage']>>(async () => ({ok:true,selectionId:'sel',revision:2,text:'const answer = 42;',excerpt:'const answer = 42;',rows:1,extending:false}))
    const transcribe=vi.fn().mockResolvedValueOnce('Explain.').mockResolvedValueOnce('Simplify this.')
    const host=makeHost({selectPassage,transcribe}), {session,port}=await connect(host)
    try {
      let p=await recorded(port,{agentId:'a2',selectionId:'sel',selectionRevision:2})
      expect(p.context).toBe('With selected text')
      p=await recorded(port,{draftId:p.id,draftRevision:p.revision,draftOp:'replace'},false)
      await command(port,p,'send')
      expect(host.sendTurn).toHaveBeenCalledTimes(1)
      const args=vi.mocked(host.sendTurn).mock.calls[0]
      expect(args[0]).toBe('a2'); expect(args[1]).toContain('Simplify this.'); expect(args[1]).toContain('const answer = 42;')
    } finally { await session.stop() }
  })
  it('discarding an unseen creation releases the next recording', async () => {
    const {host,session,port}=await connect()
    try {
      const p=await recorded(port,{agentId:'a1'})
      port.say({t:'voice.abort',uploadId:p.uploadId}); await settle()
      expect((await recorded(port,{agentId:'a2'})).t).toBe('voice.draft')
      expect(host.sendTurn).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })
  it.each([{draftId:'missing',draftRevision:1,draftOp:'replace'}, {draftId:null},
    {draftId:'id',draftRevision:1,draftOp:'append',agentId:'a2'},
    {draftId:'id',draftRevision:1,draftOp:'replace',formId:'form'}])('never routes malformed draft speech %j', async fields => {
    const host=makeHost({transcribe:vi.fn(async()=> 'No fallback')}), {session,port}=await connect(host)
    try {
      expect((await recorded(port,fields,false)).t).toBe('voice.error')
      expect(host.sendTurn).not.toHaveBeenCalled(); expect(host.transcribe).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })
  it('requires a named recipient for initial review', async () => {
    const host=makeHost({route:vi.fn(),routeInWindow:vi.fn()}),{session,port}=await connect(host)
    try {
      expect((await recorded(port)).t).toBe('voice.error')
      expect(host.route).not.toHaveBeenCalled();expect(host.routeInWindow).not.toHaveBeenCalled();expect(host.sendTurn).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })
  it('ignores an old voice.end and keeps the new capture alive', async () => {
    const {host,session,port}=await connect()
    try {
      port.say({t:'voice.begin',agentId:'a1',uploadId:'new'});port.pcm(Buffer.alloc(320))
      port.say({t:'voice.end',uploadId:'old',review:true});await settle()
      expect(port.types()).not.toContain('voice.draft');expect(host.sendTurn).not.toHaveBeenCalled()
      port.say({t:'voice.end',uploadId:'new',review:true})
      await vi.waitFor(()=>expect(port.types()).toContain('voice.draft'))
    } finally { await session.stop() }
  })
  it('does not apply late transcription after the draft was discarded', async () => {
    let resolve!:(v:string)=>void
    const transcribe=vi.fn().mockResolvedValueOnce('Keep me.').mockImplementationOnce(()=>new Promise<string>(r=>{resolve=r}))
    const host=makeHost({transcribe}),{session,port}=await connect(host)
    try {
      const p=await recorded(port,{agentId:'a1'})
      port.say({t:'voice.begin',draftId:p.id,draftRevision:p.revision,draftOp:'replace',uploadId:'late'});port.pcm(Buffer.alloc(320));port.say({t:'voice.end',uploadId:'late'})
      await vi.waitFor(()=>expect(transcribe).toHaveBeenCalledTimes(2));await command(port,p,'discard')
      resolve('Too late.');await settle();await settle()
      expect(port.sent.some(m=>m.t==='voice.draft' && m.uploadId==='late')).toBe(false)
      expect(host.sendTurn).not.toHaveBeenCalled()
    } finally {await session.stop()}
  })
  it('keeps a carried quote through discard and consumes only the accepted send', async () => {
    const selectPassage=vi.fn<NonNullable<CableHost['selectPassage']>>(async()=>({ok:true,selectionId:'sel',revision:2,text:'  original\nsource',excerpt:'original source',rows:2,extending:true}))
    const host=makeHost({selectPassage}),{session,port}=await connect(host)
    try {
      port.say({t:'carry.prepare',carryId:'quote',requestId:'prepare',agentId:'a1',selectionId:'sel',revision:2})
      await vi.waitFor(()=>expect(port.types()).toContain('carry.state'))
      let p=await recorded(port,{agentId:'a2',carryId:'quote'})
      expect(p.context).toContain('Fix login screen');expect(host.sendTurn).not.toHaveBeenCalled()
      await command(port,p,'discard')
      p=await recorded(port,{agentId:'a2',carryId:'quote'})
      expect(p.t).toBe('voice.draft')
      expect(await command(port,p,'send')).toMatchObject({sent:true,carryId:'quote'})
      expect(vi.mocked(host.sendTurn).mock.calls[0][1]).toContain('>   original\n> source')
      expect((await recorded(port,{agentId:'a2',carryId:'quote'})).t).toBe('voice.error')
      expect(host.sendTurn).toHaveBeenCalledTimes(1)
    } finally {await session.stop()}
  })
  it('preserves the draft when cancelling an edit whose reply already arrived', async () => {
    const host=makeHost({transcribe:vi.fn().mockResolvedValueOnce('Original.').mockResolvedValueOnce('Edited.')}),{session,port}=await connect(host)
    try {
      let p=await recorded(port,{agentId:'a1'})
      p=await recorded(port,{draftId:p.id,draftRevision:p.revision,draftOp:'replace'},false)
      port.say({t:'voice.abort',uploadId:p.uploadId});await settle()
      expect(await command(port,p,'state')).toMatchObject({active:true,text:'Edited.'})
      expect(host.sendTurn).not.toHaveBeenCalled()
    } finally {await session.stop()}
  })

})


describe('spoken output search purpose', () => {
  const metadata = { agentId: 'a2', searchId: 'search-one', searchRevision: 3 }
  const read = { ok: true as const, selectionId: 'search-one', revision: 3, rows: 1, excerpt: 'line', extending: false }
  it.each([0, 2])('returns %i matches without routing, delivering, or drafting', async matches => {
    const selectPassage = vi.fn<NonNullable<CableHost['selectPassage']>>(async c => c.op === 'read' ? read : {
      ...read, revision: 4, query: c.query, match: matches ? 1 : 0, matches, rows: matches ? 1 : 0, excerpt: matches ? 'ERROR [x]' : '',
    })
    const route = vi.fn(), routeInWindow = vi.fn()
    const host = makeHost({ selectPassage, route, routeInWindow, transcribe: async () => 'error [x].' })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'voice.begin', uploadId: 'search-voice', ...metadata })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end', review: true })
      await vi.waitFor(() => expect(port.types()).toContain('voice.search'))
      expect(selectPassage.mock.calls.map(([c]) => c.op)).toEqual(['read', 'search'])
      expect(selectPassage).toHaveBeenLastCalledWith({ op: 'search', agentId: 'a2', selectionId: 'search-one', revision: 3, query: 'error [x]' })
      expect(port.sent.at(-1)).toMatchObject({ t: 'voice.search', uploadId: 'search-voice', agentId: 'a2', matches })
      expect(host.sendTurn).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled(); expect(routeInWindow).not.toHaveBeenCalled()
      expect(port.types()).not.toContain('voice.draft')
    } finally { await session.stop() }
  })
  it.each([{searchId:17}, {searchRevision:3}, {searchId:'bad id'}, {searchRevision:0}, {searchRevision:0x80000000},
    {cmd:''}, {formId:'f'}, {selectionId:'s'}, {carryId:'c'}, {draftId:'d'}, {questionToken:'q'}])(
    'malformed or mixed metadata never falls back to task input: %j', async extra => {
      const transcribe = vi.fn(), route = vi.fn(), selectPassage = vi.fn()
      const host = makeHost({ transcribe, route, selectPassage }), { session, port } = await connect(host)
      try {
        port.say({ t:'voice.begin', uploadId:'bad-search', ...metadata, ...extra,
          ...(Object.keys(extra).length === 1 && 'searchRevision' in extra && extra.searchRevision === 3 ? {searchId:undefined} : {}) })
        port.pcm(Buffer.alloc(3200)); port.say({t:'voice.end'})
        await vi.waitFor(() => expect(port.types()).toContain('voice.error'))
        expect(host.sendTurn).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled()
      } finally { await session.stop() }
    })
  it('discard during transcription cancels only the original cursor', async () => {
    let finish!: (s:string)=>void
    const transcribe=vi.fn(()=>new Promise<string>(r=>{finish=r}))
    const selectPassage=vi.fn<NonNullable<CableHost['selectPassage']>>(async()=>read)
    const host=makeHost({selectPassage,transcribe}), {session,port}=await connect(host)
    try {
      port.say({t:'voice.begin',uploadId:'cancel-search',...metadata}); port.pcm(Buffer.alloc(3200)); port.say({t:'voice.end'})
      await vi.waitFor(()=>expect(transcribe).toHaveBeenCalled())
      port.say({t:'voice.abort',uploadId:'cancel-search'}); await settle(); finish('late phrase'); await settle()
      expect(selectPassage.mock.calls.map(([c])=>c.op)).toEqual(['read','cancel'])
      expect(selectPassage).toHaveBeenLastCalledWith({op:'cancel',agentId:'a2',selectionId:'search-one',revision:3})
      expect(port.types()).not.toContain('voice.search'); expect(host.sendTurn).not.toHaveBeenCalled()
    } finally {await session.stop()}
  })
})
