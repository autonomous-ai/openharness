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

import { CABLE_MAX_FRAME, CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { CableSession, recapFrame, type CableAgent, type CableHost, type CableMachine, type CablePort } from './cableSession.js'
import { DialLog } from './dialLog.js'
import type { SaidOnCard, SwarmCard, SwarmLead } from '../superTabs/cards.js'
import type { PetStore } from './pets/store.js'

/** A port whose two ends are both in this process. */
class LoopbackPort implements CablePort {
  readonly path = '/dev/loopback'
  isOpen = true
  /** Everything the daemon wrote, decoded back into messages. */
  readonly sent: Array<Record<string, unknown>> = []
  /** The `seq` of each frame in `sent` (taken off the message, so exact-match specs need not know it); undefined = none. */
  readonly seqs: Array<number | undefined> = []
  /** The raw bytes of every frame written, so a test can assert the 8 KB cap holds. */
  readonly frames: Uint8Array[] = []
  /** Payloads of every pet slice (CableType.Pet) the daemon wrote. */
  readonly petSlices: Buffer[] = []
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
        const { seq, ...message } = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>
        this.sent.push(message)
        this.seqs.push(seq as number | undefined)
      }
      if (frame.type === CableType.Pet) this.petSlices.push(Buffer.from(frame.payload))
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

  /** Bytes that are not (all) a frame, as the dial's boot ROM or panic handler writes them. */
  raw(bytes: Buffer): void { this.onData(bytes) }

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

  it('drops a screenTurned from an older Pro firmware and still parses the settings', async () => {
    const seen: any[] = []
    const { session, port } = await connect(makeHost({ onDialStatus: (s) => seen.push(s) }))
    const base = {
      brightness: 80, character: 0, face: 720, muted: false, quiet: false, straightTitle: false,
      focusFace: false, scrollReversed: false, round: false, voiceLang: 'en',
    }
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', board: 'pro', proto: 3, settings: { ...base, screenTurned: true } })
    await vi.waitFor(() => expect(seen.at(-1)?.settings?.brightness).toBe(80))
    expect(seen.at(-1).settings).not.toHaveProperty('screenTurned')
    await session.stop()
  })

  it('carries the optional uiSkin of a Pro, drops only an unknown skin, and sends it', async () => {
    const seen: any[] = []
    const { session, port } = await connect(makeHost({ onDialStatus: (s) => seen.push(s) }))
    const base = {
      brightness: 80, character: 0, face: 720, muted: false, quiet: false, straightTitle: false,
      focusFace: false, scrollReversed: false, round: false, voiceLang: 'en',
    }
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', board: 'pro', proto: 3, settings: { ...base, uiSkin: 'console' } })
    await vi.waitFor(() => expect(seen.at(-1)?.settings?.uiSkin).toBe('console'))
    port.say({ t: 'settings.state', ok: true, settings: { ...base, brightness: 10, uiSkin: 'neon' } })
    await settle()
    await vi.waitFor(() => expect(seen.at(-1).settings.brightness).toBe(10))
    expect(seen.at(-1).settings.uiSkin).toBeUndefined()
    await session.setSettings({ uiSkin: 'console' })
    expect(port.sent.at(-1)).toEqual({ t: 'settings.set', uiSkin: 'console' })
    await session.stop()
  })

  it('refuses a uiSkin patch when the device never reported a uiSkin', async () => {
    const { session, port } = await connect(makeHost({}))
    const base = {
      brightness: 80, character: 0, face: 720, muted: false, quiet: false, straightTitle: false,
      focusFace: false, scrollReversed: false, round: false, voiceLang: 'en',
    }
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', board: 'pro', proto: 3, settings: base })
    await settle()
    const before = port.sent.length
    expect(await session.setSettings({ uiSkin: 'console' })).toBe(false)
    expect(port.sent.length).toBe(before)
    expect(await session.setSettings({ brightness: 10 })).toBe(true)
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

  it('posts words spoken to a Swarm Lead in its Swarm chat, and types them for any other harness', async () => {
    const swarmSay = vi.fn(async (id: string) => ({ said: id === 'a1' }))
    const host = makeHost({ transcribe: vi.fn(async () => 'ship it'), route: vi.fn(), swarmSay })
    const { session, port } = await connect(host)
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' }); await settle()
      port.say({ t: 'voice.begin', uploadId: 'lead', agentId: 'a1' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(port.sent.find(x => x.t === 'voice.transcript')).toMatchObject({ agentId: 'a1', text: 'ship it' }))
      expect(swarmSay).toHaveBeenCalledWith('a1', 'ship it')
      expect(host.sendTurn).not.toHaveBeenCalled()
      port.say({ t: 'voice.begin', uploadId: 'tile', agentId: 'a2' })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
      await vi.waitFor(() => expect(host.sendTurn).toHaveBeenCalledWith('a2', 'ship it'))
    } finally { await session.stop() }
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

  describe('firmware retries', () => {
    const image = Buffer.alloc(2048, 9)
    const hi = { t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' }
    const host = () => makeHost({ firmwareFor: async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }) })
    const offers = (port: LoopbackPort) => port.types().filter((t) => t === 'fw.offer').length

    it('a declined offer is offered again at the next hello', async () => {
      const { session, port } = await connect(host())
      port.say(hi)
      await settle()
      port.say({ t: 'fw.error', message: 'busy' })
      await settle()
      port.say(hi)
      await settle()
      expect(offers(port)).toBe(2)
      await session.stop()
    })

    it('holds off after 3 attempts in an hour', async () => {
      const { session, port } = await connect(host())
      for (let i = 0; i < 4; i++) {
        port.say(hi)
        await settle()
        port.say({ t: 'fw.error', message: 'busy' })
        await settle()
      }
      expect(offers(port)).toBe(3)
      await session.stop()
    })

    it('never re-offers after fw.done, even if the dial greets with the old version again', async () => {
      const { session, port } = await connect(host())
      port.say(hi)
      await settle()
      port.say({ t: 'fw.done' })
      await settle()
      port.say(hi)
      await settle()
      expect(offers(port)).toBe(1)
      await session.stop()
    })

    it('a transfer whose acked bytes stop advancing for 30 s is over, and is offered again', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const seen: Array<{ updating?: string }> = []
        const { session, port } = await connect(makeHost({
          firmwareFor: async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }),
          onDialStatus: (s) => seen.push(s),
        }))
        port.say(hi)
        await vi.advanceTimersByTimeAsync(5)
        port.say({ t: 'fw.accept' })
        await vi.advanceTimersByTimeAsync(20_000)
        port.say({ t: 'fw.progress', written: 1024 })
        await vi.advanceTimersByTimeAsync(20_000)
        expect((session as unknown as { transfer: unknown }).transfer).not.toBeNull()
        await vi.advanceTimersByTimeAsync(11_000)
        expect((session as unknown as { transfer: unknown }).transfer).toBeNull()
        expect(seen.at(-1)?.updating).toBeFalsy()
        port.say(hi)
        await vi.advanceTimersByTimeAsync(5)
        expect(offers(port)).toBe(2)
        await session.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('logs "no image channel" once per device, not on every hello', async () => {
      const lines: string[] = []
      const { session, port } = await connect(makeHost({ firmwareFor: async () => null, log: (l: string) => lines.push(l) }))
      for (let i = 0; i < 3; i++) {
        port.say({ ...hi, hw: 'harness-pro', board: 'pro' })
        await settle()
      }
      expect(lines.filter((l) => l.includes('no image channel'))).toHaveLength(1)
      await session.stop()
    })
  })

  it('pro without ota gets no firmware offer', async () => {
    // The standalone Pro firmware says hw "harness-pro" like the old Player-1 Pro build. Without `ota: "v1"`
    // it cannot take an image: no lookup, no transfer.
    const image = Buffer.alloc(2048, 9)
    const firmwareFor = vi.fn(async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }))
    const host = makeHost({ firmwareFor })
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb', hw: 'harness-pro', board: 'pro' })
    await settle()

    expect(firmwareFor).not.toHaveBeenCalled()
    expect(port.types()).not.toContain('fw.offer')
    expect((session as unknown as { transfer: unknown }).transfer).toBeNull()
    await session.stop()
  })

  it('pro with ota v1 is offered the harness-pro entry', async () => {
    const image = Buffer.alloc(2048, 9)
    const firmwareFor = vi.fn(async (_v: string, _key: string) => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }))
    const { session, port } = await connect(makeHost({ firmwareFor }))
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb', hw: 'harness-pro', board: 'pro', ota: 'v1' })
    await settle()
    expect(firmwareFor).toHaveBeenCalledWith('0.0.1', 'harness-pro')
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)
    await session.stop()
  })

  it('a pro ota v1 session rewinds on fw.progress with resend and prefixes offsets', async () => {
    const image = Buffer.alloc(100_000, 9)
    const { session, port } = await connect(makeHost({ firmwareFor: async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }) }))
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb', hw: 'harness-pro', board: 'pro', ota: 'v1' })
    await settle()
    port.say({ t: 'fw.accept' })
    await settle()
    const xfer = (session as unknown as { transfer: { onResend: (n: number) => Promise<void> } }).transfer
    const spy = vi.spyOn(xfer, 'onResend')
    port.say({ t: 'fw.progress', written: 8188, resend: true })
    await settle()
    expect(spy).toHaveBeenCalledWith(8188)
    await session.stop()
  })

  it('hw harness-pro without board is not offered', async () => {
    const firmwareFor = vi.fn(async () => null)
    const { session, port } = await connect(makeHost({ firmwareFor }))
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb', hw: 'harness-pro' })
    await settle()
    expect(firmwareFor).not.toHaveBeenCalled()
    await session.stop()
  })

  it('reports the board it greeted with, and omits it for a round', async () => {
    const seen: Array<{ board?: string }> = []
    const { session, port } = await connect(makeHost({ onDialStatus: (s) => seen.push(s) }))
    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb', hw: 'harness-pro', board: 'pro' })
    await vi.waitFor(() => expect(seen.at(-1)?.board).toBe('pro'))
    await session.stop()
  })

  it('a round hello still gets its offer', async () => {
    const image = Buffer.alloc(2048, 9)
    const firmwareFor = vi.fn(async () => ({ version: '9.9.9', image, sha256: 'x'.repeat(64) }))
    const host = makeHost({ firmwareFor })
    const { session, port } = await connect(host)

    port.say({ t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb', hw: 'cst816s' })
    await settle()

    expect(firmwareFor).toHaveBeenCalledWith('0.0.1', 'commander')
    expect(port.types().filter((t) => t === 'fw.offer')).toHaveLength(1)
    await session.stop()
  })

  it('asks for a fresh release on a new dial, image or connection, and lets keepalives reuse one', async () => {
    const firmwareFor = vi.fn(async (_v: string, _key: string, _keepalive?: boolean) => null)
    const ports: LoopbackPort[] = []
    const session = new CableSession(makeHost({ firmwareFor }), tmpLog(), async (onData, onClosed) => {
      const p = new LoopbackPort(onData, onClosed)
      ports.push(p)
      return p
    })
    session.start()
    await vi.waitFor(() => expect(ports).toHaveLength(1))
    const hi = { t: 'hello', product: 'harness', fw: '0.0.1', proto: 2, mac: 'aa:bb' }
    for (const hello of [hi, hi, hi, { ...hi, fw: '0.0.2' }, { ...hi, fw: '0.0.2' }, { ...hi, fw: '0.0.2', mac: 'cc:dd' }]) {
      ports[0].say(hello)
      await settle()
    }
    await ports[0].close('unplugged')
    await vi.waitFor(() => expect(ports).toHaveLength(2), NEXT_TICKS)
    ports[1].say({ ...hi, fw: '0.0.2', mac: 'cc:dd' })
    await settle()
    expect(firmwareFor.mock.calls).toEqual([
      ['0.0.1', 'commander'], ['0.0.1', 'commander', true], ['0.0.1', 'commander', true],
      ['0.0.2', 'commander'], ['0.0.2', 'commander', true], ['0.0.2', 'commander'],
      ['0.0.2', 'commander'],
    ])
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

  it('focuses a remote pane before its machine connection answers', async () => {
    let selected = 'mac-local'
    let finishSelection!: () => void
    const gate = new Promise<void>(resolve => { finishSelection = resolve })
    const selectMachine = vi.fn(async (machineId: string) => {
      await gate
      selected = machineId
      return { ok: true as const }
    })
    const { session, port } = await connect(makeHost({
      selectedMachine: () => selected,
      selectMachine,
      listAgents: async () => [...AGENTS, { id: 'r1', name: 'Remote pane', machineId: 'remote-machine' }],
    }))
    let following: Promise<void> | undefined
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await settle()
      port.sent.length = 0
      following = session.followApp('remote-machine', 'r1')
      await settle()
      expect(selectMachine).toHaveBeenCalledWith('remote-machine')
      expect(selected).toBe('mac-local')
      expect(port.sent.filter(m => m.t === 'focus')).toEqual([{ t: 'focus', agentId: 'r1' }])
    } finally {
      finishSelection()
      await following
      await session.stop()
    }
  })

  it('follows the newest pane without waiting for an older machine selection', async () => {
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
    port.sent.length = 0
    const newestSelection = session.followApp('mac-local', 'a2')
    try {
      await settle()
      expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a2'])
      finishFirstSelection()
      await Promise.all([oldSelection, newestSelection])
      expect(port.sent.filter((m) => m.t === 'focus').map((m) => m.agentId)).toEqual(['a2'])
      expect(port.sent.filter((m) => m.t === 'machine.selected').map((m) => m.machineId)).toEqual(['mac-local'])
      expect(selected).toBe('mac-local')
    } finally {
      finishFirstSelection()
      await Promise.all([oldSelection, newestSelection])
      await session.stop()
    }
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

  it('settles the machine wheel when a newer pane uses the same pending connection', async () => {
    let selected = 'mac-local'
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const selectMachine = vi.fn(async (machineId: string) => {
      await gate
      selected = machineId
      return { ok: true as const }
    })
    const { session, port } = await connect(makeHost({ selectedMachine: () => selected, selectMachine }))
    const pending: Promise<void>[] = []
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await settle()
      pending.push(session.followApp('remote-machine', 'r1'))
      await settle()
      port.sent.length = 0
      pending.push(session.followApp('remote-machine', 'r2'))
      await settle()
      expect(port.sent.filter(m => m.t === 'focus')).toEqual([{ t: 'focus', agentId: 'r2' }])
      finish()
      await Promise.all(pending)
      expect(selectMachine).toHaveBeenCalledTimes(1)
      expect(port.sent.filter(m => m.t === 'machines.end').at(-1)).toMatchObject({ selected: 'remote-machine' })
      expect(port.sent.filter(m => m.t === 'focus')).toEqual([{ t: 'focus', agentId: 'r2' }])
    } finally { finish(); await Promise.all(pending); await session.stop() }
  })

  it.each(['refused', 'throws', 'disconnected'])(
    'keeps pane focus independent when a remote attachment is %s', async outcome => {
      let finish!: () => void
      const gate = new Promise<void>(resolve => { finish = resolve })
      const log = vi.fn()
      const { session, port } = await connect(makeHost({
        log,
        selectMachine: async () => {
          await gate
          if (outcome === 'throws') throw new Error('connection lost')
          if (outcome === 'refused') return { ok: false, code: 'UNREACHABLE', message: 'Remote unavailable' }
          return { ok: true }
        },
      }))
      let following: Promise<void> | undefined
      try {
        port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
        await settle()
        port.sent.length = 0
        following = session.followApp('remote-machine', 'r1')
        await settle()
        expect(port.sent.filter(m => m.t === 'focus')).toEqual([{ t: 'focus', agentId: 'r1' }])
        if (outcome === 'disconnected') await port.close()
        finish()
        await following
        if (outcome === 'disconnected') {
          expect(port.sent).toEqual([{ t: 'focus', agentId: 'r1' }])
        } else {
          if (outcome === 'refused') expect(port.sent).toContainEqual(expect.objectContaining({ t: 'machine.error', code: 'UNREACHABLE' }))
          else expect(log).toHaveBeenCalledWith('cable: could not follow app machine (connection lost)')
          await session.followApp('mac-local', 'a2')
          expect(port.sent.filter(m => m.t === 'focus').at(-1)).toEqual({ t: 'focus', agentId: 'a2' })
        }
      } finally { finish(); await following; await session.stop() }
    },
  )

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
    await session.summary('a2', 'recap two', 'body two', 'list')

    const sent = port.sent.filter((m) => m.t === 'summary' && !m.restore)
    // Absent, not false, on the ordinary path: firmware that predates the flag must keep notifying
    // exactly as it did, and it reads a missing field as false.
    expect(sent.find((m) => m.agentId === 'a1')).not.toHaveProperty('quiet')
    // The recap still travels — the tile draws it either way. Only the beep and the drawer are withheld.
    expect(sent.find((m) => m.agentId === 'a2')).toMatchObject({ quiet: true, recap: 'recap two' })

    // A sub-agent's turn: silent — no beep, no drawer row — and the recap still travels.
    await session.summary('a1', 'recap three', 'body three', 'silent', undefined, true)
    const silent = port.sent.filter((m) => m.t === 'summary' && m.agentId === 'a1').pop()
    expect(silent).toMatchObject({ silent: true, recap: 'recap three' })
    expect(silent).not.toHaveProperty('quiet')
  })

  it('sends the tier, with quiet for list and silent for silent, and neither for alert', async () => {
    const { session, port } = await connect(makeHost({}))
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    for (const tier of ['alert', 'list', 'silent'] as const) await session.summary('a1', `r ${tier}`, 'b', tier)
    const sent = port.sent.filter((m) => m.t === 'summary' && !m.restore)
    expect(sent.map((m) => [m.tier, m.quiet, m.silent])).toEqual([['alert', undefined, undefined], ['list', true, undefined], ['silent', undefined, true]])
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

  describe('custom pets', () => {
    const A = 'a'.repeat(16)
    const B = 'b'.repeat(16)
    const NEW = 'c'.repeat(16)
    /** A pack the size of two slices; the crc field is the u32 at offset 18, as in the real header. */
    const pack = (fill: number, size = 20_000) => { const b = Buffer.alloc(size, fill); b[4] = 1; b.writeUInt32LE(0xdeadbeef, 18); return b }
    const packs: Record<string, Buffer> = { [A]: pack(1), [B]: pack(2, 100), [NEW]: pack(3, 100) }
    /** The version 1 bytes of a pack, shorter and with their own crc: the id is the same. */
    const v1Packs: Record<string, Buffer> = {}
    const fakeStore = (mapping: { all: string | null; engines: Record<string, string> }) => {
      const store = {
        current: mapping,
        mapping: () => ({ all: store.current.all, engines: { ...store.current.engines } }),
        // A different size for each version, as the real store's bytes are; the asked version is kept for the specs.
        asked: [] as Array<[string, number | undefined]>,
        pack: async (id: string, version?: number) => {
          store.asked.push([id, version])
          return version === 1 ? v1Packs[id] ?? packs[id] : packs[id]
        },
      }
      return store
    }
    const hello = { t: 'hello', product: 'harness', fw: '0.0.1', proto: 3, mac: 'aa:bb' }
    const petTypes = (port: LoopbackPort) => port.types().filter((t) => t.startsWith('pet.'))

    it('hello without pets: no pet traffic', async () => {
      const store = fakeStore({ all: A, engines: {} })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say(hello)
      await settle()
      expect(petTypes(port)).toEqual([])
      expect(session.petDial()).toEqual({ supported: false, held: [], sending: null, errors: {} })
      await session.stop()
    })

    it('hello with pets:1 and petIds [] → pet.map then pet.offer for the first mapped pack', async () => {
      const store = fakeStore({ all: A, engines: { claude: B } })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      expect(port.sent.find((m) => m.t === 'pet.map')).toEqual({ t: 'pet.map', all: A, engines: { claude: B } })
      const offers = port.sent.filter((m) => m.t === 'pet.offer')
      // One transfer at a time: the second offer waits for pet.done of the first.
      expect(offers).toEqual([{ t: 'pet.offer', id: A, size: 20_000, crc: 0xdeadbeef }])
      expect(petTypes(port).slice(0, 2)).toEqual(['pet.map', 'pet.offer'])
      expect(port.types().indexOf('welcome')).toBeLessThan(port.types().indexOf('pet.map'))
      expect(port.petSlices).toHaveLength(0) // nothing before pet.accept
      port.say({ t: 'pet.accept', id: A })
      await settle()
      expect(port.petSlices.map((b) => b.length)).toEqual([8192, 8192]) // the 16 KB credit window
      expect(session.petDial().sending).toEqual({ id: A, percent: 0 })
      port.say({ t: 'pet.progress', id: A, written: 16384 })
      await settle()
      expect(Buffer.concat(port.petSlices).equals(packs[A])).toBe(true)
      expect(session.petDial().sending).toEqual({ id: A, percent: 81 })
      port.say({ t: 'pet.done', id: A })
      await settle()
      expect(session.petDial()).toEqual({ supported: true, held: [A], sending: { id: B, percent: 0 }, errors: {} })
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A, B])
      await session.stop()
    })

    it('a hello built before pet.done does not resend the pack it just stored', async () => {
      // Seen on a dial 2026-10-08: its greeting, assembled while the pack was still arriving, landed after the
      // pet.done and read as "holds nothing" — both packs went over twice.
      const store = fakeStore({ all: B, engines: {} })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      port.say({ t: 'pet.accept', id: B })
      await settle()
      port.say({ t: 'pet.done', id: B })
      await settle()
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([B])
      expect(session.petDial().held).toEqual([B])
      await session.stop()
    })

    it('a cut transfer is resent after reattach', async () => {
      const store = fakeStore({ all: B, engines: {} })
      const ports: LoopbackPort[] = []
      const session = new CableSession(makeHost({ pets: () => store as unknown as PetStore }), tmpLog(), async (onData, onClosed) => {
        const next = new LoopbackPort(onData, onClosed)
        ports.push(next)
        return next
      })
      session.start()
      await vi.waitFor(() => expect(ports).toHaveLength(1))
      ports[0].say({ ...hello, pets: 1, petIds: [] })
      await settle()
      ports[0].say({ t: 'pet.accept', id: B })
      await settle()
      expect(session.petDial().sending?.id).toBe(B)
      await ports[0].close('cable pulled')
      await settle()
      expect(session.petDial()).toEqual({ supported: false, held: [], sending: null, errors: {} })
      // The session's tick reopens the port; the dial greets again, having kept nothing of the cut pack.
      await vi.waitFor(() => expect(ports).toHaveLength(2), NEXT_TICKS)
      ports[1].say({ ...hello, pets: 1, petIds: [] })
      await settle()
      expect(ports[1].sent.filter((m) => m.t === 'pet.offer')).toEqual([{ t: 'pet.offer', id: B, size: 100, crc: 0xdeadbeef }])
      await session.stop()
    })

    it('pet.error memory → reported in petDial; the next hello forgives it, a crc refusal stays until the mapping changes', async () => {
      const store = fakeStore({ all: A, engines: { claude: B } })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      port.say({ t: 'pet.error', id: A, reason: 'memory' })
      await settle()
      expect(session.petDial().held).toEqual([])
      expect(session.petDial().errors).toEqual({ [A]: 'memory' })
      expect(session.petDial().sending?.id).toBe(B)
      // The next pack is still tried; the refused one is not retried by the sync itself.
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A, B])
      port.say({ t: 'pet.error', id: B, reason: 'crc' })
      await settle()
      expect(session.petDial().errors).toEqual({ [A]: 'memory', [B]: 'crc' })
      // A greeting forgives the moment's trouble (memory), not the pack the dial found wrong (crc).
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A, B, A])
      expect(session.petDial().errors).toEqual({ [B]: 'crc' })
      // A changed mapping clears everything.
      await session.petsChanged()
      expect(session.petDial().errors).toEqual({})
      await session.stop()
    })

    it('a hello that lost a held pack abandons the transfer in flight and offers again', async () => {
      const store = fakeStore({ all: A, engines: { claude: B } })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 1, petIds: [B] })
      await settle()
      port.say({ t: 'pet.accept', id: A })
      await settle()
      expect(session.petDial().sending?.id).toBe(A)
      port.say({ ...hello, pets: 1, petIds: [] }) // rebooted under the open link: it holds nothing
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A, A])
      expect(session.petDial().sending).toEqual({ id: A, percent: 0 })
      // A keepalive that merely does not list the pack in flight leaves it alone.
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer')).toHaveLength(2)
      await session.stop()
    })

    it('a memory refusal after a pet.drop is offered once more after 1.5 s', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const store = fakeStore({ all: A, engines: {} })
        const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
        port.say({ ...hello, pets: 1, petIds: [NEW] }) // the old pet goes, the new one comes
        await vi.advanceTimersByTimeAsync(5)
        expect(port.sent.filter((m) => m.t === 'pet.drop')).toEqual([{ t: 'pet.drop', id: NEW }])
        port.say({ t: 'pet.error', id: A, reason: 'memory' })
        await vi.advanceTimersByTimeAsync(1_000)
        expect(port.sent.filter((m) => m.t === 'pet.offer')).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(600)
        expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A, A])
        // Only once.
        port.say({ t: 'pet.error', id: A, reason: 'memory' })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(port.sent.filter((m) => m.t === 'pet.offer')).toHaveLength(2)
        await session.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('hello.pets is the newest pack version the dial reads', async () => {
      const store = fakeStore({ all: A, engines: {} })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 3, petIds: [] })
      await settle()
      expect(session.petDial().supported).toBe(true)
      expect(port.sent.filter((m) => m.t === 'pet.offer')).toHaveLength(1)
      await session.stop()
    })

    it('a dial that reads pets:1 gets the version 1 pack and pets:2 the version 2 one, of the same id', async () => {
      v1Packs[A] = pack(4, 19_000)
      v1Packs[A].writeUInt32LE(0x1111, 18)
      packs[A][4] = 2
      const offerFor = async (pets: number) => {
        const store = fakeStore({ all: A, engines: {} })
        const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
        port.say({ ...hello, pets, petIds: [] })
        await settle()
        const offers = port.sent.filter((m) => m.t === 'pet.offer')
        await session.stop()
        return { offers, asked: store.asked }
      }
      try {
        const one = await offerFor(1)
        expect(one.asked[0]).toEqual([A, 1])
        expect(one.offers).toEqual([{ t: 'pet.offer', id: A, size: 19_000, crc: 0x1111 }])
        const two = await offerFor(2)
        expect(two.asked[0]).toEqual([A, 2])
        expect(two.offers).toEqual([{ t: 'pet.offer', id: A, size: 20_000, crc: 0xdeadbeef }])
        // A dial newer than we are is given what we write.
        expect((await offerFor(5)).asked[0]).toEqual([A, 2])
      } finally {
        packs[A][4] = 1
        delete v1Packs[A]
      }
    })

    it('a pack newer than the dial reads is not offered', async () => {
      const store = fakeStore({ all: B, engines: {} })
      packs[B][4] = 2
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer')).toEqual([])
      packs[B][4] = 1
      await session.stop()
    })

    it('firmware offer pending → pet transfer waits', async () => {
      const store = fakeStore({ all: B, engines: {} })
      const host = makeHost({
        pets: () => store as unknown as PetStore,
        firmwareFor: async () => ({ version: '9.9.9', image: Buffer.alloc(2048, 9), sha256: 'x'.repeat(64) }),
      })
      const { session, port } = await connect(host)
      port.say({ ...hello, pets: 1, petIds: [] })
      await settle()
      expect(port.types()).toContain('fw.offer')
      expect(port.types()).toContain('pet.map') // the map is a message, not a transfer
      expect(port.types()).not.toContain('pet.offer')
      port.say({ t: 'fw.error', message: 'no' })
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([B])
      await session.stop()
    })

    it('a stalled pet transfer times out after 10 s without progress, records timeout, and moves on', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const store = fakeStore({ all: A, engines: { claude: B } })
        const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
        port.say({ ...hello, pets: 1, petIds: [] })
        await vi.advanceTimersByTimeAsync(5)
        expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A])
        await vi.advanceTimersByTimeAsync(9_000)
        // progress resets the timer
        port.say({ t: 'pet.accept', id: A })
        await vi.advanceTimersByTimeAsync(9_000)
        expect(session.petDial().errors).toEqual({})
        await vi.advanceTimersByTimeAsync(1_500)
        expect(session.petDial().errors).toEqual({ [A]: 'timeout' })
        expect(port.sent.filter((m) => m.t === 'pet.drop')).toEqual([{ t: 'pet.drop', id: A }])
        expect(session.petDial().sending?.id).toBe(B)
        expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A, B])
        await session.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('petsChanged during the firmwareFor await → no fw.offer once a pet transfer started', async () => {
      const store = fakeStore({ all: A, engines: {} })
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => { release = r })
      let calls = 0
      const host = makeHost({
        pets: () => store as unknown as PetStore,
        firmwareFor: async () => {
          calls++
          if (calls === 1) return null
          await gate
          return { version: '9.9.9', image: Buffer.alloc(2048, 9), sha256: 'x'.repeat(64) }
        },
      })
      const { session, port } = await connect(host)
      port.say({ ...hello, pets: 1, petIds: [A] }) // holds everything: nothing to send yet
      await settle()
      port.say({ ...hello, pets: 1, petIds: [A] }) // keepalive: parks inside firmwareFor
      await settle()
      expect(calls).toBe(2)
      store.current = { all: A, engines: { claude: B } }
      await session.petsChanged()
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([B])
      release()
      await settle()
      expect(port.types()).not.toContain('fw.offer')
      await session.stop()
    })

    it('a held pack that is no longer mapped is dropped on hello; the next missing pack is offered after pet.done', async () => {
      const store = fakeStore({ all: A, engines: { claude: B } })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 1, petIds: [NEW] })
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.drop')).toEqual([{ t: 'pet.drop', id: NEW }])
      port.say({ t: 'pet.done', id: A })
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([A, B])
      await session.stop()
    })

    it('petsChanged with a new mapping → pet.map resent and only the missing pack offered', async () => {
      const store = fakeStore({ all: B, engines: {} })
      const { session, port } = await connect(makeHost({ pets: () => store as unknown as PetStore }))
      port.say({ ...hello, pets: 1, petIds: [B] })
      await settle()
      expect(petTypes(port)).toEqual(['pet.map'])
      port.sent.length = 0
      store.current = { all: B, engines: { claude: NEW } }
      await session.petsChanged()
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.map')).toEqual([{ t: 'pet.map', all: B, engines: { claude: NEW } }])
      expect(port.sent.filter((m) => m.t === 'pet.offer').map((m) => m.id)).toEqual([NEW])
      // An unchanged mapping says nothing more.
      port.say({ t: 'pet.done', id: NEW })
      await settle()
      port.sent.length = 0
      await session.petsChanged()
      expect(petTypes(port)).toEqual([])
      // A pack nothing maps any more is dropped.
      store.current = { all: B, engines: {} }
      await session.petsChanged()
      await settle()
      expect(port.sent.filter((m) => m.t === 'pet.drop')).toEqual([{ t: 'pet.drop', id: NEW }])
      await session.stop()
    })
  })
})

