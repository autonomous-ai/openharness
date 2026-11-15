/**
 * The other engines' live streams in their worker, through its requests (streamRequests.ts), with fake normalizers and
 * readers: how a stream opens, folds and tails, what it keeps for the core and gives up, how it opens again where the
 * core took it, and the turn ops a Stop, a cancel and an attach make. Each engine's own readings are the golden's
 * (engines/otherTranscripts.golden.spec.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '../kit/events.js'
import { STREAM_OP, STREAM_OPEN, STREAM_VERSION, STREAMS_WAIT } from '../worker/otherStreamProtocol.js'
import { otherStreamRequests } from './streamRequests.js'
import { createOtherStreams } from './streams.js'

const started = (userMessage: string): LiveEvent => ({ type: 'turn_started', payload: { userMessage } })
/** A file engine's normalizer that reads JSON lines: `{"events":[…],"open":true|false}`. */
class Fake {
  turnOpen = false
  ingest(line: string): LiveEvent[] {
    const record = JSON.parse(line) as { events?: LiveEvent[]; open?: boolean }
    if (record.open !== undefined) this.turnOpen = record.open
    return record.events ?? []
  }
  closeTurn(): LiveEvent[] { const was = this.turnOpen; this.turnOpen = false; return was ? [{ type: 'turn_ended', payload: {} }] : [] }
  abortTurn(): LiveEvent[] { this.turnOpen = false; return [{ type: 'turn_ended', payload: { aborted: true } }] }
  openTurn(text = ''): LiveEvent[] { this.turnOpen = true; return [started(text)] }
}
/** A database engine's reader, which the test feeds. */
class FakeReader {
  turnOpen = false
  started = 0
  polled = 0
  constructor(readonly opts: { onEvents(events: LiveEvent[]): void; onTurnAborted?(message: string): void }) {}
  async start(): Promise<void> { this.started++; if (hydrate.open) { this.turnOpen = true; this.opts.onEvents([started('running')]) } }
  stop(): void {}
  closeTurn(): void { this.turnOpen = false }
  async poll(): Promise<void> { this.polled++ }
}
const hydrate = { open: false }
const readers: FakeReader[] = []
const code = {
  PiNormalizer: Fake, CopilotNormalizer: Fake, AgyNormalizer: Fake, CommandCodeNormalizer: Fake, CursorNormalizer: Fake,
  copilotHistoryTurnOpen: () => false,
  commandCodeRunError: (line: string) => line.includes('"failed"') ? 'Error: 500' : null, commandCodeRunErrorSummary: () => 'Error',
  transcriptEvidence: (raw: Record<string, unknown>) => typeof raw.model === 'string' ? { model: raw.model } : null,
  OpencodeReader: class extends FakeReader { constructor(opts: never) { super(opts); readers.push(this) } },
  DevinReader: class extends FakeReader { constructor(opts: never) { super(opts); readers.push(this) } },
  loadCursorPendingTasks: async () => [], removeCursorPendingTasks: async () => {},
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); readers.length = 0; hydrate.open = false; vi.restoreAllMocks() })
const file = (lines: unknown[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'other-streams-')); dirs.push(dir)
  const path = join(dir, 's.jsonl')
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return path
}