// ── hello capabilities ────────────────────────────────────────────────────────────────────────────────
//
// The Harness Pro and the round dial are two clients of one daemon. What the hello NAMES decides what the
// daemon adds for that session; a hello that names nothing gets exactly the frames it always got.
describe('hello capabilities', () => {
  const PRO_HELLO = { t: 'hello', product: 'harness', mac: 'aa:bb', board: 'pro', swarms: 'members-v1',
    recap: 'long-v1', activity: 'steps-v1', player: 'library-v1' }
  const answer = '## Kết quả\n\n' + Array.from({ length: 500 }, (_, i) => `**từ${i}**`).join(' ')
  const uuid = (n: number) => `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-${'d'.repeat(12)}`
  const library = Array.from({ length: 71 }, (_, i) => ({ id: `session-${i}`, machineId: `machine-${i % 4}`,
    name: `Session ${i}`, engine: 'codex', status: 'paused' as const, lastActivityAt: Date.now() - 120_000 }))
  const swarmsOf = (agentIds: string[][]) => ({ selected: 't1', tiles: [] as never[],
    swarms: agentIds.map((ids, i) => ({ id: `t${i + 1}`, name: `Tab ${i + 1}`, agents: ids.length, agentIds: ids, panes: ids.length })) })
  const ofType = (port: LoopbackPort, t: string) => port.sent.filter((m) => m.t === t)
  /** The firmware's JSON guard counts one token per object, array, string (keys included) and bare value. */
  const jsonTokens = (value: unknown): number => {
    if (Array.isArray(value)) return 1 + value.reduce((n: number, v) => n + jsonTokens(v), 0)
    if (value && typeof value === 'object') return 1 + Object.entries(value).reduce((n, [, v]) => n + 1 + jsonTokens(v), 0)
    return 1
  }

  /** A host that offers everything a Pro could ask for, so only the hello decides what is sent. */
  function richHost(over: Partial<CableHost> = {}) {
    return makeHost({
      activityText: async () => 'Working',
      activitySnapshot: async () => ({ text: 'Working', action: 'Reading the spec', elapsedSeconds: 931 }),
      listSwarms: () => swarmsOf([['a1', 'a2'], ['a3']]),
      recentSummaries: async () => [{ recap: 'r', text: 'b', fullText: answer }],
      playerLibrary: async () => library,
      ...over,
    })
  }

  it('numbers every frame to a Pro with seq, restarting at each welcome; a round dial gets none', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ ...PRO_HELLO })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.turnDone('a1')
      expect(port.sent[0].t).toBe('welcome')
      expect(port.seqs).toEqual(port.seqs.map((_, i) => i))   // 0 on the welcome, then 1, 2, ... with no hole
      port.say({ ...PRO_HELLO })   // the keepalive hello: a new welcome, the count starts over
      await vi.waitFor(() => expect(port.sent.filter((m) => m.t === 'welcome')).toHaveLength(2))
      expect(port.seqs[port.sent.findLastIndex((m) => m.t === 'welcome')]).toBe(0)
      port.sent.length = 0
      port.seqs.length = 0
      port.say({ t: 'hello', product: 'harness', mac: 'cc:dd', hw: 'round' })   // another device, no board
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      expect(port.seqs.every((q) => q === undefined)).toBe(true)
    } finally { await session.stop() }
  })

  it('advertises resync in the welcome of a Pro only', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ ...PRO_HELLO })
      await vi.waitFor(() => expect(ofType(port, 'welcome')).toHaveLength(1))
      expect(ofType(port, 'welcome')[0].features).toContain('resync')
      port.sent.length = 0
      port.say({ t: 'hello', product: 'harness', mac: 'cc:dd', hw: 'round' })
      await vi.waitFor(() => expect(ofType(port, 'welcome')).toHaveLength(1))
      expect(ofType(port, 'welcome')[0].features).not.toContain('resync')
    } finally { await session.stop() }
  })

  it('answers resync with machines, swarms, agents, notices and open questions, at most once per 2 s', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ ...PRO_HELLO })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.question('a1', 'q1', [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'] }])
      await session.question('a2', 'q2', [{ key: 'k', q: 'Closed?', options: ['yes'] }])
      await session.questionClose('a2', 'q2')
      port.sent.length = 0
      port.say({ t: 'resync' })
      await vi.waitFor(() => expect(port.types()).toContain('question'))
      const types = port.types()
      for (const t of ['machines.begin', 'swarms', 'agents.begin', 'agents.end', 'notif.replace']) expect(types).toContain(t)
      expect(ofType(port, 'question')).toMatchObject([{ agentId: 'a1', id: 'q1' }])   // the closed one is not resent
      port.sent.length = 0
      port.say({ t: 'resync' })
      await settle()
      expect(port.sent).toEqual([])   // inside the window
    } finally { await session.stop() }
  })

  it('carries a Super Tab wait on the question frame, keeps its agent asking through its turns and resyncs it', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ ...PRO_HELLO, superTab: 'wait-v1' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      const asked = [{ q: 'Stuck: no access to staging' }]
      await session.question('a1', 'supertab:as1:blocked', asked, { superTab: 'Pilot', attention: 'stuck' })
      expect(ofType(port, 'question')).toMatchObject([{ agentId: 'a1', id: 'supertab:as1:blocked', questions: asked, superTab: 'Pilot', attention: 'stuck' }])
      // Not answerable on a device: nothing to read or review.
      port.say({ t: 'question.read', agentId: 'a1', requestId: 'read-1' })
      await vi.waitFor(() => expect(port.types()).toContain('question.state'))
      expect(ofType(port, 'question.state')[0]).toMatchObject({ ok: false })
      // It outlives the agent's turns on the device itself (the Pro keeps it): nothing is asked again, so it alerts
      // once, and the library page keeps the agent asking.
      port.sent.length = 0
      await session.turnStarted('a1')
      await session.summary('a1', 'Tried again.', 'Still no access.', 'list')
      await session.turnDone('a1')
      await session.turnError('a1', 'Failed')
      expect(port.types()).not.toContain('question')
      expect(port.types()).not.toContain('question.close')
      expect((session as unknown as { liveTurns: Map<string, string> }).liveTurns.get('a1')).toBe('question')
      // A resync shows it again, with the tab.
      port.sent.length = 0
      port.say({ t: 'resync' })
      await vi.waitFor(() => expect(port.types()).toContain('question'))
      expect(ofType(port, 'question')).toMatchObject([{ agentId: 'a1', id: 'supertab:as1:blocked', superTab: 'Pilot', attention: 'stuck' }])
      // A Pro whose session came back asks for the agents, having dropped its questions: the wait is asked again.
      port.sent.length = 0
      port.say({ t: 'agents.list' })
      await vi.waitFor(() => expect(port.types()).toContain('question'))
      expect(ofType(port, 'question')).toMatchObject([{ agentId: 'a1', id: 'supertab:as1:blocked', superTab: 'Pilot' }])
      // Closed with no turn open, it leaves the agent idle, not working; closed mid-turn, the turn goes on.
      const live = (session as unknown as { liveTurns: Map<string, string> }).liveTurns
      await session.questionClose('a1', 'supertab:as1:other')   // not the wait it holds: nothing
      expect(live.get('a1')).toBe('question')
      await session.questionClose('a1', 'supertab:as1:blocked')
      expect(live.has('a1')).toBe(false)
      await session.question('a1', 'supertab:as1:needs_human', asked, { superTab: 'Pilot', attention: 'decision' })
      await session.turnStarted('a1')
      await session.questionClose('a1', 'supertab:as1:needs_human')
      expect(live.get('a1')).toBe('working')
      await session.turnDone('a1')
      expect(live.has('a1')).toBe(false)
      // An engine's question in its place is a plain one.
      await session.question('a2', 'supertab:as2:needs_human', [{ q: 'Which?' }], { superTab: 'Pilot', attention: 'decision' })
      await session.question('a2', 'tool-1', [{ key: 'k', q: 'Go?', options: ['yes'] }])
      await session.turnDone('a2')
      expect((session as unknown as { liveTurns: Map<string, string> }).liveTurns.has('a2')).toBe(false)
      // Without a Super Tab, the frame is as it always was.
      await session.question('a3', 'tool-2', [{ key: 'k', q: 'Go?', options: ['yes'] }])
      expect(ofType(port, 'question').at(-1)).not.toHaveProperty('superTab')
    } finally { await session.stop() }
  })

  it('sends Super Tab waits only to a device that says it shows them', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ ...PRO_HELLO })   // a Pro from before the wait, or a round dial: it would offer an answer screen
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.question('a1', 'supertab:as1:blocked', [{ q: 'Stuck: no key' }], { superTab: 'Pilot', attention: 'stuck' })
      await session.questionClose('a1', 'supertab:as1:blocked')
      port.say({ t: 'agents.list' })
      await settle()
      expect(port.types()).not.toContain('question')
      expect(port.types()).not.toContain('question.close')
    } finally { await session.stop() }
  })

  it('sends turn.stats only to a stats: turn-v1 device, and only when there is something to say', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ ...PRO_HELLO, stats: 'turn-v1' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.turnStats('a', {})
      expect(port.sent).toEqual([])
      await session.turnStats('a', { commits: 1 })
      expect(port.sent.map((m) => JSON.stringify(m))).toEqual(['{"t":"turn.stats","agentId":"a","commits":1}'])
      port.sent.length = 0
      await session.turnStats('a', { tokensIn: 5, tokensOut: 7 })
      expect(port.sent.map((m) => JSON.stringify(m))).toEqual(['{"t":"turn.stats","agentId":"a","tokensIn":5,"tokensOut":7}'])
      port.sent.length = 0
      port.say({ ...PRO_HELLO })   // a later hello that does not name it switches it off again
      await vi.waitFor(() => expect(port.types()).toContain('welcome'))
      port.sent.length = 0
      await session.turnStats('a', { commits: 1 })
      expect(port.sent).toEqual([])
    } finally { await session.stop() }
  })

  it('round hello gets no Pro fields', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      // A turn with prose and tool cards, a summary carrying the whole answer, and a library request.
      await session.turnStarted('a1', 'Processing', 'Looking at the spec first')
      await session.turnStep('a1', 'Read · cableSession.ts')
      await session.summary('a1', 'r', 'b', 'alert', answer)
      port.say({ t: 'player.library.get', offset: 0, request: 1 }); await settle()
      await session.syncSwarms(true)

      // Byte-for-byte what main sent before the capabilities existed.
      expect(port.sent.map((m) => JSON.stringify(m))).toEqual([
        '{"t":"turn.started","agentId":"a1","text":"Processing"}',
        '{"t":"turn.activity","agentId":"a1","text":"Working"}',
        '{"t":"summary","agentId":"a1","name":"Fix login screen","engine":"claude","machine":"","recap":"r","text":"b","tier":"alert"}',
        '{"t":"swarms","selected":"t1","items":[{"id":"t1","name":"Tab 1","agents":2,"panes":2},{"id":"t2","name":"Tab 2","agents":1,"panes":1}],"tiles":[]}',
      ])
    } finally { await session.stop() }
  })

  it('round hello gets no Pro fields in the greeting or the restores either', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      expect(port.sent[0].features).toEqual(['voice.draft', 'agents.refresh', 'settings'])
      expect(port.types().some((t) => t.startsWith('player.'))).toBe(false)
      const text = port.sent.map((m) => JSON.stringify(m)).join('\n')
      for (const key of ['"full"', '"members"', '"agentIds"', '"step"', '"action"', '"elapsedSeconds"']) expect(text).not.toContain(key)
      expect(ofType(port, 'summary').filter((m) => m.restore).length).toBeGreaterThan(0)
    } finally { await session.stop() }
  })

  it('does not re-push swarms for a reorder a round dial cannot see', async () => {
    let swarms = swarmsOf([['a', 'b']])
    const { session, port } = await connect(makeHost({ listSwarms: () => swarms }))
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(ofType(port, 'swarms')).toHaveLength(1))
      swarms = swarmsOf([['b', 'a']])
      await session.syncSwarms()
      expect(ofType(port, 'swarms')).toHaveLength(1)
    } finally { await session.stop() }
  })

  it('pro hello gets steps', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.turnStarted('a1', 'Processing', 'Looking at the spec first')
      await session.turnStep('a1', 'Read · cableSession.ts')
      expect(port.sent).toEqual([
        { t: 'turn.started', agentId: 'a1', text: 'Processing' },
        // The first activity right after the start: the latest paragraph the agent wrote.
        { t: 'turn.activity', agentId: 'a1', text: 'Processing', action: 'Looking at the spec first' },
        { t: 'turn.activity', agentId: 'a1', text: 'Working', action: 'Reading the spec', elapsedSeconds: 931 },
        { t: 'turn.activity', agentId: 'a1', text: '', step: 'Read · cableSession.ts' },
      ])
    } finally { await session.stop() }
  })

  it('turnReply sends the streamed paragraph as action to a steps-v1 device, clipped to a codepoint boundary', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.turnReply('a1', 'Reading the spec')
      await session.turnReply('a1', 'é'.repeat(250))
      expect(port.sent[0]).toEqual({ t: 'turn.activity', agentId: 'a1', text: '', action: 'Reading the spec' })
      const action = port.sent[1].action as string
      expect(Buffer.byteLength(action, 'utf8')).toBeLessThanOrEqual(188)
      expect(action).toMatch(/^é+\u2026$/)
    } finally { await session.stop() }
  })

  it('turnReply tells a round device nothing', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.turnReply('a1', 'Reading the spec')
      expect(port.sent).toEqual([])
    } finally { await session.stop() }
  })

  it('pro hello keeps elapsed seconds and the action inside what the device accepts', async () => {
    const reading = { value: { text: 'Working', action: 'é'.repeat(300), elapsedSeconds: 2_592_001 } as { text: string; action?: string; elapsedSeconds?: number } }
    const { session, port } = await connect(richHost({ activitySnapshot: async () => reading.value }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.turnStarted('a1')
      const act = port.sent.find((m) => m.t === 'turn.activity') as { action: string; elapsedSeconds?: number }
      expect(Buffer.byteLength(act.action)).toBeLessThanOrEqual(188)
      expect(act.action.endsWith('…')).toBe(true)
      expect(act).not.toHaveProperty('elapsedSeconds')
      for (const bad of [-1, 1.5, Number.NaN]) {
        port.sent.length = 0
        reading.value = { text: 'Working', elapsedSeconds: bad }
        await session.turnStarted('a1')
        expect(port.sent.find((m) => m.t === 'turn.activity')).toEqual({ t: 'turn.activity', agentId: 'a1', text: 'Working' })
      }
    } finally { await session.stop() }
  })

  it('discards the action and timer when a completed turn supersedes the read', async () => {
    let finish!: (value: { text: string; action: string; elapsedSeconds: number }) => void
    const { session, port } = await connect(richHost({ activitySnapshot: () => new Promise((resolve) => { finish = resolve }) }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      const pending = session.turnStarted('a1'); await settle()
      await session.turnDone('a1')
      finish({ text: 'Working', action: 'Read · old.ts', elapsedSeconds: 100 }); await pending
      expect(port.sent.some((m) => m.t === 'turn.activity')).toBe(false)
    } finally { await session.stop() }
  })

  it('round hello reads the footer through activityText, whatever activitySnapshot does', async () => {
    const snapshot = vi.fn(async () => { throw new Error('UNKNOWN_QUERY') })
    const { session, port } = await connect(makeHost({ activityText: async () => 'Reading', activitySnapshot: snapshot }))
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.turnStarted('a1', 'Processing')
      expect(port.sent).toEqual([{ t: 'turn.started', agentId: 'a1', text: 'Processing' }, { t: 'turn.activity', agentId: 'a1', text: 'Reading' }])
      expect(snapshot).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it('pro hello drops the full text rather than send a summary over the frame cap', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.summary('a1', 'r', 'x'.repeat(7_900), 'alert', 'y'.repeat(1_000))
      const frame = ofType(port, 'summary').at(-1)!
      expect(frame.text).toBe('x'.repeat(7_900))
      expect(frame).not.toHaveProperty('full')
      expect(port.closedWith).toBeNull()
    } finally { await session.stop() }
  })

  it('pro hello drops the full text of a restore that would not fit', async () => {
    const { session, port } = await connect(richHost({ recentSummaries: async () => [{ recap: 'r', text: 'x'.repeat(7_900), fullText: 'y'.repeat(1_000) }] }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(ofType(port, 'summary').filter((m) => m.restore).length).toBeGreaterThan(0))
      expect(ofType(port, 'summary').filter((m) => m.restore)[0]).not.toHaveProperty('full')
      expect(port.closedWith).toBeNull()
    } finally { await session.stop() }
  })

  it('pro hello does not wait on the host for an answer the card did not carry', async () => {
    const { session, port } = await connect(richHost({ recentSummaries: () => new Promise(() => {}) }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
      const before = Date.now()
      await session.summary('a1', 'r', 'b')
      expect(Date.now() - before).toBeLessThan(3_000)
      expect(ofType(port, 'summary').at(-1)).not.toHaveProperty('full')
    } finally { await session.stop() }
  }, 10_000)

  it('pro hello caps tabs and ids to what the device holds, and stays under the byte and token limits', async () => {
    const tabs = Array.from({ length: 30 }, (_, t) => Array.from({ length: 40 }, (_, i) => `t${t}-${i}`))
    const swarms = { ...swarmsOf(tabs), selected: 't28' }
    const { session, port } = await connect(makeHost({ listSwarms: () => swarms, describe: (id) => ({ name: id, engine: 'claude', machine: 'M' }) }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(ofType(port, 'swarms')).toHaveLength(1))
      const frame = ofType(port, 'swarms')[0] as { selected: string; items: Array<{ id: string; agentIds?: string[] }> }
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(8192 - 256)
      expect(jsonTokens(frame)).toBeLessThanOrEqual(480)
      expect(frame.selected).toBe('t28')
      expect(frame.items.length).toBeLessThanOrEqual(24)
      expect(frame.items.some((i) => i.id === 't28')).toBe(true)
      for (const i of frame.items) expect((i.agentIds ?? []).length).toBeLessThanOrEqual(24)
    } finally { await session.stop() }
  })

  it('pro hello gets full recap', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.summary('a1', 'Kết quả', 'Kết quả', 'alert', answer)
      const frame = ofType(port, 'summary').at(-1) as { full: string }
      expect(frame.full.length).toBeLessThanOrEqual(1200)
      expect(Buffer.byteLength(frame.full)).toBeLessThanOrEqual(3600)
      expect(frame.full.endsWith('…')).toBe(true)
      expect(frame.full).not.toContain('*')
      expect(frame.full.startsWith('Kết quả từ0 từ1')).toBe(true)
      // `recap` and `text` are what a round dial gets, unchanged.
      expect(frame).toMatchObject({ recap: 'Kết quả', text: 'Kết quả' })
      for (const f of port.frames) expect(f.length).toBeLessThanOrEqual(CABLE_MAX_FRAME)
    } finally { await session.stop() }
  })

  it('pro hello reads the whole answer from the host when the card did not carry it', async () => {
    const { session, port } = await connect(richHost({ recentSummaries: async () => [{ recap: 'r', text: 'b', fullText: 'The complete answer.' }] }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.summary('a1', 'r', 'b')
      expect(ofType(port, 'summary').at(-1)).toMatchObject({ full: 'The complete answer.' })
      // A stored turn that is not this one is not this one's answer.
      await session.summary('a1', 'r', 'another body')
      expect(ofType(port, 'summary').at(-1)).not.toHaveProperty('full')
    } finally { await session.stop() }
  })

  it('pro hello carries full on restores and omits it when there is no text', async () => {
    const history = [{ recap: 'r', text: 'b', fullText: answer }, { recap: 'old', text: 'old' }]
    const { session, port } = await connect(richHost({ recentSummaries: async () => history }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(ofType(port, 'summary').filter((m) => m.restore).length).toBeGreaterThan(1))
      const restores = ofType(port, 'summary').filter((m) => m.restore) as Array<{ recap: string; full?: string }>
      expect(restores.find((m) => m.recap === 'r')!.full!.endsWith('…')).toBe(true)
      expect(restores.find((m) => m.recap === 'old')).not.toHaveProperty('full')
      for (const f of port.frames) expect(f.length).toBeLessThanOrEqual(CABLE_MAX_FRAME)
    } finally { await session.stop() }
  })

  it('pro hello gets members', async () => {
    const away: CableMachine = { id: 'm2', name: "Diego's Mac", state: 'offline', local: false }
    const who: Record<string, { name: string; engine: string; machine: string }> = {
      mine: { name: 'Devin', engine: 'claude', machine: LOCAL_ROW.name },
      far: { name: 'Stylist', engine: 'codex', machine: "Diego's Mac" },
    }
    const swarms = swarmsOf([['mine', 'far', 'ghost']])
    const { session, port } = await connect(makeHost({
      listSwarms: () => swarms,
      listMachines: async () => ({ machines: [LOCAL_ROW, away], source: 'backend' as const }),
      describe: (id) => who[id],
    }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(ofType(port, 'swarms')).toHaveLength(1))
      const item = (ofType(port, 'swarms')[0] as { items: Array<Record<string, unknown>> }).items[0]
      expect(item.agentIds).toEqual(['mine', 'far', 'ghost'])
      // An id nobody has heard of has no entry; the rest say where they live, and whether that is reachable.
      expect(item.members).toEqual([
        { id: 'mine', name: 'Devin', engine: 'claude', machine: LOCAL_ROW.name, online: true },
        { id: 'far', name: 'Stylist', engine: 'codex', machine: "Diego's Mac", online: false },
      ])
    } finally { await session.stop() }
  })

  it('pro hello sends every tab its ids, and a plain hello none', async () => {
    const swarms = swarmsOf([['a', 'b'], ['c']])
    const pro = await connect(makeHost({ listSwarms: () => swarms }))
    pro.port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', swarms: 'members-v1' })
    await vi.waitFor(() => expect(ofType(pro.port, 'swarms')).toHaveLength(1))
    expect((ofType(pro.port, 'swarms')[0] as { items: Array<{ id: string; agentIds: string[] }> }).items.map((i) => [i.id, i.agentIds]))
      .toEqual([['t1', ['a', 'b']], ['t2', ['c']]])
    await pro.session.stop()
    const plain = await connect(makeHost({ listSwarms: () => swarms }))
    plain.port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
    await vi.waitFor(() => expect(ofType(plain.port, 'swarms')).toHaveLength(1))
    expect((ofType(plain.port, 'swarms')[0] as { items: Array<Record<string, unknown>> }).items)
      .toEqual([{ id: 't1', name: 'Tab 1', agents: 2, panes: 2 }, { id: 't2', name: 'Tab 2', agents: 1, panes: 1 }])
    await plain.session.stop()
  })

  it('a capability is a positive string match: anything else is off', async () => {
    for (const value of [undefined, '', 'members-v2', 1, true, ['members-v1']]) {
      const { session, port } = await connect(makeHost({ listSwarms: () => swarmsOf([['a']]) }))
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', swarms: value })
      await vi.waitFor(() => expect(ofType(port, 'swarms')).toHaveLength(1))
      expect((ofType(port, 'swarms')[0] as { items: Array<Record<string, unknown>> }).items[0]).not.toHaveProperty('agentIds')
      await session.stop()
    }
  })

  it('keeps the swarms frame under the cap, shrinking members, then ids, then to the selected tab', async () => {
    const tabs = Array.from({ length: 24 }, (_, t) => Array.from({ length: 24 }, (_, i) => uuid(t * 100 + i)))
    const swarms = { ...swarmsOf(tabs), selected: 't6' }
    const describe = (id: string) => ({ name: `name of ${id}`.padEnd(60, 'x'), engine: 'claude', machine: 'A machine with a long name' })
    const { session, port } = await connect(makeHost({ listSwarms: () => swarms, describe }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(ofType(port, 'swarms')).toHaveLength(1))
      const frame = ofType(port, 'swarms')[0] as { items: Array<{ id: string; agents: number; agentIds?: string[]; members?: unknown[] }> }
      for (const f of port.frames) expect(f.length).toBeLessThanOrEqual(CABLE_MAX_FRAME)
      expect(frame.items).toHaveLength(24)
      expect(frame.items.every((i) => i.members === undefined)).toBe(true)
      expect(frame.items.find((i) => i.id === 't6')!.agentIds).toEqual(tabs[5])
      expect(frame.items.find((i) => i.id === 't7')!.agentIds).toBeUndefined()
      expect(frame.items.find((i) => i.id === 't7')!.agents).toBe(24)
      expect(port.closedWith).toBeNull()
    } finally { await session.stop() }
  })

  it('drops member names before ids when the frame is over the firmware\'s token budget', async () => {
    const tabs = [0, 1].map((t) => Array.from({ length: 24 }, (_, i) => `agent-${t}-${i}`))
    const describe = (id: string) => ({ name: `name of ${id}`, engine: 'claude', machine: 'A machine' })
    const { session, port } = await connect(makeHost({ listSwarms: () => swarmsOf(tabs), describe }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(ofType(port, 'swarms')).toHaveLength(1))
      const items = (ofType(port, 'swarms')[0] as { items: Array<Record<string, unknown>> }).items
      expect(items.map((i) => i.agentIds)).toEqual(tabs)
      expect(items.every((i) => i.members === undefined)).toBe(true)
    } finally { await session.stop() }
  })

  it('pro hello pushes again when a member\'s machine goes offline or an agent moves', async () => {
    let state: CableMachine['state'] = 'ready'
    let swarms = swarmsOf([['far', 'b'], ['c']])
    const { session, port } = await connect(makeHost({
      listSwarms: () => swarms,
      listMachines: async () => ({ machines: [LOCAL_ROW, { id: 'm2', name: 'Far', state, local: false }], source: 'backend' as const }),
      describe: (id) => id === 'far' ? { name: 'Stylist', engine: 'codex', machine: 'Far' } : undefined,
    }))
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(ofType(port, 'swarms')).toHaveLength(1))
      state = 'offline'
      await session.syncSwarms()
      const sent = ofType(port, 'swarms') as Array<{ items: Array<{ members: Array<{ online: boolean }> }> }>
      expect(sent).toHaveLength(2)
      expect([sent[0].items[0].members[0].online, sent[1].items[0].members[0].online]).toEqual([true, false])
      swarms = swarmsOf([['b', 'far'], ['c']])      // a reorder inside the tab: same counts, same shape
      await session.syncSwarms()
      expect(ofType(port, 'swarms')).toHaveLength(3)
    } finally { await session.stop() }
  })

  it('pro hello gets the library, 6 rows a page', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('player.library'))
      expect(port.sent[0].features).toContain('player.library')
      const first = ofType(port, 'player.library')[0] as { rows: unknown[] }
      expect(first).toMatchObject({ total: 71, offset: 0, request: 0 })
      expect(first.rows).toHaveLength(6)
      port.say({ t: 'player.library.get', offset: 65, request: 3 })
      await vi.waitFor(() => expect(ofType(port, 'player.library').at(-1)).toMatchObject({ offset: 65, request: 3 }))
      const page = ofType(port, 'player.library').at(-1)!
      expect((page.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(library.slice(65).map((r) => r.id))
      expect(ofType(port, 'agent')).not.toContainEqual(expect.objectContaining({ id: 'session-70' }))
      expect(Math.max(...port.frames.map((f) => f.length))).toBeLessThan(CABLE_MAX_FRAME)
    } finally { await session.stop() }
  })

  it('library rows say working or question while this daemon has seen the turn live, the host status after', async () => {
    const { session, port } = await connect(richHost())
    const statusOf = (id: string) => ((ofType(port, 'player.library').at(-1)!.rows as Array<{ id: string; status: string }>)
      .find((r) => r.id === id))?.status
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('player.library'))
      expect(statusOf('session-0')).toBe('paused')
      await session.turnStarted('session-0')
      await session.turnStep('session-1', 'Read · a.ts')
      await session.syncPlayerLibrary(true)
      expect([statusOf('session-0'), statusOf('session-1')]).toEqual(['working', 'working'])
      await session.question('session-0', 'q1', [{ key: 'k', q: 'Go?', options: ['Yes'] }])
      await session.syncPlayerLibrary(true)
      expect(statusOf('session-0')).toBe('question')
      await session.questionClose('session-0', 'q1')
      await session.syncPlayerLibrary(true)
      expect(statusOf('session-0')).toBe('working')        // answered: the turn goes on
      await session.summary('session-0', 'Sub done.', 'Sub done.', 'silent', undefined, true)
      await session.syncPlayerLibrary(true)
      expect(statusOf('session-0')).toBe('working')        // a sub-agent's end is not the turn's
      await session.turnDone('session-0')
      await session.turnError('session-1', 'boom')
      await session.syncPlayerLibrary(true)
      expect([statusOf('session-0'), statusOf('session-1')]).toEqual(['paused', 'paused'])
    } finally { await session.stop() }
  })

  it('ignores a malformed library request, and the capability resets with the port', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('player.library'))
      const before = ofType(port, 'player.library').length
      for (const bad of [{ offset: -1, request: 1 }, { offset: 1_000_001, request: 1 }, { offset: 0, request: 4294967296 }, { offset: 1.5, request: 1 }, { offset: 0 }]) {
        port.say({ t: 'player.library.get', ...bad })
      }
      await settle()
      expect(ofType(port, 'player.library')).toHaveLength(before)
      await port.close('reconnect')
    } finally { await session.stop() }
    // A round dial on the next connection is not served the library, whatever the last one asked.
    const round = await connect(richHost())
    try {
      round.port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })
      await vi.waitFor(() => expect(round.port.types()).toContain('notif.replace'))
      round.port.say({ t: 'player.library.get', offset: 0, request: 1 }); await settle()
      expect(round.port.types()).not.toContain('player.library')
    } finally { await round.session.stop() }
  })

  it('offers the library only when the host can list it', async () => {
    const { session, port } = await connect(makeHost())
    try {
      port.say(PRO_HELLO)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      expect(port.sent[0].features).not.toContain('player.library')
      expect(port.types()).not.toContain('player.library')
    } finally { await session.stop() }
  })

  describe('link counters in the dial log', () => {
    const linkLines = (log: DialLog) => readFileSync(log.currentPath, 'utf8').split('\n').filter((l) => l.includes('[daemon] link'))

    it('logs bytes and frames both ways at close, and keeps the printable text of non-frame bytes', async () => {
      const log = tmpLog()
      const { session, port } = await connect(makeHost(), log)
      try {
        port.say({ t: 'hello', product: 'harness', fw: '0.1.0', proto: 1, mac: 'aa:bb' })
        await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
        port.raw(Buffer.concat([Buffer.from('Guru Meditation Error: Core 0 panic\x00\x01ab\x02'), Buffer.from([0xa5])]))
        port.say({ t: 'hello', product: 'harness', mac: 'aa:bb' })   // a frame after the noise still decodes
        await settle()
        await port.close('unplugged')
        await log.flush()
      } finally { await session.stop() }
      const [line] = linkLines(log)
      const sentBytes = port.frames.reduce((n, f) => n + f.length, 0)
      expect(line).toContain('link at close')
      expect(line).toContain(`tx ${sentBytes} B in ${port.frames.length} frames`)
      expect(line).toMatch(/rx \d+ B in 2 frames/)
      expect(line).toMatch(/discarded \d+ B/)
      expect(line).toContain('non-frame text: Guru Meditation Error: Core 0 panic')
      expect(line).not.toContain('ab')   // a two-character run is not text worth keeping
    })

    it('logs once a minute while connected, and caps the text at 200 characters', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const log = tmpLog()
      const { session, port } = await connect(makeHost(), log)
      try {
        port.say({ t: 'hello', product: 'harness', fw: '0.1.0', proto: 1, mac: 'aa:bb' })
        await vi.waitFor(() => expect(port.types()).toContain('agents.end'))
        port.raw(Buffer.from('x'.repeat(500) + '\n'))
        vi.setSystemTime(Date.now() + 61_000)
        await vi.waitFor(async () => { await log.flush(); expect(linkLines(log).length).toBeGreaterThan(0) }, NEXT_TICKS)
      } finally { vi.useRealTimers(); await session.stop() }
      const [line] = linkLines(log)
      expect(line).toMatch(/\] link · tx \d+ B in \d+ frames · rx \d+ B in 1 frames/)
      expect(line.split('non-frame text: ')[1]).toHaveLength(200)
    })
  })
})

// ── swarm cards (a Pro that names swarmCard: 'v1') ────────────────────────────────────────────────────
describe('swarm cards', () => {
  const PRO = { t: 'hello', product: 'harness', mac: 'aa:bb', board: 'pro', swarmCard: 'v1' }
  const lead = (n: number, over: Partial<SwarmLead> = {}): SwarmLead => ({ projectId: `proj${n}`, project: `Project ${n}`, engine: 'claude', owner: '', local: '', state: 'work', order: n, since: 134, ...over, id: over.id ?? `lead${n}` })
  const card = (id: string, leads: SwarmLead[] = [lead(1), lead(2)], over: Partial<SwarmCard> = {}): SwarmCard => ({ id, name: `Swarm ${id}`, count: leads.length, leads, ...over })
  const ofType = (port: LoopbackPort, t: string) => port.sent.filter((m) => m.t === t)
  /** The firmware's JSON guard counts one token per object, array, string (keys included) and bare value. */
  const tokens = (value: unknown): number => {
    if (Array.isArray(value)) return 1 + value.reduce((n: number, v) => n + tokens(v), 0)
    if (value && typeof value === 'object') return 1 + Object.entries(value).reduce((n, [, v]) => n + 1 + tokens(v), 0)
    return 1
  }
  const desk = (...rows: Array<{ id: string; superTabId?: string }>) => ({ selected: rows[0]?.id ?? '', tiles: [] as never[],
    swarms: rows.map((r) => ({ name: r.id, agents: 0, agentIds: [] as string[], panes: 0, ...r })) })

  /** A host whose cards, desk tab and window project the test moves. */
  function cardHost(state: { cards: SwarmCard[] | null; desk?: ReturnType<typeof desk>; open?: { superTabId: string; projectId: string; conversationId?: string; fromDevice: boolean } | null } , over: Partial<CableHost> = {}) {
    return makeHost({
      swarmCards: () => state.cards,
      listSwarms: () => state.desk ?? desk(),
      activeSwarmProject: () => state.open ?? null,
      swarmCardsWanted: vi.fn(), swarmCardOpen: vi.fn(), superTabSelected: vi.fn(),
      swarmCardRecap: vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: 'Shipped it.', at: 1792560000, none: false })),
      ...over,
    })
  }

  it('sends nothing, asks for nothing and answers nothing to a device that does not name swarmCard', async () => {
    const state = { cards: [card('st1')] }
    const host = cardHost(state)
    const { session, port } = await connect(host)
    try {
      port.say({ ...PRO, swarmCard: undefined })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.syncSwarmCards(true)
      await session.swarmCardRecap({ tabId: 'st1', leadId: 'lead1', text: 'x', at: 1, none: false })
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
      port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' })
      port.say({ t: 'supertab.select', tab: 'st1', lead: 'lead1' })
      await settle(); await settle()
      expect(port.types().filter((t) => t.startsWith('supertab'))).toEqual([])
      expect(host.swarmCardsWanted).not.toHaveBeenCalled()
      expect(host.swarmCardRecap).not.toHaveBeenCalled()
      expect(host.swarmCardOpen).not.toHaveBeenCalled()
      expect(host.superTabSelected).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it('on attach: asks for the cards once, then supertabs and one supertab per Swarm, linked to the desk tab', async () => {
    const state = { cards: [card('st1'), card('st2')], desk: desk({ id: 'tab9', superTabId: 'st2' }, { id: 'tab1' }) }
    const host = cardHost(state)
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(2))
      port.say(PRO)   // a repeat hello is a keepalive
      await settle()
      expect(host.swarmCardsWanted).toHaveBeenCalledExactlyOnceWith(true)
      expect(ofType(port, 'supertabs')).toEqual([{ t: 'supertabs', ids: ['st1', 'st2'] }])
      expect(ofType(port, 'supertab')).toEqual([
        { t: 'supertab', id: 'st1', tab: '', name: 'Swarm st1', count: 2, leads: [
          { id: 'lead1', projectId: 'proj1', project: 'Project 1', engine: 'claude', owner: '', local: '', state: 'work', order: 1, since: 134 },
          { id: 'lead2', projectId: 'proj2', project: 'Project 2', engine: 'claude', owner: '', local: '', state: 'work', order: 2, since: 134 }] },
        expect.objectContaining({ id: 'st2', tab: 'tab9' }),
      ])
      // The list goes first, so the Pro knows the order the details fill.
      expect(port.types().indexOf('supertabs')).toBeLessThan(port.types().indexOf('supertab'))
      // Gone: the core is told the last capable device left.
      await port.close('unplugged')
      expect(host.swarmCardsWanted).toHaveBeenLastCalledWith(false)
      expect(host.swarmCardsWanted).toHaveBeenCalledTimes(2)
    } finally { await session.stop() }
  })

  it('on attach before the cards were read: no supertabs at all, then the real list once it comes; an empty one read is sent', async () => {
    // A daemon that had just started told the dial "no Swarms" before the core had read them, and the dial left the Swarm
    // on its face for TABS; the list came 2 s later (Diego, 2026-10-29).
    const state = { cards: null as SwarmCard[] | null }
    const host = cardHost(state)
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(host.swarmCardsWanted).toHaveBeenCalledWith(true))
      await settle(); await settle()
      expect(ofType(port, 'supertabs')).toEqual([])
      expect(ofType(port, 'supertab')).toEqual([])
      state.cards = [card('st1'), card('st2')]
      await session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(2))
      expect(ofType(port, 'supertabs')).toEqual([{ t: 'supertabs', ids: ['st1', 'st2'] }])
      // Read and empty: there are no Swarms, and the dial is told so.
      state.cards = []
      await session.syncSwarmCards(true)
      expect(ofType(port, 'supertabs').at(-1)).toEqual({ t: 'supertabs', ids: [] })
    } finally { await session.stop() }
  })

  it('cards still not read 10 s after attach: the dial is told no Swarms rather than keep a list nobody vouches for', async () => {
    // A daemon that came back signed out never reads them, and a dial that kept its link would show the old Swarms on.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const state = { cards: null as SwarmCard[] | null }
      const { session, port } = await connect(cardHost(state))
      port.say(PRO)
      await vi.advanceTimersByTimeAsync(9_000)
      expect(ofType(port, 'supertabs')).toEqual([])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(ofType(port, 'supertabs')).toEqual([{ t: 'supertabs', ids: [] }])
      // Read later: the real list follows.
      state.cards = [card('st1')]
      await session.syncSwarmCards()
      await vi.advanceTimersByTimeAsync(300)
      expect(ofType(port, 'supertabs').at(-1)).toEqual({ t: 'supertabs', ids: ['st1'] })
      // Read in time: no empty list at all.
      const fresh = { cards: null as SwarmCard[] | null }
      const second = await connect(cardHost(fresh))
      second.port.say(PRO)
      await vi.advanceTimersByTimeAsync(2_000)
      fresh.cards = [card('st1')]
      await second.session.syncSwarmCards()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ofType(second.port, 'supertabs')).toEqual([{ t: 'supertabs', ids: ['st1'] }])
      await session.stop(); await second.session.stop()
    } finally { vi.useRealTimers() }
  })

  it('still sends the cards, with no tab link, when the desktop is closed', async () => {
    const host = cardHost({ cards: [card('st1')] })   // listSwarms: no window
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      expect(ofType(port, 'supertab')[0].tab).toBe('')
      expect(ofType(port, 'supertab.focus')).toEqual([])
    } finally { await session.stop() }
  })

  it('a change is held 300 ms, then only the changed Swarm goes (and supertabs only when the set moved)', async () => {
    const state = { cards: [card('st1'), card('st2')] } as { cards: SwarmCard[]; desk?: ReturnType<typeof desk> }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(2))
      port.sent.length = 0
      state.cards = [card('st1'), card('st2', [lead(1, { state: 'ask' }), lead(2)])]
      void session.syncSwarmCards()
      void session.syncSwarmCards()
      await settle()
      expect(port.sent).toEqual([])
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1), NEXT_TICKS)
      await settle()
      expect(port.types()).toEqual(['supertab'])
      expect(port.sent[0]).toMatchObject({ id: 'st2' })
      // A Swarm gone and one new: the set changed, so supertabs again, and only the new one's details.
      port.sent.length = 0
      state.cards = [card('st2', [lead(1, { state: 'ask' }), lead(2)]), card('st3')]
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1), NEXT_TICKS)
      expect(port.sent.map((m) => [m.t, m.id ?? m.ids])).toEqual([['supertabs', ['st2', 'st3']], ['supertab', 'st3']])
      // Nothing changed: nothing sent.
      port.sent.length = 0
      void session.syncSwarmCards()
      await new Promise((r) => setTimeout(r, 450))
      expect(port.types().filter((t) => t.startsWith('supertab'))).toEqual([])
    } finally { await session.stop() }
  })

  it('the desk opening the Swarm tab links it: only that Swarm is sent again', async () => {
    const state = { cards: [card('st1'), card('st2')], desk: desk() }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(2))
      port.sent.length = 0
      state.desk = desk({ id: 'tab7', superTabId: 'st1' })
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1), NEXT_TICKS)
      expect(port.sent).toMatchObject([{ t: 'supertab', id: 'st1', tab: 'tab7' }])
    } finally { await session.stop() }
  })

  it('a 16 x 12 list is one supertabs and 16 supertab frames, each under 512 JSON tokens', async () => {
    const wide = 'é'.repeat(24)   // 48 bytes
    const cards = Array.from({ length: 18 }, (_, s) => card(`st${s}`,
      Array.from({ length: 13 }, (_, l) => lead(l, { project: wide, owner: wide, local: 'a'.repeat(64), engine: 'codex', id: `l${s}x${l}`, projectId: `p${l}`, order: 100 + l })),
      { name: wide, count: 40 }))
    const { session, port } = await connect(cardHost({ cards }))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(16))
      await settle()
      expect(ofType(port, 'supertabs')).toHaveLength(1)
      expect((ofType(port, 'supertabs')[0].ids as string[]).length).toBe(16)
      const frames = port.sent.map((m, i) => ({ ...m, seq: port.seqs[i] } as Record<string, unknown>)).filter((m) => m.t === 'supertabs' || m.t === 'supertab')
      expect(frames).toHaveLength(17)
      for (const f of frames) expect(tokens(f)).toBeLessThan(512)
      for (const f of ofType(port, 'supertab')) expect((f.leads as Array<{ order: number }>).map((l) => l.order)).toEqual(Array.from({ length: 12 }, (_, l) => 100 + l))
      expect(Math.max(...frames.map(tokens))).toBeLessThan(260)
    } finally { await session.stop() }
  })

  it('a round dial naming both capabilities gets the Swarms with no seq, and Super Tab waits on question', async () => {
    const { session, port } = await connect(cardHost({ cards: [card('st1', [lead(1, { order: 3 }), lead(2, { order: 0 })])] }))
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'cc:dd', swarmCard: 'v1', superTab: 'wait-v1' })
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      expect(ofType(port, 'supertabs')).toEqual([{ t: 'supertabs', ids: ['st1'] }])
      expect((ofType(port, 'supertab')[0].leads as Array<{ id: string; order: number }>).map((l) => [l.id, l.order])).toEqual([['lead1', 3], ['lead2', 0]])
      expect(port.seqs.every((seq) => seq === undefined)).toBe(true)
      await session.question('a1', 'supertab:as1:needs_human', [{ q: 'Which?' }], { superTab: 'Pilot', attention: 'decision' })
      expect(ofType(port, 'question')).toMatchObject([{ agentId: 'a1', id: 'supertab:as1:needs_human', superTab: 'Pilot', attention: 'decision' }])
      expect(port.seqs.every((seq) => seq === undefined)).toBe(true)
    } finally { await session.stop() }
  })

  it('resync sends everything again, as attach does', async () => {
    const state = { cards: [card('st1')], open: { superTabId: 'st1', projectId: 'proj2', fromDevice: false } }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(1))
      port.sent.length = 0
      port.say({ t: 'resync' })
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(1))
      expect(port.types().filter((t) => t.startsWith('supertab'))).toEqual(['supertabs', 'supertab', 'supertab.focus'])
    } finally { await session.stop() }
  })

  it('supertab.recap.get asks for the recap and answers with supertab.recap; a failed read answers nothing', async () => {
    const state = { cards: [card('st1')] }
    const host = cardHost(state)
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead2' })
      await vi.waitFor(() => expect(ofType(port, 'supertab.recap')).toEqual([
        { t: 'supertab.recap', tab: 'st1', lead: 'lead2', text: 'Shipped it.', at: 1792560000, none: false }]))
      expect(host.swarmCardRecap).toHaveBeenCalledWith('st1', 'lead2')
      for (const failure of [async () => null, async () => { throw new Error('boom') }]) {
        port.sent.length = 0
        vi.mocked(host.swarmCardRecap!).mockImplementationOnce(failure)
        port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
        await settle(); await settle()
        expect(ofType(port, 'supertab.recap')).toEqual([])
      }
      // Ids that are not ids are not asked about.
      vi.mocked(host.swarmCardRecap!).mockClear()
      port.say({ t: 'supertab.recap.get', tab: 'st 1', lead: 'lead1' })
      port.say({ t: 'supertab.recap.get', tab: 'st1' })
      port.say({ t: 'supertab.recap.get', lead: 'lead1' })
      await settle(); await settle()
      expect(host.swarmCardRecap).not.toHaveBeenCalled()
    } finally { await session.stop() }
  })

  it('supertab.open tells the core which Lead is open, and a pushed recap reaches the device only for that Lead', async () => {
    const host = cardHost({ cards: [card('st1')] })
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      const recap = (leadId: string, text: string) => ({ tabId: 'st1', leadId, text, at: 5, none: false })
      await session.swarmCardRecap(recap('lead1', 'before open'))
      expect(ofType(port, 'supertab.recap')).toEqual([])
      port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' }); await settle()
      expect(host.swarmCardOpen).toHaveBeenLastCalledWith(expect.stringMatching(/^c\d+$/), 'st1', 'lead1')
      await session.swarmCardRecap(recap('lead2', 'other lead'))
      await session.swarmCardRecap({ ...recap('lead1', 'other tab'), tabId: 'st2' })
      expect(ofType(port, 'supertab.recap')).toEqual([])
      await session.swarmCardRecap(recap('lead1', 'now'))
      expect(ofType(port, 'supertab.recap')).toEqual([{ t: 'supertab.recap', tab: 'st1', lead: 'lead1', text: 'now', at: 5, none: false }])
      // Closed: no more pushes.
      port.say({ t: 'supertab.open', tab: 'st1', lead: '' }); await settle()
      expect(host.swarmCardOpen).toHaveBeenLastCalledWith(expect.stringMatching(/^c\d+$/), 'st1', null)
      await session.swarmCardRecap(recap('lead1', 'after close'))
      expect(ofType(port, 'supertab.recap')).toHaveLength(1)
      // An open with a Lead but a bad tab is ignored.
      port.say({ t: 'supertab.open', tab: 'a b', lead: 'lead1' }); await settle()
      expect(host.swarmCardOpen).toHaveBeenCalledTimes(2)
    } finally { await session.stop() }
  })

  it('names the Swarm of the open Lead on a scroll, so the window scrolls that Swarm\'s chat; none once it closed', async () => {
    const host = cardHost({ cards: [card('st1')] })
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'scroll', phase: 'move', dy: 5 }); await settle()
      expect(host.scrolled).toHaveBeenLastCalledWith('move', 5, 0)
      port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' }); await settle()
      port.say({ t: 'scroll', phase: 'move', dy: -12 }); await settle()
      expect(host.scrolled).toHaveBeenLastCalledWith('move', -12, 0, 'st1')
      port.say({ t: 'supertab.open', tab: 'st1', lead: '' }); await settle()
      port.say({ t: 'scroll', phase: 'up', dy: 0, v: 300 }); await settle()
      expect(host.scrolled).toHaveBeenLastCalledWith('up', 0, 300)
    } finally { await session.stop() }
  })

  it('an unplugged Pro with a recap open closes it for the core', async () => {
    const host = cardHost({ cards: [card('st1')] })
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' }); await settle()
      await port.close('unplugged')
      expect(host.swarmCardOpen).toHaveBeenLastCalledWith(expect.stringMatching(/^c\d+$/), 'st1', null)
    } finally { await session.stop() }
  })

  it('follows the window: one supertab.focus with that project\'s Lead, none on repeat, none without a Swarm tab', async () => {
    const state = { cards: [card('st1')], open: null as { superTabId: string; projectId: string; fromDevice: boolean } | null }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      expect(ofType(port, 'supertab.focus')).toEqual([])   // the active tab is not a Swarm
      state.open = { superTabId: 'st1', projectId: 'proj2', fromDevice: false }
      await session.syncSwarmCards(true)
      expect(ofType(port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: 'lead2' }])
      void session.syncSwarmCards()
      await new Promise((r) => setTimeout(r, 450))
      expect(ofType(port, 'supertab.focus')).toHaveLength(1)   // the same project: not again
      state.open = { superTabId: 'st1', projectId: 'proj1', fromDevice: false }
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(2), NEXT_TICKS)
      expect(ofType(port, 'supertab.focus')[1]).toMatchObject({ lead: 'lead1' })
      // The window leaves the Swarm tab and comes back: that is a change.
      state.open = null
      void session.syncSwarmCards()
      await new Promise((r) => setTimeout(r, 450))
      state.open = { superTabId: 'st1', projectId: 'proj1', fromDevice: false }
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(3), NEXT_TICKS)
    } finally { await session.stop() }
  })

  it('a Swarm tab with no project open still takes the dial into that Swarm: a focus with no Lead, again after away and back', async () => {
    const state = { cards: [card('st1')], open: null as { superTabId: string; projectId: string; fromDevice: boolean } | null }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      state.open = { superTabId: 'st1', projectId: '', fromDevice: false }
      await session.syncSwarmCards(true)
      expect(ofType(port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: '' }])
      void session.syncSwarmCards()
      await new Promise((r) => setTimeout(r, 450))
      expect(ofType(port, 'supertab.focus')).toHaveLength(1)   // the same Swarm: not again
      state.open = null
      void session.syncSwarmCards()
      await new Promise((r) => setTimeout(r, 450))
      state.open = { superTabId: 'st1', projectId: '', fromDevice: false }
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(2), NEXT_TICKS)
      // A project opened on it later is a change, and names its Lead.
      state.open = { superTabId: 'st1', projectId: 'proj2', fromDevice: false }
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(3), NEXT_TICKS)
      expect(ofType(port, 'supertab.focus')[2]).toEqual({ t: 'supertab.focus', tab: 'st1', lead: 'lead2' })
    } finally { await session.stop() }
  })

  it('a Swarm the list does not hold yet sends no focus at all, and is entered when it arrives', async () => {
    const state = { cards: [] as SwarmCard[], open: { superTabId: 'st1', projectId: '', fromDevice: false } }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertabs')).toHaveLength(1))
      expect(ofType(port, 'supertab.focus')).toEqual([])
      state.cards = [card('st1')]
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: '' }]), NEXT_TICKS)
    } finally { await session.stop() }
  })

  it('logs why each Swarm focus was or was not sent, once per change', async () => {
    const lines: string[] = []
    const state = { cards: [] as SwarmCard[], open: null as { superTabId: string; projectId: string; fromDevice: boolean } | null }
    const { session, port } = await connect(cardHost(state, { log: (l) => lines.push(l) }))
    const focusLines = () => lines.filter((l) => l.startsWith('cable: swarm focus'))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertabs')).toHaveLength(1))
      expect(focusLines()).toEqual(['cable: swarm focus · not a Swarm tab'])
      state.open = { superTabId: 'st1', projectId: 'proj2', fromDevice: false }
      await session.syncSwarmCards(true)
      await session.syncSwarmCards(true)   // the same answer again is not logged again
      expect(focusLines()).toEqual(['cable: swarm focus · not a Swarm tab', 'cable: swarm focus st1/proj2 · held: no such Swarm in the list'])
      state.cards = [card('st1', [lead(1)])]
      await session.syncSwarmCards(true)
      expect(focusLines().at(-1)).toBe('cable: swarm focus st1/proj2 · held: no Lead for that project')
      state.cards = [card('st1')]
      await session.syncSwarmCards(true)
      expect(focusLines().at(-1)).toBe('cable: swarm focus st1/proj2 → lead2')
      void session.syncSwarmCards()
      await new Promise((r) => setTimeout(r, 450))
      expect(focusLines().at(-1)).toBe('cable: swarm focus st1/proj2 · already sent')
      state.open = { superTabId: 'st1', projectId: '', fromDevice: false }
      await session.syncSwarmCards(true)
      expect(focusLines().at(-1)).toBe('cable: swarm focus st1 (no project) → its Leads')
      state.open = null
      await session.syncSwarmCards(true)
      expect(focusLines().at(-1)).toBe('cable: swarm focus · not a Swarm tab')
      expect(focusLines()).toHaveLength(7)
    } finally { await session.stop() }
  })

  it('logs a focus sent again after the dial came back on new firmware, though the line is the same', async () => {
    const lines: string[] = []
    const state = { cards: [card('st1')], open: { superTabId: 'st1', projectId: 'proj2', fromDevice: false } as { superTabId: string; projectId: string; fromDevice: boolean } | null }
    const { session, port } = await connect(cardHost(state, { log: (l) => lines.push(l) }))
    const sent = () => lines.filter((l) => l === 'cable: swarm focus st1/proj2 → lead2')
    try {
      port.say({ ...PRO, fw: '0.0.93' })
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(1))
      expect(sent()).toHaveLength(1)
      // Diego's dial, 2026-10-28: the update rebooted it and it greeted again on 0.0.94. The focus went again, unlogged.
      port.say({ ...PRO, fw: '0.0.94' })
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toHaveLength(2))
      expect(sent()).toHaveLength(2)
    } finally { await session.stop() }
  })

  it('a project the list does not hold yet is followed when the list arrives', async () => {
    const state = { cards: [] as SwarmCard[], open: { superTabId: 'st1', projectId: 'proj1', fromDevice: false } }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertabs')).toHaveLength(1))
      expect(ofType(port, 'supertab.focus')).toEqual([])
      state.cards = [card('st1')]
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: 'lead1' }]), NEXT_TICKS)
    } finally { await session.stop() }
  })

  it('supertab.select opens the Lead\'s project on the desktop, and the announce that follows is not echoed back', async () => {
    const state = { cards: [card('st1')], open: null as { superTabId: string; projectId: string; fromDevice: boolean } | null }
    const host = cardHost(state)
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.select', tab: 'st1', lead: 'lead2' }); await settle()
      expect(host.superTabSelected).toHaveBeenCalledExactlyOnceWith('st1', 'proj2')
      // The window answers with that project, marked or not: no focus comes back.
      state.open = { superTabId: 'st1', projectId: 'proj2', fromDevice: true }
      await session.syncSwarmCards(true)
      expect(ofType(port, 'supertab.focus')).toEqual([])
      state.open = { superTabId: 'st1', projectId: 'proj2', fromDevice: false }
      void session.syncSwarmCards()
      await new Promise((r) => setTimeout(r, 450))
      expect(ofType(port, 'supertab.focus')).toEqual([])
      // …but a later move by the person at the desk is followed (once the pick's 2 s are over).
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2100)
      state.open = { superTabId: 'st1', projectId: 'proj1', fromDevice: false }
      void session.syncSwarmCards()
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: 'lead1' }]), NEXT_TICKS)
      // An unknown Lead is not opened.
      port.say({ t: 'supertab.select', tab: 'st1', lead: 'nobody' }); await settle()
      expect(host.superTabSelected).toHaveBeenCalledTimes(1)
    } finally { vi.restoreAllMocks(); await session.stop() }
  })

  it('another Pro still follows an announce a device caused: only the Pro that picked is spared the echo', async () => {
    const state = { cards: [card('st1')], open: null as { superTabId: string; projectId: string; fromDevice: boolean } | null }
    const host = cardHost(state)
    const one = await connect(host), two = await connect(host)
    try {
      one.port.say(PRO); two.port.say(PRO)
      await vi.waitFor(() => expect(ofType(one.port, 'supertab')).toHaveLength(1))
      await vi.waitFor(() => expect(ofType(two.port, 'supertab')).toHaveLength(1))
      one.port.say({ t: 'supertab.select', tab: 'st1', lead: 'lead2' }); await settle()
      state.open = { superTabId: 'st1', projectId: 'proj2', fromDevice: true }
      await one.session.syncSwarmCards(true)
      await two.session.syncSwarmCards(true)
      expect(ofType(one.port, 'supertab.focus')).toEqual([])
      expect(ofType(two.port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: 'lead2' }])
    } finally { await one.session.stop(); await two.session.stop() }
  })

  it('holds off the desktop\'s stale announce of another project for 2 s after a pick, then follows it', async () => {
    const state = { cards: [card('st1')], open: null as { superTabId: string; projectId: string; fromDevice: boolean } | null }
    const { session, port } = await connect(cardHost(state))
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000_000)
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.select', tab: 'st1', lead: 'lead2' }); await settle()
      state.open = { superTabId: 'st1', projectId: 'proj1', fromDevice: false }   // what the window said before it heard the pick
      now.mockReturnValue(1_001_500)
      await session.syncSwarmCards(true)
      expect(ofType(port, 'supertab.focus')).toEqual([])
      now.mockReturnValue(1_002_100)
      await session.syncSwarmCards(true)
      expect(ofType(port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: 'lead1' }])
    } finally { now.mockRestore(); await session.stop() }
  })

  it('names each cable session to the core, so one Pro closing its recap does not close another\'s', async () => {
    const host = cardHost({ cards: [card('st1')] })
    const one = await connect(host), two = await connect(host)
    try {
      one.port.say(PRO); two.port.say(PRO)
      await vi.waitFor(() => expect(ofType(two.port, 'supertab')).toHaveLength(1))
      one.port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' }); await settle()
      two.port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' }); await settle()
      const opened = vi.mocked(host.swarmCardOpen!).mock.calls
      expect(opened[0][0]).not.toBe(opened[1][0])
      one.port.say({ t: 'supertab.open', tab: 'st1', lead: '' }); await settle()
      expect(vi.mocked(host.swarmCardOpen!).mock.calls.at(-1)).toEqual([opened[0][0], 'st1', null])
    } finally { await one.session.stop(); await two.session.stop() }
  })

  it('answers a repeat of the same recap request inside a second from the first read, not a second one', async () => {
    const host = cardHost({ cards: [card('st1')] })
    const { session, port } = await connect(host)
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(5_000_000)
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' }); await settle(); await settle()
      // Dropping it left a dial that had emptied its face waiting 5 s for its own retry (Diego, 2026-10-29).
      now.mockReturnValue(5_000_200)
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' }); await settle(); await settle()
      expect(host.swarmCardRecap).toHaveBeenCalledTimes(1)
      expect(ofType(port, 'supertab.recap').map((f) => [f.tab, f.lead])).toEqual([['st1', 'lead1'], ['st1', 'lead1']])
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead2' }); await settle(); await settle()
      expect(host.swarmCardRecap).toHaveBeenCalledTimes(2)
      now.mockReturnValue(5_001_100)
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' }); await settle(); await settle()
      expect(host.swarmCardRecap).toHaveBeenCalledTimes(3)
    } finally { now.mockRestore(); await session.stop() }
  })

  it('a repeat after a pushed recap is read again, never answered with the older read', async () => {
    const recaps = vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: 'A', at: 1, none: false }))
    const host = cardHost({ cards: [card('st1')] }, { swarmCardRecap: recaps })
    const { session, port } = await connect(host)
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(5_000_000)
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' })
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' }); await settle(); await settle()
      await session.swarmCardRecap({ tabId: 'st1', leadId: 'lead1', text: 'B', at: 2, none: false })
      recaps.mockResolvedValueOnce({ tabId: 'st1', leadId: 'lead1', text: 'B', at: 2, none: false })
      now.mockReturnValue(5_000_200)
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' }); await settle(); await settle()
      expect(recaps).toHaveBeenCalledTimes(2)
      expect(ofType(port, 'supertab.recap').map((f) => f.text)).toEqual(['A', 'B', 'B'])
    } finally { now.mockRestore(); await session.stop() }
  })

  it('reads a repeat again once the Lead left the cards, and a read that throws answers nothing', async () => {
    const state = { cards: [card('st1')] }
    const recaps = vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: 'Shipped it.', at: 1792560000, none: false }))
    const host = cardHost(state, { swarmCardRecap: recaps })
    const { session, port } = await connect(host)
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(5_000_000)
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' }); await settle(); await settle()
      // Access went inside the second: the first answer is not handed out again, the host is asked and refuses.
      state.cards = []
      recaps.mockResolvedValueOnce(null as never)
      now.mockReturnValue(5_000_200)
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' }); await settle(); await settle()
      expect(recaps).toHaveBeenCalledTimes(2)
      expect(ofType(port, 'supertab.recap')).toHaveLength(1)
      recaps.mockImplementationOnce(() => { throw new Error('boom') })
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead2' }); await settle(); await settle()
      expect(ofType(port, 'supertab.recap')).toHaveLength(1)
      expect(port.isOpen).toBe(true)
    } finally { now.mockRestore(); await session.stop() }
  })

  it('shortens a recap on a character until its frame is within 6 KB', async () => {
    const big = '日'.repeat(500) + '"\n'.repeat(1500)   // escapes make the JSON far bigger than the text
    const host = cardHost({ cards: [card('st1')] }, { swarmCardRecap: vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: big, at: 5, none: false })) })
    const { session, port } = await connect(host)
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
      await vi.waitFor(() => expect(ofType(port, 'supertab.recap')).toHaveLength(1))
      const frame = ofType(port, 'supertab.recap')[0]
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(6 * 1024)
      expect(String(frame.text).length).toBeGreaterThan(100)
      expect(big.startsWith(String(frame.text))).toBe(true)
      expect(String(frame.text)).not.toContain('\uFFFD')
      expect(recapFrame({ tabId: 't', leadId: 'l', text: 'short', at: 1, none: false })).toMatchObject({ text: 'short' })
    } finally { await session.stop() }
  })

  it('a Pro with no pick of its own that is told of a device\'s announce follows it, even when the list is fresh', async () => {
    const state = { cards: [card('st1')], open: { superTabId: 'st1', projectId: 'proj2', fromDevice: true } }
    const { session, port } = await connect(cardHost(state))
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertab.focus')).toEqual([{ t: 'supertab.focus', tab: 'st1', lead: 'lead2' }]))
    } finally { await session.stop() }
  })

  it('a host without the card hooks still greets a Pro', async () => {
    const { session, port } = await connect(makeHost())
    try {
      port.say(PRO)
      await vi.waitFor(() => expect(ofType(port, 'supertabs')).toEqual([{ t: 'supertabs', ids: [] }]))
      port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' })
      port.say({ t: 'supertab.select', tab: 'st1', lead: 'lead1' })
      port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
      await settle(); await settle()
      expect(ofType(port, 'supertab.recap')).toEqual([])
    } finally { await session.stop() }
  })

  // ── swarmChat: 'v1' (a round dial that follows the chat, design 2026-10-28-round-dial-swarm-chat) ─────────────
  describe('swarmChat', () => {
    const ROUND = { t: 'hello', product: 'harness', mac: 'cc:dd', swarmCard: 'v1', superTab: 'wait-v1', swarmChat: 'v1' }
    const pmChat = { kind: 'pm' as const, id: 'pm1', name: 'PM', working: false }
    const group = { kind: 'group' as const, id: 'g1', name: 'Fix login', working: true, since: 9 }
    const notice = (id = 'n1', over: Record<string, unknown> = {}) => ({ chat: 'pm' as const, chatId: 'pm1', id, text: `From the PM ${id}`, at: 1792560000, ...over })
    const noticeFrame = (id = 'n1') => ({ t: 'supertab.notice', tab: 'st1', lead: 'lead1', chat: 'pm', chatId: 'pm1', id, text: `From the PM ${id}`, at: 1792560000 })
    const voice = (port: LoopbackPort, agentId: string) => {
      port.say({ t: 'voice.begin', uploadId: `u-${agentId}`, agentId })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
    }

    it('a device without swarmChat gets today\'s frames', async () => {
      for (const hello of [PRO, { ...ROUND, swarmChat: undefined }]) {
        const cards = [card('st1', [lead(1, { state: 'ask', chat: pmChat, notice: notice() }), lead(2, { chat: group })])]
        const swarmSay = vi.fn(async () => ({ said: true as const }))
        const host = cardHost({ cards }, { transcribe: vi.fn(async () => 'ship it'), route: vi.fn(), swarmSay })
        const { session, port } = await connect(host)
        try {
          port.say(hello)
          await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
          expect(ofType(port, 'supertab')[0].leads).toEqual([
            { id: 'lead1', projectId: 'proj1', project: 'Project 1', engine: 'claude', owner: '', local: '', state: 'ask', order: 1, since: 134 },
            { id: 'lead2', projectId: 'proj2', project: 'Project 2', engine: 'claude', owner: '', local: '', state: 'work', order: 2, since: 134 }])
          await session.syncSwarmCards()
          await new Promise((r) => setTimeout(r, 350))
          expect(port.types().filter((t) => t.startsWith('supertab.notice'))).toEqual([])
          // The recap and the open are asked as today, and the talk goes to the Lead's conversation.
          port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
          port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' })
          await vi.waitFor(() => expect(ofType(port, 'supertab.recap')).toHaveLength(1))
          expect(vi.mocked(host.swarmCardRecap!).mock.calls).toEqual([['st1', 'lead1']])
          expect(vi.mocked(host.swarmCardOpen!).mock.calls.at(-1)).toEqual([expect.stringMatching(/^c\d+$/), 'st1', 'lead1'])
          expect(ofType(port, 'supertab.recap')[0]).toEqual({ t: 'supertab.recap', tab: 'st1', lead: 'lead1', text: 'Shipped it.', at: 1792560000, none: false })
          // A chat's recap is not this device's.
          await session.swarmCardRecap({ tabId: 'st1', leadId: 'lead1', text: 'the chat', at: 5, none: false, chatId: 'pm1' })
          expect(ofType(port, 'supertab.recap')).toHaveLength(1)
          voice(port, 'a1')
          await vi.waitFor(() => expect(swarmSay).toHaveBeenCalled())
          expect(swarmSay.mock.calls[0]).toEqual(['a1', 'ship it'])
        } finally { await session.stop() }
      }
    })

    it('a swarmChat device gets chat, chatId, chatName and work only for a working group', async () => {
      const cards = [card('st1', [
        lead(1, { state: 'ask', chat: pmChat }),
        lead(2, { chat: group }),
        lead(3, { chat: { kind: 'lead', id: 'lead-c3', name: 'Lead', working: false } }),
        lead(4, { state: 'stuck', chat: { ...group, id: 'g4', working: false, since: undefined } }),
        lead(5, { state: 'stuck' }),
      ])]
      const { session, port } = await connect(cardHost({ cards }))
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        const base = (n: number) => ({ id: `lead${n}`, projectId: `proj${n}`, project: `Project ${n}`, engine: 'claude', owner: '', local: '', order: n })
        expect(ofType(port, 'supertab')[0].leads).toEqual([
          { ...base(1), state: 'done', chat: 'pm', chatId: 'pm1', chatName: 'PM' },
          { ...base(2), state: 'work', since: 9, chat: 'group', chatId: 'g1', chatName: 'Fix login' },
          { ...base(3), state: 'done', chat: 'lead', chatId: 'lead-c3', chatName: 'Lead' },
          { ...base(4), state: 'done', chat: 'group', chatId: 'g4', chatName: 'Fix login' },
          // A Lead whose chat did not come through reads as its Lead chat, and never as ask or stuck.
          { ...base(5), state: 'done' },
        ])
      } finally { await session.stop() }
    })

    it('sends a notice once per id', async () => {
      const state = { cards: [card('st1', [lead(1, { chat: pmChat })])] }
      const { session, port } = await connect(cardHost(state))
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n1') })])]
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab.notice')).toEqual([noticeFrame('n1')]))
        // The Lead goes first: the dial has it before the alert that names it.
        expect(port.types().lastIndexOf('supertab')).toBeLessThan(port.types().indexOf('supertab.notice'))
        await session.syncSwarmCards()
        await new Promise((r) => setTimeout(r, 350))
        expect(ofType(port, 'supertab.notice')).toHaveLength(1)
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n2') })])]
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab.notice')).toEqual([noticeFrame('n1'), noticeFrame('n2')]))
      } finally { await session.stop() }
    })

    it('replays a held notice without sending it', async () => {
      const state = { cards: [card('st1', [lead(1, { chat: pmChat, notice: notice('n1') })])] }
      const { session, port } = await connect(cardHost(state))
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        await settle(); await settle()
        port.say({ t: 'resync' })
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(2))
        await session.syncSwarmCards(true)
        await settle(); await settle()
        expect(ofType(port, 'supertab.notice')).toEqual([])
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n2') })])]
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab.notice')).toEqual([noticeFrame('n2')]))
      } finally { await session.stop() }
    })

    it('a dial that attaches before the cards arrive is not sent the notices they already hold', async () => {
      // The devices' process started again: the dial attaches to an empty list, then the core replays the last one.
      const state: Parameters<typeof cardHost>[0] = { cards: [] }
      const { session, port } = await connect(cardHost(state))
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertabs')).toHaveLength(1))
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n1') })])]
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        await new Promise((r) => setTimeout(r, 350))
        expect(ofType(port, 'supertab.notice')).toEqual([])
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n2') })])]
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab.notice')).toEqual([noticeFrame('n2')]))
      } finally { await session.stop() }
    })

    it('does not send a notice for the chat the desktop has open', async () => {
      const state: Parameters<typeof cardHost>[0] = { cards: [card('st1', [lead(1, { chat: pmChat })])], open: { superTabId: 'st1', projectId: 'proj1', conversationId: 'pm1', fromDevice: false } }
      const { session, port } = await connect(cardHost(state))
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n1') })])]
        await session.syncSwarmCards()
        await new Promise((r) => setTimeout(r, 350))
        // The person read it on the desktop: leaving that chat later does not alert it either.
        state.open = { superTabId: 'st1', projectId: 'proj1', conversationId: 'lead-c1', fromDevice: false }
        await session.syncSwarmCards()
        await new Promise((r) => setTimeout(r, 350))
        expect(port.types().filter((t) => t.startsWith('supertab.notice'))).toEqual([])
        // The same chat id in another Swarm is another chat.
        state.open = { superTabId: 'st2', projectId: 'proj1', conversationId: 'pm1', fromDevice: false }
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n2') })])]
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab.notice')).toEqual([noticeFrame('n2')]))
      } finally { await session.stop() }
    })

    it('sends notice.read when the desktop opens a chat with a sent notice', async () => {
      const state: Parameters<typeof cardHost>[0] = { cards: [card('st1', [lead(1, { chat: pmChat })])] }
      const { session, port } = await connect(cardHost(state))
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        state.cards = [card('st1', [lead(1, { chat: pmChat, notice: notice('n1') })])]
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab.notice')).toHaveLength(1))
        // Another chat open: still unread.
        state.open = { superTabId: 'st1', projectId: 'proj1', conversationId: 'g1', fromDevice: false }
        await session.syncSwarmCards()
        await new Promise((r) => setTimeout(r, 350))
        expect(ofType(port, 'supertab.notice.read')).toEqual([])
        state.open = { superTabId: 'st1', projectId: 'proj1', conversationId: 'pm1', fromDevice: false }
        await session.syncSwarmCards()
        await vi.waitFor(() => expect(ofType(port, 'supertab.notice.read')).toEqual([{ t: 'supertab.notice.read', tab: 'st1', lead: 'lead1', chatId: 'pm1' }]))
        await session.syncSwarmCards()
        await new Promise((r) => setTimeout(r, 350))
        expect(ofType(port, 'supertab.notice.read')).toHaveLength(1)
      } finally { await session.stop() }
    })

    it('asks recaps and talks with chat, and passes chatId on the recap', async () => {
      const swarmSay = vi.fn(async () => ({ said: true as const }))
      const host = cardHost({ cards: [card('st1', [lead(1, { chat: group })])] }, {
        transcribe: vi.fn(async () => 'ship it'), route: vi.fn(), swarmSay,
        swarmCardRecap: vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: 'From the group', at: 7, none: false, chatId: 'g1' })),
      })
      const { session, port } = await connect(host)
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
        await vi.waitFor(() => expect(ofType(port, 'supertab.recap')).toEqual([
          { t: 'supertab.recap', tab: 'st1', lead: 'lead1', text: 'From the group', at: 7, none: false, chatId: 'g1' }]))
        expect(vi.mocked(host.swarmCardRecap!).mock.calls).toEqual([['st1', 'lead1', true]])
        port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' }); await settle()
        expect(vi.mocked(host.swarmCardOpen!).mock.calls.at(-1)).toEqual([expect.stringMatching(/^c\d+$/), 'st1', 'lead1', true])
        // A pushed recap reaches this dial only as the chat's: the Pro's Lead recap of the same Lead is not its.
        await session.swarmCardRecap({ tabId: 'st1', leadId: 'lead1', text: 'the Lead', at: 8, none: false })
        await session.swarmCardRecap({ tabId: 'st1', leadId: 'lead1', text: 'the group again', at: 9, none: false, chatId: 'g1' })
        expect(ofType(port, 'supertab.recap').map((r) => r.text)).toEqual(['From the group', 'the group again'])
        port.say({ t: 'supertab.open', tab: 'st1', lead: '' }); await settle()
        expect(vi.mocked(host.swarmCardOpen!).mock.calls.at(-1)).toEqual([expect.stringMatching(/^c\d+$/), 'st1', null, true])
        voice(port, 'a1')
        await vi.waitFor(() => expect(swarmSay).toHaveBeenCalled())
        expect(swarmSay.mock.calls[0]).toEqual(['a1', 'ship it', true])
      } finally { await session.stop() }
    })

    it('12 Leads with chats stay under the device\'s 512-token guard', async () => {
      const wide = 'é'.repeat(24)   // 48 bytes
      const cards = [card('st1', Array.from({ length: 13 }, (_, l) => lead(l, {
        project: wide, owner: wide, local: 'a'.repeat(47), engine: 'codex', id: `l${'x'.repeat(40)}${l}`, projectId: `p${'y'.repeat(40)}${l}`, order: 100 + l,
        chat: { kind: 'group', id: `g${'z'.repeat(40)}${l}`, name: wide, working: true, since: 4000 }, notice: notice(`n${l}`) })), { name: wide, count: 40 })]
      const { session, port } = await connect(cardHost({ cards }))
      try {
        port.say(ROUND)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        const [frame] = ofType(port, 'supertab')
        expect(frame.leads).toHaveLength(12)
        expect(tokens(frame)).toBeLessThan(512)
      } finally { await session.stop() }
    })
  })

  // ── swarmBuddy: 'v1' (the round dial's PM and Buddy screens, spec 2026-10-29-round-dial-pm-buddy) ─────────────
  describe('swarmBuddy', () => {
    const ROUND = { t: 'hello', product: 'harness', mac: 'cc:dd', swarmCard: 'v1', superTab: 'wait-v1', swarmChat: 'v1' }
    const BUDDY = { ...ROUND, swarmBuddy: 'v1' }
    const pmChat = { kind: 'pm' as const, id: 'pm1', name: 'PM', working: false }
    const buddyChat = { kind: 'buddy' as const, id: 'pm1', name: "diego's Buddy", working: false }
    const buddy = { chatId: 'pm1', name: "diego's Buddy", engine: 'codex', cells: 25513, color: '#d6a79a', live: true }
    const pmNotice = (id: string) => ({ chat: 'pm' as const, chatId: 'pm1', id, text: `From the PM ${id}`, at: 1792560000 })
    const buddyNotice = (id: string) => ({ chat: 'buddy' as const, chatId: 'pm1', id, text: `From the Buddy ${id}`, at: 1792560000 })
    /** Lead 1 as the cards say it with Buddies on: today's face (`chat`) beside the swarmBuddy dial's (`sideChat`). */
    const withBuddy = (over: Partial<SwarmLead> = {}) => lead(1, { chat: pmChat, sideChat: buddyChat, buddies: true, buddy, ...over })
    const voice = (port: LoopbackPort, agentId: string) => {
      port.say({ t: 'voice.begin', uploadId: `u-${agentId}`, agentId })
      port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
    }
    /** The raw bytes of every `supertab…` frame written, in order. */
    const supertabBytes = (port: LoopbackPort): Buffer[] => port.frames.map((f) => Buffer.from(f)).filter((f) => {
      let isSupertab = false
      new CableDecoder().feed(f, (frame) => {
        if (frame.type === CableType.Json) isSupertab = String(JSON.parse(Buffer.from(frame.payload).toString('utf8')).t).startsWith('supertab')
      })
      return isSupertab
    })

    it('a swarmBuddy dial gets each Lead\'s buddy block and buddies flag', async () => {
      const cards = [card('st1', [withBuddy(), lead(2, { chat: pmChat, sideChat: { kind: 'lead', id: 'lead-c2', name: 'Lead', working: false }, buddies: true }), lead(3)])]
      const { session, port } = await connect(cardHost({ cards }))
      try {
        port.say(BUDDY)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        const base = (n: number) => ({ id: `lead${n}`, projectId: `proj${n}`, project: `Project ${n}`, engine: 'claude', owner: '', local: '', state: 'done', order: n })
        expect(ofType(port, 'supertab')[0].leads).toEqual([
          { ...base(1), chat: 'buddy', chatId: 'pm1', chatName: "diego's Buddy", buddies: true, buddy },
          // No Buddy in this project: the flag alone, and the face the side shows.
          { ...base(2), chat: 'lead', chatId: 'lead-c2', chatName: 'Lead', buddies: true },
          // Buddies off: exactly a swarmChat dial's Lead.
          { ...base(3) },
        ])
      } finally { await session.stop() }
    })

    it('a swarmChat dial without swarmBuddy gets today\'s frame, byte for byte, whatever the Buddy fields', async () => {
      const run = async (leads: () => SwarmLead[]) => {
        const state = { cards: [card('st1', leads())] }
        const { session, port } = await connect(cardHost(state))
        try {
          port.say(ROUND)
          await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
          await settle(); await settle()
          state.cards = [card('st1', leads().map((l) => ({ ...l, notice: pmNotice('n2') })))]
          await session.syncSwarmCards()
          await vi.waitFor(() => expect(ofType(port, 'supertab.notice')).toHaveLength(2))
          port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
          await vi.waitFor(() => expect(ofType(port, 'supertab.recap')).toHaveLength(1))
          return supertabBytes(port)
        } finally { await session.stop() }
      }
      const today = await run(() => [lead(1, { chat: pmChat }), lead(2, { chat: pmChat })])
      const buddies = await run(() => [withBuddy({ buddyNotice: buddyNotice('b1') }), lead(2, { chat: pmChat, sideChat: buddyChat, buddies: true })])
      expect(today.length).toBeGreaterThan(2)
      expect(buddies).toEqual(today)
    })

    it('supertab.side reaches the cards as cardSide, and only from a swarmBuddy dial', async () => {
      for (const hello of [BUDDY, ROUND, PRO]) {
        const swarmCardSide = vi.fn()
        const { session, port } = await connect(cardHost({ cards: [card('st1', [withBuddy()])] }, { swarmCardSide }))
        try {
          port.say(hello)
          await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
          port.say({ t: 'supertab.side', tab: 'st1', side: 'buddy' })
          port.say({ t: 'supertab.side', tab: 'st1', side: 'pm' })
          for (const bad of [{ tab: 'bad id', side: 'pm' }, { tab: 'x'.repeat(48), side: 'pm' }, { tab: 'st1', side: 'up' }, { tab: 'st1' }, { side: 'pm' }]) port.say({ t: 'supertab.side', ...bad })
          await settle(); await settle()
          expect(swarmCardSide.mock.calls).toEqual(hello === BUDDY ? [['st1', 'buddy'], ['st1', 'pm']] : [])
        } finally { await session.stop() }
      }
    })

    it('a buddy notice reaches only a swarmBuddy dial, apart from the Lead\'s', async () => {
      for (const hello of [BUDDY, ROUND]) {
        const state = { cards: [card('st1', [withBuddy()])] }
        const { session, port } = await connect(cardHost(state))
        try {
          port.say(hello)
          await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
          await settle(); await settle()
          state.cards = [card('st1', [withBuddy({ notice: pmNotice('n1'), buddyNotice: buddyNotice('b1') })])]
          await session.syncSwarmCards()
          await vi.waitFor(() => expect(ofType(port, 'supertab.notice').length).toBeGreaterThan(0))
          await new Promise((r) => setTimeout(r, 350))
          const pm = { t: 'supertab.notice', tab: 'st1', lead: 'lead1', chat: 'pm', chatId: 'pm1', id: 'n1', text: 'From the PM n1', at: 1792560000 }
          const quiet = { t: 'supertab.notice', tab: 'st1', lead: 'lead1', chat: 'buddy', chatId: 'pm1', id: 'b1', text: 'From the Buddy b1', at: 1792560000 }
          expect(ofType(port, 'supertab.notice')).toEqual(hello === BUDDY ? [pm, quiet] : [pm])
          // The Buddy's next word is sent once more; the Lead's held notice is not sent again.
          state.cards = [card('st1', [withBuddy({ notice: pmNotice('n1'), buddyNotice: buddyNotice('b2') })])]
          await session.syncSwarmCards()
          await new Promise((r) => setTimeout(r, 350))
          expect(ofType(port, 'supertab.notice').map((n) => n.id)).toEqual(hello === BUDDY ? ['n1', 'b1', 'b2'] : ['n1'])
        } finally { await session.stop() }
      }
    })

    it('asks recaps, opens and talks for the face on its side, and takes only the recaps of that face', async () => {
      const swarmSay = vi.fn(async () => ({ said: true as const }))
      const host = cardHost({ cards: [card('st1', [withBuddy()])] }, {
        transcribe: vi.fn(async () => 'an idea'), route: vi.fn(), swarmSay,
        swarmCardRecap: vi.fn(async (tabId: string, leadId: string) => ({ tabId, leadId, text: 'From the Buddy', at: 7, none: false, chatId: 'pm1', buddy: true as const })),
      })
      const { session, port } = await connect(host)
      try {
        port.say(BUDDY)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        port.say({ t: 'supertab.recap.get', tab: 'st1', lead: 'lead1' })
        await vi.waitFor(() => expect(ofType(port, 'supertab.recap')).toEqual([
          { t: 'supertab.recap', tab: 'st1', lead: 'lead1', text: 'From the Buddy', at: 7, none: false, chatId: 'pm1' }]))
        expect(vi.mocked(host.swarmCardRecap!).mock.calls).toEqual([['st1', 'lead1', 'buddy']])
        port.say({ t: 'supertab.open', tab: 'st1', lead: 'lead1' }); await settle()
        expect(vi.mocked(host.swarmCardOpen!).mock.calls.at(-1)).toEqual([expect.stringMatching(/^c\d+$/), 'st1', 'lead1', 'buddy'])
        // An older dial's recap of the same chat is not this dial's.
        await session.swarmCardRecap({ tabId: 'st1', leadId: 'lead1', text: 'the PM', at: 8, none: false, chatId: 'pm1' })
        await session.swarmCardRecap({ tabId: 'st1', leadId: 'lead1', text: 'the Buddy again', at: 9, none: false, chatId: 'pm1', buddy: true })
        expect(ofType(port, 'supertab.recap').map((r) => r.text)).toEqual(['From the Buddy', 'the Buddy again'])
        voice(port, 'a1')
        await vi.waitFor(() => expect(swarmSay).toHaveBeenCalled())
        expect(swarmSay.mock.calls[0]).toEqual(['a1', 'an idea', 'buddy'])
      } finally { await session.stop() }
    })

    // Review Focus 5: a post the backend refuses (a read-only Chat with PM, Buddies off, a Buddy chat not the reader's) was
    // typed into the Lead's terminal instead.
    const spoken = async (hello: Record<string, unknown>, leads: SwarmLead[], swarmSay: CableHost['swarmSay']) => {
      const host = cardHost({ cards: [card('st1', leads)] }, { transcribe: vi.fn(async () => 'ship it'), route: vi.fn(), swarmSay })
      const { session, port } = await connect(host)
      try {
        port.say(hello); await settle()
        voice(port, 'h1')
        await vi.waitFor(() => expect(port.sent.some((m) => m.t === 'voice.error' || m.t === 'voice.transcript') || vi.mocked(host.sendTurn).mock.calls.length > 0).toBe(true))
        await settle()
        return { errors: ofType(port, 'voice.error').map((m) => m.message), turns: vi.mocked(host.sendTurn).mock.calls }
      } finally { await session.stop() }
    }
    const refused = { said: false as const, refused: { code: 'PM_CHAT_READ_ONLY', message: 'Chat with PM is read-only.' } }

    it('a refused voice post shows voice.error and types nothing', async () => {
      for (const hello of [{ t: 'hello', product: 'harness', mac: 'aa:bb' }, PRO, ROUND, BUDDY]) {
        const swarmSay = vi.fn(async () => refused)
        expect(await spoken(hello, [withBuddy({ local: 'h1', sideChat: { kind: 'lead', id: 'lead-c1', name: 'Lead', working: false } })], swarmSay))
          .toEqual({ errors: ['Chat with PM is read-only.'], turns: [] })
        expect(swarmSay).toHaveBeenCalledOnce()
      }
    })

    it('on the Buddy face an unreachable post shows voice.error and types nothing', async () => {
      const offline = vi.fn(async (): Promise<SaidOnCard> => { throw new Error('offline') })
      expect(await spoken(BUDDY, [withBuddy({ local: 'h1' })], offline)).toEqual({ errors: ['Could not reach your Buddy. Try again.'], turns: [] })
      // Nor when the Swarm no longer lists that Lead as one: the Buddy face never falls back to a terminal.
      expect(await spoken(BUDDY, [withBuddy({ local: 'h1' })], vi.fn(async () => ({ said: false as const })))).toEqual({ errors: ['Could not reach your Buddy. Try again.'], turns: [] })
    })

    it('on the PM face an unreachable post still falls back to the turn', async () => {
      const offline = vi.fn(async (): Promise<SaidOnCard> => { throw new Error('offline') })
      const leadFace = { kind: 'lead' as const, id: 'lead-c1', name: 'Lead', working: false }
      expect(await spoken(BUDDY, [withBuddy({ local: 'h1', sideChat: leadFace })], offline)).toEqual({ errors: [], turns: [['h1', 'ship it']] })
      // An older dial's face is today's, whatever a newer dial's side says.
      expect(await spoken(ROUND, [withBuddy({ local: 'h1', chat: leadFace })], offline)).toEqual({ errors: [], turns: [['h1', 'ship it']] })
    })

    it('an older dial\'s words for the Buddy chat (its PM face) never fall back to the Lead\'s terminal either', async () => {
      // The PM cannot read the reader's Buddy chat: typing what was said there into the PM's terminal would show it.
      const offline = vi.fn(async (): Promise<SaidOnCard> => { throw new Error('offline') })
      expect(await spoken(ROUND, [withBuddy({ local: 'h1' })], offline)).toEqual({ errors: ['Could not reach the Swarm. Try again.'], turns: [] })
    })

    it('a Buddy utterance never falls back after desktop focus changes during its post', async () => {
      const state = { cards: [card('st1', [withBuddy({ local: 'h1' })])] }
      let rejectPost!: (error: Error) => void
      const pending = new Promise<SaidOnCard>((_resolve, reject) => { rejectPost = reject })
      const swarmSay = vi.fn(() => pending)
      const host = cardHost(state, { transcribe: vi.fn(async () => 'private Buddy idea'), route: vi.fn(), swarmSay })
      const { session, port } = await connect(host)
      try {
        port.say(BUDDY)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        voice(port, 'h1')
        await vi.waitFor(() => expect(swarmSay).toHaveBeenCalledOnce())
        // The window opens the Lead while the private post is on its way.
        state.cards = [card('st1', [withBuddy({ local: 'h1', sideChat: { kind: 'lead', id: 'lead-c1', name: 'Lead', working: false } })])]
        await session.syncSwarmCards()
        rejectPost(new Error('backend unreachable'))
        await vi.waitFor(() => expect(port.sent.some(m => m.t === 'voice.error' || m.t === 'voice.transcript')).toBe(true))
        expect(host.sendTurn).not.toHaveBeenCalled()
        expect(ofType(port, 'voice.error').map(m => m.message)).toEqual(['Could not reach your Buddy. Try again.'])
      } finally { await session.stop() }
    })

    it('posts the words into the chat on the face when they were spoken, whatever the face shows by the time they are sent', async () => {
      const state = { cards: [card('st1', [withBuddy({ local: 'h1' })])] }
      const swarmSay = vi.fn(async (): Promise<SaidOnCard> => ({ said: true }))
      const host = cardHost(state, { transcribe: vi.fn(async () => 'private Buddy idea'), route: vi.fn(), swarmSay })
      const { session, port } = await connect(host)
      try {
        port.say(BUDDY)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        port.say({ t: 'voice.begin', uploadId: 'u-h1', agentId: 'h1' })
        // The window opens the Lead while the person is still speaking.
        state.cards = [card('st1', [withBuddy({ local: 'h1', sideChat: { kind: 'lead', id: 'lead-c1', name: 'Lead', working: false } })])]
        port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end' })
        await vi.waitFor(() => expect(swarmSay).toHaveBeenCalledOnce())
        expect(swarmSay.mock.calls[0]).toEqual(['h1', 'private Buddy idea', 'buddy', 'pm1'])
      } finally { await session.stop() }
    })

    // ── Review before posting (device voice in the Swarm chat): words for a chat everyone in the Swarm reads are shown with
    // the chat's name, then Send or Discard. Without this, a held recording on a Swarm face was a draft typed into the
    // Lead's terminal.
    const reviewed = async (hello: Record<string, unknown>, leads: SwarmLead[], swarmSay: CableHost['swarmSay'], op: 'send' | 'discard',
      over: Partial<CableHost> = {}) => {
      const host = cardHost({ cards: [card('st1', leads)] }, { transcribe: vi.fn(async () => 'ship it'), route: vi.fn(), swarmSay, ...over })
      const { session, port } = await connect(host)
      try {
        port.say(hello)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        port.say({ t: 'voice.begin', uploadId: 'u-h1', agentId: 'h1' })
        port.pcm(Buffer.alloc(3200)); port.say({ t: 'voice.end', uploadId: 'u-h1', review: true })
        await vi.waitFor(() => expect(port.sent.some(m => m.t === 'voice.draft' || m.t === 'voice.error')).toBe(true))
        const draft = ofType(port, 'voice.draft')[0]
        const calledBefore = swarmSay ? vi.mocked(swarmSay).mock.calls.length : 0
        if (draft) port.say({ t: 'draft.command', draftId: draft.id, revision: draft.revision, requestId: 'r1', op })
        if (draft) await vi.waitFor(() => expect(port.sent.some(m => m.t === 'draft.state' && m.requestId === 'r1')).toBe(true))
        return { draft, calledBefore, state: ofType(port, 'draft.state')[0], turns: vi.mocked(host.sendTurn).mock.calls }
      } finally { await session.stop() }
    }

    it('words reviewed on a Swarm face are a draft named for that chat, posted there by Send and never typed into a terminal', async () => {
      const swarmSay = vi.fn(async (): Promise<SaidOnCard> => ({ said: true }))
      const r = await reviewed(BUDDY, [withBuddy({ local: 'h1' })], swarmSay, 'send')
      expect(r.draft).toMatchObject({ t: 'voice.draft', active: true, name: "Project 1 · diego's Buddy", context: 'Swarm chat', text: 'ship it' })
      expect(r.calledBefore).toBe(0)
      // Reviewed: the chat it was reviewed for, even if the window moved since (SwarmCards.say checks it is still the Lead's).
      expect(swarmSay.mock.calls).toEqual([['h1', 'ship it', 'buddy', 'pm1', true]])
      expect(r.state).toMatchObject({ ok: true, sent: true })
      expect(r.turns).toEqual([])
    })

    it('a pane focused in the window at capture does not take Swarm-face words: they are reviewed for the face\'s chat', async () => {
      const swarmSay = vi.fn(async (): Promise<SaidOnCard> => ({ said: true }))
      const r = await reviewed(BUDDY, [withBuddy({ local: 'h1' })], swarmSay, 'send', { appFocus: () => ({ machineId: 'm1', agentId: 'a2' }) })
      expect(r.draft).toMatchObject({ name: "Project 1 · diego's Buddy", agentId: 'h1' })
      expect(swarmSay.mock.calls).toEqual([['h1', 'ship it', 'buddy', 'pm1', true]])
      expect(r.turns).toEqual([])
    })

    it('reviewed Swarm-face words with no way to post them in a Swarm are refused, never drafted for a terminal', async () => {
      const r = await reviewed(BUDDY, [withBuddy({ local: 'h1' })], undefined, 'send')
      expect(r.draft).toBeUndefined()
      expect(r.turns).toEqual([])
    })

    it('Discard posts nothing', async () => {
      const swarmSay = vi.fn(async (): Promise<SaidOnCard> => ({ said: true }))
      const lead = { kind: 'lead' as const, id: 'lead-c1', name: 'Lead', working: false }
      const r = await reviewed(ROUND, [withBuddy({ local: 'h1', chat: lead })], swarmSay, 'discard')
      expect(r.draft).toMatchObject({ name: 'Project 1 · Lead' })
      expect(r.state).toMatchObject({ ok: true, active: false })
      expect(swarmSay).not.toHaveBeenCalled()
      expect(r.turns).toEqual([])
    })

    it('a reviewed post the Swarm refuses or cannot take stays a draft with the reason, and nothing is typed', async () => {
      const lead = { kind: 'lead' as const, id: 'lead-c1', name: 'Lead', working: false }
      const refusing = await reviewed(ROUND, [withBuddy({ local: 'h1', chat: lead })], vi.fn(async () => refused), 'send')
      expect(refusing.state).toMatchObject({ ok: false, active: true, error: 'Chat with PM is read-only.' })
      expect(refusing.turns).toEqual([])
      const offline = vi.fn(async (): Promise<SaidOnCard> => { throw new Error('offline') })
      const unreachable = await reviewed(ROUND, [withBuddy({ local: 'h1', chat: lead })], offline, 'send')
      expect(unreachable.state).toMatchObject({ ok: false, active: true, error: 'Could not reach the Swarm. Try again.' })
      expect(unreachable.turns).toEqual([])
    })

    it('says it reviews Swarm chat words, and refuses unreviewed ones from a dial that promised to review them', async () => {
      const swarmSay = vi.fn(async (): Promise<SaidOnCard> => ({ said: true }))
      const transcribe = vi.fn(async () => 'ship it')
      const host = cardHost({ cards: [card('st1', [withBuddy({ local: 'h1' })])] }, { transcribe, route: vi.fn(), swarmSay })
      const { session, port } = await connect(host)
      try {
        port.say({ ...BUDDY, swarmReview: 'v1' })
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        expect(ofType(port, 'welcome')[0].features).toContain('swarm.review')
        voice(port, 'h1')
        await vi.waitFor(() => expect(ofType(port, 'voice.error')).toHaveLength(1))
        expect(ofType(port, 'voice.error')[0].message).toBe('Review the words before they are posted.')
        expect(transcribe).not.toHaveBeenCalled(); expect(swarmSay).not.toHaveBeenCalled(); expect(host.sendTurn).not.toHaveBeenCalled()
      } finally { await session.stop() }
    })

    /** 13 Leads (12 are sent), every name at its 48-byte cut, each working in a group with a Buddy; `id(kind, l)` names the ids. */
    const fullCards = (id: (kind: string, l: number) => string) => {
      const wide = 'é'.repeat(24)   // 48 bytes
      return [card('st1', Array.from({ length: 13 }, (_, l) => lead(l, {
        project: wide, owner: wide, local: id('h', l), engine: 'codex', id: id('l', l), projectId: id('p', l), order: 100 + l,
        chat: { kind: 'group', id: id('g', l), name: wide, working: true, since: 4000 },
        sideChat: { kind: 'group', id: id('g', l), name: wide, working: true, since: 4000 }, buddies: true,
        buddy: { chatId: id('b', l), name: wide, engine: 'codex', cells: 32767, color: '#d6a79a', live: false } })), { name: wide, count: 40 })]
    }
    const sent = async (cards: SwarmCard[]) => {
      const { session, port } = await connect(cardHost({ cards }))
      try {
        port.say(BUDDY)
        await vi.waitFor(() => expect(ofType(port, 'supertab')).toHaveLength(1))
        expect(port.isOpen).toBe(true)
        return ofType(port, 'supertab')[0] as { leads: Array<{ buddy: { name: string } }> }
      } finally { await session.stop() }
    }

    it('the supertab frame with 12 Leads, 48-byte names and a Buddy each stays under 8192 bytes', async () => {
      // The backend's ids: 24 hex characters, a harness's a UUID.
      const frame = await sent(fullCards((kind, l) => kind === 'h' ? `${'0'.repeat(28)}-${String(l).padStart(7, '0')}` : `${kind}${'0'.repeat(21)}${String(l).padStart(2, '0')}`))
      expect(frame.leads).toHaveLength(12)
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(8192)
      // And under the dial's JSON guard (cable_json_guard.h, 512 tokens), which today's firmware applies to every frame.
      expect(tokens(frame)).toBeLessThan(512)
      expect(frame.leads.map((l) => l.buddy.name)).toEqual(Array(12).fill('é'.repeat(24)))
    })

    it('shortens the Buddies\' names, on a character, rather than send a frame the cable cannot carry', async () => {
      // Every id at the 47 characters a dial holds: 8,211 bytes with whole names, and a frame over the cap closes the link.
      const frame = await sent(fullCards((kind, l) => `${kind}${'x'.repeat(44)}${String(l).padStart(2, '0')}`))
      expect(frame.leads).toHaveLength(12)
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(8192)
      expect(tokens(frame)).toBeLessThan(512)
      // The Buddies' names go first: the avatar still tells them apart, and every other name is whole.
      for (const l of frame.leads as unknown as Array<{ buddy: { name: string }; project: string; chatName: string }>) {
        expect([l.buddy.name, l.project, l.chatName]).toEqual(['é'.repeat(12), 'é'.repeat(24), 'é'.repeat(24)])
      }
    })

    it('12 Leads with 48-byte JSON-escaped names fit without dropping the dial', async () => {
      const cards = fullCards((kind, l) => `${kind}${'x'.repeat(44)}${String(l).padStart(2, '0')}`)
      const wide = '"'.repeat(48)
      for (const c of cards) {
        c.name = wide
        for (const l of c.leads) {
          l.project = l.owner = wide
          l.chat!.name = l.sideChat!.name = l.buddy!.name = wide
        }
      }
      // These same valid names fit the existing legacy frame.
      for (const hello of [ROUND, BUDDY]) {
        const { session, port } = await connect(cardHost({ cards }))
        try {
          port.say(hello)
          await vi.waitFor(() => expect(ofType(port, 'supertab').length > 0 || !port.isOpen).toBe(true))
          expect(port.isOpen, hello === BUDDY ? 'new dial must stay connected' : 'legacy baseline must fit').toBe(true)
          expect(Buffer.byteLength(JSON.stringify(ofType(port, 'supertab')[0]))).toBeLessThan(8192)
        } finally { await session.stop() }
      }
    })

    it('fits the fullest frame a dial can be sent: every id at 47 characters, every name and engine escaping at its cut', async () => {
      const cards = fullCards((kind, l) => `${kind}${'x'.repeat(44)}${String(l).padStart(2, '0')}`)
      const wide = '"'.repeat(48), engine = '\u0001'.repeat(16)
      for (const c of cards) {
        c.name = wide
        for (const l of c.leads) {
          l.project = l.owner = wide
          l.engine = l.buddy!.engine = engine
          l.chat!.name = l.sideChat!.name = l.buddy!.name = wide
        }
      }
      for (const hello of [ROUND, BUDDY]) {
        const { session, port } = await connect(cardHost({ cards }))
        try {
          port.say(hello)
          await vi.waitFor(() => expect(ofType(port, 'supertab').length > 0 || !port.isOpen).toBe(true))
          expect(port.isOpen).toBe(true)
          const [frame] = ofType(port, 'supertab') as Array<{ leads: Array<{ id: string; projectId: string; chatId: string; engine: string }> }>
          expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(8192)
          // Every id and engine still names what it names; the Buddies of the least urgent Leads went last, the rest kept theirs.
          expect(frame.leads.map((l) => [l.id, l.projectId, l.chatId, l.engine])).toEqual(cards[0].leads.slice(0, 12).map((l) => [l.id, l.projectId, l.chat!.id, engine]))
          const kept = frame.leads.map((l) => 'buddy' in l)
          if (hello === BUDDY) expect(kept.slice(0, 6)).toEqual(Array(6).fill(true))
          expect(kept.indexOf(false) === -1 || kept.slice(kept.indexOf(false)).every((k) => !k)).toBe(true)
        } finally { await session.stop() }
      }
    })
  })
})