function setup(over: { waitMs?: number; answerBytes?: number } = {}) {
  const listeners = new Map<string, (event: unknown) => void>()
  const watcher = { on: vi.fn((name: string, listener: (event: unknown) => void) => { listeners.set(name, listener) }),
    addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}), pollSession: vi.fn(async () => {}), start: vi.fn() }
  const warn = vi.fn()
  const streams = createOtherStreams({ watcher: watcher as never, load: (async () => code) as never, warn, log: vi.fn(), dataDir: '/no/such/data' })
  const requests = otherStreamRequests({ streams, waitMs: over.waitMs ?? 50, answerBytes: over.answerBytes })
  const CORE = { owner: true, local: true }
  const ask = async (type: string, payload: Record<string, unknown>) => await requests[type]({ version: STREAM_VERSION, ...payload }, CORE) as Record<string, any>
  const open = (token: string, engine: string, transcriptPath: string | null, over: Record<string, unknown> = {}) => ask(STREAM_OPEN, {
    token, live: false, abandon: false, held: false, ...over,
    session: { agentId: `a-${token}`, sessionId: `s-${token}`, engine, transcriptPath, store: engine === 'opencode' || engine === 'devin' ? '/db/x.db' : null } })
  const line = (sessionId: string, engine: string, record: unknown, next?: number) =>
    listeners.get('line')!({ sessionId, engine, text: JSON.stringify(record), ...(next !== undefined ? { next } : {}) })
  return { streams, requests, ask, open, line, listeners, watcher, warn, CORE }
}

describe('the other engines\' live streams, in their worker', () => {
  it('answers only the core\'s own call, and checks what it is sent', async () => {
    const run = setup()
    for (const type of [STREAM_OPEN, STREAM_OP, STREAMS_WAIT]) {
      expect(await run.requests[type]({ version: STREAM_VERSION }, { owner: true, local: true, connection: 'c' })).toEqual({ version: STREAM_VERSION, error: 'ENGINE_INVALID_REQUEST' })
      expect(await run.requests[type]({ version: 99 }, run.CORE)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    }
    for (const bad of [{ token: '' }, { token: 't', session: { agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: null, store: null }, live: false, abandon: false, held: false },
      { token: 't', session: { agentId: 'a', sessionId: 's', engine: 'pi', transcriptPath: 'relative', store: null }, live: false, abandon: false, held: false },
      { token: 't', session: { agentId: 'a', sessionId: 's', engine: 'pi', transcriptPath: null, store: null }, live: 'no', abandon: false, held: false },
      { token: 't', session: { agentId: 'a', sessionId: 's', engine: 'pi', transcriptPath: null, store: null }, live: false, abandon: false, held: false, resume: { turnOpen: 'no' } }]) {
      expect(await run.ask(STREAM_OPEN, bad)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    }
    expect(await run.ask(STREAM_OP, { op: 'explode', token: 't' })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    expect(await run.ask(STREAM_OP, { op: 'drain' })).toEqual({ version: STREAM_VERSION, answer: { frames: [] } })
    expect(await run.ask(STREAM_OP, { op: 'close', token: 'nobody' })).toMatchObject({ error: 'ENGINE_STREAM_GONE' })
    expect(await run.ask(STREAMS_WAIT, { acks: 'no' })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  })

  it('folds a transcript silently, starts its tail after, and hands each later line to the core as a frame', async () => {
    const run = setup()
    const path = file([{ events: [started('old')], open: true, model: 'm1' }])
    const reply = await run.open('t1', 'pi', path)
    expect(reply.answer).toMatchObject({ historyTurnOpen: true, lastStarted: started('old'), lastEnded: null, lines: 1, evidence: [{ model: 'm1' }], abandoned: false, frames: [] })
    expect(run.watcher.addSession).toHaveBeenCalledWith({ sessionId: 's-t1', engine: 'pi', transcriptPath: path }, {})
    expect(run.watcher.start).toHaveBeenCalledOnce()
    run.line('s-t1', 'pi', { events: [{ type: 'text_delta', payload: { content: 'hi' } }], model: 'm2' }, 99)
    run.line('s-t1', 'grok', { events: [started('other engine')] })
    run.line('nobody', 'pi', { events: [started('nobody')] })
    const waited = await run.ask(STREAMS_WAIT, { acks: {} })
    expect(waited.answer.pages).toEqual([{ token: 't1', frames: [expect.objectContaining({ serial: 1, offset: 99, evidence: [{ model: 'm2' }],
      events: [{ type: 'text_delta', payload: { content: 'hi' } }] })] }])
    // Acknowledged, it is not sent again; the wait then holds until its own end.
    expect((await run.ask(STREAMS_WAIT, { acks: { t1: 1 } })).answer).toEqual({ pages: [], lost: [] })
  })

  it('holds a wait until a line comes, and answers the lines of one read together', async () => {
    const run = setup({ waitMs: 5_000 })
    await run.open('t1', 'pi', file([]))
    const waiting = run.ask(STREAMS_WAIT, { acks: {} })
    run.line('s-t1', 'pi', { events: [started('a')], open: true })
    run.line('s-t1', 'pi', { events: [{ type: 'text_delta', payload: { content: 'b' } }] })
    const answer = (await waiting).answer
    expect(answer.pages[0].frames.map((f: { serial: number }) => f.serial)).toEqual([1, 2])
    expect(answer.pages[0].frames[0].turn.turnOpen).toBe(true)
  })

  it('answers a wait in bounded parts, the oldest frames first, one larger than the bound alone', async () => {
    const run = setup({ answerBytes: 200 })
    await run.open('t1', 'pi', file([]))
    for (let i = 0; i < 4; i++) run.line('s-t1', 'pi', { events: [{ type: 'text_delta', payload: { content: 'x'.repeat(i === 0 ? 400 : 10) } }] })
    const first = (await run.ask(STREAMS_WAIT, { acks: {} })).answer
    expect(first.pages[0].frames.map((f: { serial: number }) => f.serial)).toEqual([1])
    const second = (await run.ask(STREAMS_WAIT, { acks: { t1: 1 } })).answer
    expect(second.pages[0].frames.map((f: { serial: number }) => f.serial)).toEqual([2, 3])
  })

  it('takes a catch-up batch as one replayed frame, says a rewritten transcript, and contains a line that throws', async () => {
    const run = setup()
    const path = file([])
    await run.open('t1', 'commandcode', path)
    run.listeners.get('history')!({ sessionId: 's-t1', engine: 'commandcode', lines: [
      { text: JSON.stringify({ events: [started('a')], open: true }), next: 10 }, { text: JSON.stringify({ failed: true, model: 'm' }), next: 20 }] })
    run.listeners.get('rewritten')!({ sessionId: 's-t1', engine: 'commandcode', transcriptPath: path })
    run.listeners.get('rewritten')!({ sessionId: 's-t1', engine: 'commandcode', transcriptPath: '/elsewhere' })
    run.listeners.get('line')!({ sessionId: 's-t1', engine: 'commandcode', text: 'not json' })
    run.listeners.get('history')!({ sessionId: 's-t1', engine: 'commandcode', lines: [{ text: 'not json' }] })
    const frames = (await run.ask(STREAMS_WAIT, { acks: {} })).answer.pages[0].frames
    expect(frames[0]).toMatchObject({ replay: true, failure: 'Error: 500', failureSummary: 'Error', offset: 20, evidence: [{ model: 'm' }], events: [started('a')] })
    expect(frames[1]).toMatchObject({ rewritten: true, events: [] })
    expect(frames).toHaveLength(2)
    expect(run.warn).toHaveBeenCalledTimes(2)
  })

  it('closes a turn the fold leaves open when its engine started again, unless its pane must say, and copilot\'s by its records', async () => {
    const run = setup()
    const open = [{ events: [started('old')], open: true }]
    expect((await run.open('t1', 'pi', file(open), { abandon: true })).answer).toMatchObject({ historyTurnOpen: true, abandoned: true, turn: { turnOpen: false } })
    expect((await run.open('t2', 'agy', file(open), { abandon: true })).answer).toMatchObject({ historyTurnOpen: true, abandoned: false, paneCheck: true })
    expect((await run.open('t3', 'copilot', file(open))).answer).toMatchObject({ historyTurnOpen: false })
    // A live first turn is emitted as the fold, and is no history.
    expect((await run.open('t4', 'pi', file(open), { live: true })).answer).toMatchObject({ historyTurnOpen: false, initial: [started('old')] })
  })

  it('makes the turn ops a Stop, a cancel and a message make, each fenced to the turn it names', async () => {
    const run = setup()
    await run.open('t1', 'commandcode', file([]))
    const opened = await run.ask(STREAM_OP, { op: 'open', token: 't1', text: 'hi' })
    expect(opened.answer).toMatchObject({ events: [started('hi')], turn: { turnOpen: true } })
    expect(await run.ask(STREAM_OP, { op: 'open', token: 't1', text: 1 })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    expect((await run.ask(STREAM_OP, { op: 'close', token: 't1', identity: 'stale' })).answer).toMatchObject({ closed: false })
    const close = await run.ask(STREAM_OP, { op: 'close', token: 't1', identity: opened.answer.turn.identity })
    expect(close.answer).toMatchObject({ closed: true, events: [{ type: 'turn_ended', payload: {} }], turn: { turnOpen: false } })
    expect((await run.ask(STREAM_OP, { op: 'abort', token: 't1' })).answer.events).toEqual([{ type: 'turn_ended', payload: { aborted: true } }])
    expect((await run.ask(STREAM_OP, { op: 'cancel', token: 't1' })).answer).toMatchObject({ closed: true })
    expect((await run.ask(STREAM_OP, { op: 'forget', token: 't1' })).answer).toEqual({ frames: [] })
    expect(run.watcher.removeSession).not.toHaveBeenCalled()
  })

  it('tails a transcript the session found later, from its start when asked, and lets a held stream go', async () => {
    const run = setup()
    await run.open('t1', 'pi', null, { held: true })
    expect(await run.ask(STREAM_OP, { op: 'tail', token: 't1', path: 'relative', fromStart: true })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    const path = file([])
    await run.ask(STREAM_OP, { op: 'tail', token: 't1', path, fromStart: true })
    expect(run.watcher.addSession).toHaveBeenCalledWith({ sessionId: 's-t1', engine: 'pi', transcriptPath: path }, { fromStart: true })
    // Held, its lines wait; let go, they are read.
    run.line('s-t1', 'pi', { events: [started('held')] })
    await run.ask(STREAM_OP, { op: 'release', token: 't1' })
    expect(run.watcher.pollSession).toHaveBeenCalledWith('s-t1')
    run.line('s-t1', 'pi', { events: [started('let go')] })
    expect((await run.ask(STREAMS_WAIT, { acks: {} })).answer.pages[0].frames.map((f: { events: LiveEvent[] }) => f.events[0])).toEqual([started('let go')])
    await run.ask(STREAM_OP, { op: 'forget', token: 't1' })
    expect(run.watcher.removeSession).toHaveBeenCalledWith('s-t1')
  })

  it('reads a store through its reader, polls it on a drain, and says a Devin turn its provider ended', async () => {
    const run = setup()
    hydrate.open = true
    const reply = await run.open('t1', 'opencode', null)
    expect(reply.answer.frames.map((f: { events: LiveEvent[] }) => f.events)).toEqual([[started('running')]])
    await run.ask(STREAM_OP, { op: 'drain', token: 't1' })
    expect(readers[0].polled).toBe(1)
    await run.open('t2', 'devin', null)
    readers[1].opts.onTurnAborted!('provider error')
    const frames = (await run.ask(STREAMS_WAIT, { acks: { t1: 1 } })).answer.pages[0].frames
    expect(frames.at(-1)).toMatchObject({ failure: 'provider error', events: [{ type: 'turn_ended', payload: {} }] })
    expect((await run.ask(STREAM_OP, { op: 'close', token: 't1' })).answer).toMatchObject({ closed: true, events: [], turn: { turnOpen: false } })
  })

  it('opens a stream again where the core took it: the turn it holds, the tail from its byte, a store\'s turn reconciled', async () => {
    const run = setup()
    const lines = [{ events: [started('a')], open: true }, { events: [], open: false }]
    const path = file(lines)
    const offset = Buffer.byteLength(`${JSON.stringify(lines[0])}\n`)
    // The core took the first record, which opened a turn: folded to there, the tail goes on from it.
    const resumed = (await run.open('r1', 'pi', path, { resume: { turnOpen: true, offset } })).answer
    expect(resumed).toMatchObject({ historyTurnOpen: true, lines: 1, turn: { turnOpen: true }, offset, frames: [] })
    expect(run.watcher.addSession).toHaveBeenLastCalledWith(expect.objectContaining({ transcriptPath: path }), { fromOffset: offset })
    // The core closed it itself meanwhile: closed here too, silently.
    expect((await run.open('r2', 'pi', path, { resume: { turnOpen: false, offset } })).answer).toMatchObject({ turn: { turnOpen: false }, frames: [] })
    // It ended in what the core did not take: said, once.
    const ended = (await run.open('r3', 'pi', file([{ events: [] }]), { resume: { turnOpen: true } })).answer
    expect(ended.frames.map((f: { events: LiveEvent[] }) => f.events)).toEqual([[{ type: 'turn_ended', payload: {} }]])
    // A store hydrates silently: only the difference from the core's turn is said.
    hydrate.open = true
    expect((await run.open('r4', 'opencode', null, { resume: { turnOpen: true } })).answer.frames).toEqual([])
    expect((await run.open('r5', 'opencode', null, { resume: { turnOpen: false } })).answer.frames.map((f: { events: LiveEvent[] }) => f.events)).toEqual([[started('running')]])
    hydrate.open = false
    expect((await run.open('r6', 'opencode', null, { resume: { turnOpen: true } })).answer.frames.map((f: { events: LiveEvent[] }) => f.events)).toEqual([[{ type: 'turn_ended', payload: {} }]])
  })

  it('gives up a stream the core does not take, and says so at the next wait', async () => {
    const run = setup({ waitMs: 5_000 })
    await run.open('t1', 'pi', file([]))
    const big = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 40; i++) run.line('s-t1', 'pi', { events: [{ type: 'text_delta', payload: { content: big } }] })
    expect(run.warn).toHaveBeenCalledWith(expect.stringContaining('live stream not taken by the core'))
    expect((await run.ask(STREAMS_WAIT, { acks: {} })).answer.lost).toEqual(['t1'])
    expect(await run.ask(STREAM_OP, { op: 'drain', token: 't1' })).toMatchObject({ error: 'ENGINE_STREAM_GONE' })
  })

  it('keeps what a replaced stream made for the core, and clears everything when the core goes', async () => {
    const run = setup()
    await run.open('old', 'pi', null)
    run.line('s-old', 'pi', { events: [started('old')] })
    await run.ask(STREAM_OPEN, { token: 'new', live: false, abandon: false, held: false, session: { agentId: 'a', sessionId: 's-old', engine: 'pi', transcriptPath: null, store: null } })
    run.line('s-old', 'pi', { events: [started('new')] })
    const pages = (await run.ask(STREAMS_WAIT, { acks: {} })).answer.pages
    expect(pages.map((page: { token: string }) => page.token).sort()).toEqual(['new', 'old'])
    run.streams.clear()
    expect(await run.ask(STREAM_OP, { op: 'drain', token: 'new' })).toMatchObject({ error: 'ENGINE_STREAM_GONE' })
  })

  it('reads OpenClaw\'s pane for its stream, and says how long it may go unread; only Cursor follows a Task', async () => {
    const run = setup()
    await run.open('t1', 'pi', null)
    expect(await run.ask(STREAM_OP, { op: 'pane', token: 't1', reading: { ready: true } })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    expect((await run.ask(STREAM_OP, { op: 'pane', token: 't1', reading: { ready: true, gatewayLost: false, running: false } })).answer.quietFor).toBe(0)
    expect(await run.ask(STREAM_OP, { op: 'task', token: 't1', toolUseId: '', input: {} })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    expect((await run.ask(STREAM_OP, { op: 'task', token: 't1', toolUseId: 'tool', input: {} })).answer.frames).toEqual([])
  })
})
