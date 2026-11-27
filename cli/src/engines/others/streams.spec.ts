/**
 * The other engines' live streams in their worker, through its requests (streamRequests.ts), with fake normalizers and
 * readers: how a stream opens, folds and tails, what it keeps for the core and gives up, how it opens again where the
 * core took it, and the turn ops a Stop, a cancel and an attach make. Each engine's own readings are the golden's
 * (engines/otherTranscripts.golden.spec.ts).
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { open as openTranscript } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '../kit/events.js'
import { STREAM_OP, STREAM_OPEN, STREAM_STORE, STREAM_VERSION, STREAMS_WAIT } from '../worker/otherStreamProtocol.js'
import { otherStreamRequests } from './streamRequests.js'
import { createOtherStreams } from './streams.js'
import { stampAt } from '../worker/liveFiles.js'
import { PENDING_TASKS_FILE } from '../cursor/contract.js'
import { Watcher } from '../../watcher/watcher.js'
import { env } from '../../config/env.js'
import { forgetHermesHomes, hermesDbPath } from '../hermes/home.js'

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
  constructor(readonly opts: { onEvents(events: LiveEvent[]): void; onTurnAborted?(message: string): void; onFatal?(error: Error): void }) {}
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
  KiloReader: class extends FakeReader { constructor(opts: never) { super(opts); readers.push(this) } },
  HermesReader: class extends FakeReader { constructor(opts: never) { super(opts); readers.push(this) } },
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

function setup(over: { waitMs?: number; answerBytes?: number; dataDir?: string; limits?: { totalBytes?: number; foldBytes?: number } } = {}) {
  const listeners = new Map<string, (event: unknown) => void>()
  const watcher = { on: vi.fn((name: string, listener: (event: unknown) => void) => { listeners.set(name, listener) }),
    addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}), pollSession: vi.fn(async () => {}), start: vi.fn() }
  const warn = vi.fn()
  const load = vi.fn(async () => code)
  const streams = createOtherStreams({ watcher: watcher as never, load: load as never, warn, log: vi.fn(), dataDir: over.dataDir ?? '/no/such/data', limits: over.limits })
  const requests = otherStreamRequests({ streams, waitMs: over.waitMs ?? 50, answerBytes: over.answerBytes })
  const CORE = { owner: true, local: true }
  const ask = async (type: string, payload: Record<string, unknown>) => await requests[type]({ version: STREAM_VERSION, ...payload }, CORE) as Record<string, any>
  const open = (token: string, engine: string, transcriptPath: string | null, over: Record<string, unknown> = {}) => ask(STREAM_OPEN, {
    token, live: false, abandon: false, held: false, ...over,
    session: { agentId: `a-${token}`, sessionId: `s-${token}`, engine, transcriptPath, store: ['opencode', 'kilo', 'hermes', 'devin'].includes(engine) ? '/db/x.db' : null } })
  const line = (sessionId: string, engine: string, record: unknown, next?: number) =>
    listeners.get('line')!({ sessionId, engine, text: JSON.stringify(record), ...(next !== undefined ? { next } : {}) })
  return { streams, requests, ask, open, line, listeners, watcher, load, warn, CORE }
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
    expect(run.watcher.addSession).toHaveBeenCalledWith({ sessionId: 's-t1', engine: 'pi', transcriptPath: path }, { fromOffset: Buffer.byteLength(readFileSync(path)), validate: expect.any(Function), stamp: expect.any(Function), current: expect.any(Function) })
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

  it.each(['forget', 'clear', 'request'])('does not finish a worker open after %s while its engine loads', async (change) => {
    const run = setup()
    let loaded!: (value: typeof code) => void
    run.load.mockImplementationOnce(() => new Promise(resolve => { loaded = resolve }))
    const opening = run.open('t1', 'pi', file([]))
    if (change === 'request') await run.ask(STREAM_OP, { op: 'forget', token: 't1' })
    else if (change === 'forget') run.streams.forget('t1')
    else run.streams.clear()
    loaded(code)
    expect(await opening).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    expect(run.streams.all()).toEqual([])
    expect(run.watcher.addSession).not.toHaveBeenCalled()
  })

  it('keeps the newest worker open when an older engine load finishes last', async () => {
    const run = setup()
    const path = file([])
    let loaded!: (value: typeof code) => void
    run.load.mockImplementationOnce(() => new Promise(resolve => { loaded = resolve }))
    const session = { agentId: 'a', sessionId: 'same', engine: 'pi', transcriptPath: path, store: null }
    const older = run.ask(STREAM_OPEN, { token: 'older', session, live: false, abandon: false, held: false })
    await run.ask(STREAM_OPEN, { token: 'newer', session, live: false, abandon: false, held: false })
    loaded(code)
    expect(await older).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    expect(run.streams.all().map(stream => stream.token)).toEqual(['newer'])
  })

  it.each(['pi', 'cursor'])('keeps the fold boundary across %s startup, restart and the tail installation gap', async (engine) => {
    const path = file([{ events: [started('old')], open: true }])
    const boundary = Buffer.byteLength(readFileSync(path))
    const watcher = new Watcher({ readChunkBytes: 17 })
    const add = watcher.addSession.bind(watcher)
    let append = true
    vi.spyOn(watcher, 'addSession').mockImplementation(async (session, options) => {
      if (append) {
        append = false
        appendFileSync(path, JSON.stringify({ events: [{ type: 'text_delta', payload: { content: 'gap界🙂' } }] }) + '\n')
      }
      return add(session, options)
    })
    const streams = createOtherStreams({ watcher, load: (async () => code) as never, log: vi.fn(), dataDir: '/no/such/data' })
    const ask = { token: 't1', session: { agentId: 'a', sessionId: 's1', engine: engine as 'pi', transcriptPath: path, store: null }, live: false, abandon: false, held: false }
    try {
      const initial = await streams.open(ask)
      expect(initial?.offset).toBe(boundary)
      await streams.drain(streams.stream('t1')!)
      expect(streams.stream('t1')!.frames().flatMap(frame => frame.events)).toEqual([{ type: 'text_delta', payload: { content: 'gap界🙂' } }])
      for (const frame of streams.stream('t1')!.frames()) expect(frame.stamp).toEqual(await stampAt(path, frame.offset!))
      streams.clear()
      appendFileSync(path, JSON.stringify({ events: [{ type: 'text_delta', payload: { content: 'offline' } }] }) + '\n')
      await streams.open({ ...ask, token: 't2', resume: { turnOpen: true, offset: boundary, stamp: initial!.stamp } })
      await streams.drain(streams.stream('t2')!)
      expect(streams.stream('t2')!.frames().flatMap(frame => frame.events)).toEqual([
        { type: 'text_delta', payload: { content: 'gap界🙂' } }, { type: 'text_delta', payload: { content: 'offline' } },
      ])
    } finally { streams.clear(); await watcher.stop() }
  })

  it.each(['pi', 'cursor'])('refuses a %s resume into a replaced or rewritten file generation', async engine => {
    const run = setup()
    const path = file([{ events: [started('old')], open: true }])
    const initial = (await run.open('t1', engine, path)).answer
    writeFileSync(path, JSON.stringify({ events: [started('new')], open: true }) + '\n')
    expect(await run.open('t2', engine, path, { resume: { turnOpen: true, offset: initial.offset, stamp: initial.stamp } }))
      .toMatchObject({ error: 'ENGINE_TRANSCRIPT_CHANGED' })
    expect(run.streams.stream('t2')).toBeUndefined()
    run.streams.clear()
  })

  it('does not install a tail whose registration completes after the worker was cleared', async () => {
    const watcher = new Watcher(), path = file([])
    const add = watcher.addSession.bind(watcher)
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const adding = vi.spyOn(watcher, 'addSession').mockImplementation(async (session, options) => { await paused; await add(session, options) })
    const streams = createOtherStreams({ watcher, load: (async () => code) as never, log: vi.fn(), dataDir: '/no/such/data' })
    try {
      const opening = streams.open({ token: 'old', session: { agentId: 'a', sessionId: 's', engine: 'pi', transcriptPath: path, store: null }, live: false, abandon: false, held: false })
      await vi.waitFor(() => expect(adding).toHaveBeenCalledOnce())
      streams.clear()
      release()
      expect(await opening).toBeNull()
      expect(watcher.tails('s', path)).toBe(false)
    } finally { release(); streams.clear(); await watcher.stop() }
  })

  it('refuses a file replaced between its fold and tail registration', async () => {
    const watcher = new Watcher(), path = file([{ events: [started('old')], open: true }])
    const add = watcher.addSession.bind(watcher)
    vi.spyOn(watcher, 'addSession').mockImplementation(async (session, options) => {
      writeFileSync(path, JSON.stringify({ events: [started('new')], open: true }) + '\n')
      await add(session, options)
    })
    const streams = createOtherStreams({ watcher, load: (async () => code) as never, log: vi.fn(), dataDir: '/no/such/data' })
    try {
      await expect(streams.open({ token: 't', session: { agentId: 'a', sessionId: 's', engine: 'pi', transcriptPath: path, store: null }, live: false, abandon: false, held: false }))
        .rejects.toThrow('ENGINE_TRANSCRIPT_CHANGED')
      expect(watcher.tails('s', path)).toBe(false)
    } finally { streams.clear(); await watcher.stop() }
  })

  it('logs named failures without parser, store, or task error content', async () => {
    const sentinel = 'secret-token /private/customer/conversation'
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = file([]), dataDir = dirname(path)
    writeFileSync(join(dataDir, PENDING_TASKS_FILE), '[]')
    const run = setup({ dataDir })
    run.load.mockRejectedValueOnce(new Error(sentinel))
    expect(await run.open('failed', 'pi', null)).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    await run.open('t1', 'pi', null)
    vi.spyOn(Fake.prototype, 'ingest').mockImplementation(() => { throw new Error(sentinel) })
    run.line('s-t1', 'pi', {})
    run.listeners.get('history')!({ sessionId: 's-t1', engine: 'pi', lines: [{ text: '{}' }] })
    vi.spyOn(code, 'loadCursorPendingTasks').mockRejectedValueOnce(new Error(sentinel))
    await run.open('cursor', 'cursor', null)
    await run.open('store', 'opencode', null)
    ;(readers[0].opts as unknown as { onFatal(error: Error): void }).onFatal(new Error(sentinel))
    const logs = JSON.stringify([...consoleWarn.mock.calls, ...run.warn.mock.calls])
    expect(logs).not.toContain(sentinel)
    expect(logs).toContain('LIVE_OPEN_FAILED')
    expect(logs).toContain('LIVE_RECORD_INVALID · Error')
    expect(logs).toContain('LIVE_HISTORY_INVALID · Error')
    expect(logs).toContain('CURSOR_TASKS_UNAVAILABLE · Error')
    expect(logs).toContain('STORE_READER_FAILED')
    run.streams.clear()
  })

  it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('reports a stopped %s store reader to the core and ignores its late callbacks', async engine => {
    const run = setup()
    await run.open('failed-reader', engine, null)
    const stop = vi.spyOn(readers[0], 'stop')
    const fatal = (readers[0].opts as unknown as { onFatal(error: Error): void }).onFatal
    const waiting = run.ask(STREAMS_WAIT, { acks: { 'failed-reader': 0 } })
    fatal(new Error('private store path'))
    expect((await waiting).answer.lost).toContain('failed-reader')
    expect(run.streams.stream('failed-reader')).toBeUndefined()
    expect(stop).toHaveBeenCalled()
    await run.open('replacement', engine, null)
    fatal(new Error('late private store path'))
    expect(run.streams.stream('replacement')).toBeDefined()
    expect(run.streams.ack({})).not.toContain('failed-reader')
    run.streams.clear()
  })

  it.each(['opencode', 'kilo', 'hermes', 'devin'] as const)('drains accepted %s frames before reporting fatal and rejects later callbacks and operations', async engine => {
    const run = setup({ answerBytes: 1 })
    await run.open('retiring', engine, null)
    const reader = readers[0], stop = vi.spyOn(reader, 'stop')
    reader.opts.onEvents([started('first')])
    reader.opts.onEvents([started('last')])
    reader.opts.onFatal!(new Error('failed'))
    reader.opts.onEvents([started('too late')])
    reader.opts.onTurnAborted?.('too late')
    expect(stop).toHaveBeenCalled()
    expect(run.streams.all()).toEqual([])
    for (const op of ['close', 'drain', 'task']) {
      expect(await run.ask(STREAM_OP, { token: 'retiring', op })).toMatchObject({ error: 'ENGINE_STREAM_GONE' })
    }
    const first = (await run.ask(STREAMS_WAIT, { acks: {} })).answer
    expect(first).toMatchObject({ pages: [{ token: 'retiring', frames: [{ serial: 1, events: [started('first')] }] }], lost: [] })
    const last = (await run.ask(STREAMS_WAIT, { acks: { retiring: 1 } })).answer
    expect(last).toMatchObject({ pages: [{ token: 'retiring', frames: [{ serial: 2, events: [started('last')] }] }], lost: [] })
    expect((await run.ask(STREAMS_WAIT, { acks: { retiring: 2 } })).answer).toEqual({ pages: [], lost: ['retiring'] })
    expect(run.streams.pending()).toEqual([])
    run.streams.clear()
  })

  it.each(['forget', 'clear'] as const)('bounds unacknowledged fatal frames and releases their budget once on %s', async cleanup => {
    const run = setup({ limits: { totalBytes: 2_000 } })
    const events: LiveEvent[] = [{ type: 'text_delta', payload: { content: 'x'.repeat(1_200) } }]
    await run.open('retiring', 'opencode', null)
    readers[0].opts.onEvents(events)
    readers[0].opts.onFatal!(new Error('failed'))
    const first = (await run.ask(STREAMS_WAIT, { acks: {} })).answer
    expect(first).toMatchObject({ pages: [{ token: 'retiring', frames: [{ events }] }], lost: [] })
    for (let i = 0; i < 3; i++) expect((await run.ask(STREAMS_WAIT, { acks: {} })).answer).toEqual(first)
    await run.open('pressure', 'pi', null)
    run.line('s-pressure', 'pi', { events })
    expect(run.streams.stream('pressure')).toBeUndefined()
    expect(run.streams.ack({})).toEqual(['pressure'])
    if (cleanup === 'forget') { run.streams.forget('retiring'); run.streams.forget('retiring') }
    else { run.streams.clear(); run.streams.clear() }
    expect(run.streams.pending()).toEqual([])
    await run.open('fresh', 'pi', null)
    run.line('s-fresh', 'pi', { events })
    expect(run.streams.stream('fresh')).toBeDefined()
    await run.open('full', 'pi', null)
    run.line('s-full', 'pi', { events })
    expect(run.streams.stream('full')).toBeUndefined()
    expect(run.streams.ack({})).toEqual(['full'])
    run.streams.clear()
  })

  it('keeps a replacement reader when the retired reader drains and its final acknowledgement releases budget', async () => {
    const run = setup({ limits: { totalBytes: 2_000 } })
    const session = { agentId: 'a', sessionId: 'same', engine: 'devin', transcriptPath: null, store: '/db/x.db' }
    const open = (token: string) => run.ask(STREAM_OPEN, { token, session, live: false, abandon: false, held: false })
    const events: LiveEvent[] = [{ type: 'text_delta', payload: { content: 'x'.repeat(900) } }]
    await open('old')
    const old = readers[0]
    old.opts.onEvents(events)
    old.opts.onFatal!(new Error('failed'))
    await open('replacement')
    const replacement = readers[1], stop = vi.spyOn(replacement, 'stop')
    replacement.opts.onEvents([started('replacement')])
    const before = (await run.ask(STREAMS_WAIT, { acks: {} })).answer
    expect(before.pages.map((page: { token: string }) => page.token)).toEqual(['old', 'replacement'])
    expect(before.lost).toEqual([])
    const after = (await run.ask(STREAMS_WAIT, { acks: { old: 1 } })).answer
    expect(after).toMatchObject({ pages: [{ token: 'replacement', frames: [{ events: [started('replacement')] }] }], lost: ['old'] })
    expect(run.streams.all().map(stream => stream.token)).toEqual(['replacement'])
    expect(stop).not.toHaveBeenCalled()
    old.opts.onFatal!(new Error('late failure'))
    old.opts.onEvents([started('late events')])
    run.streams.forget('old')
    replacement.opts.onEvents(events)
    expect(run.streams.stream('replacement')).toBeDefined()
    expect(run.streams.ack({})).toEqual([])
    replacement.opts.onEvents(events)
    expect(run.streams.stream('replacement')).toBeUndefined()
    expect(run.streams.ack({})).toEqual(['replacement'])
    run.streams.clear()
  })

  it('refuses an open whose reader emits and fatals during initial hydration', async () => {
    vi.spyOn(FakeReader.prototype, 'start').mockImplementationOnce(async function (this: FakeReader) {
      this.opts.onEvents([started('not attached')])
      this.opts.onFatal!(new Error('failed'))
    })
    const run = setup()
    expect(await run.open('opening', 'opencode', null)).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    expect(run.streams.pending()).toEqual([])
    expect(run.streams.all()).toEqual([])
    run.streams.clear()
  })

  it('never primes a whole-file rewrite reader with only a capped Cursor prefix', async () => {
    const path = file([{ events: [started('old-prefix')] }, { padding: 'x'.repeat(300) }, { events: [] }])
    const watcher = new Watcher()
    const streams = createOtherStreams({ watcher, load: async () => code as never, dataDir: dirname(path), limits: { foldBytes: 128 } })
    const requests = otherStreamRequests({ streams })
    try {
      const reply = await requests[STREAM_OPEN]({ version: STREAM_VERSION, token: 'capped', live: false, abandon: false, held: false,
        session: { agentId: 'a', sessionId: 'cursor', engine: 'cursor', transcriptPath: path, store: null } }, { owner: true, local: true })
      if (!reply.error) {
        appendFileSync(path, JSON.stringify({ events: [started('fresh')] }) + '\n')
        await watcher.pollSession('cursor')
        expect(JSON.stringify(streams.stream('capped')!.frames())).not.toContain('old-prefix')
      }
      expect(reply).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
      expect(streams.stream('capped')).toBeUndefined()
    } finally { streams.clear(); await watcher.stop() }
  })

  it('retires a Cursor rewrite reader before an oversized file is read', async () => {
    const path = file([{ events: [] }])
    const reads: Array<() => number> = []
    const watcher = new Watcher({ openFile: async path => {
      const handle = await openTranscript(path, 'r')
      const spy = vi.spyOn(handle, 'read')
      reads.push(() => spy.mock.calls.length)
      return handle
    } })
    const streams = createOtherStreams({ watcher, load: async () => code as never, dataDir: dirname(path), limits: { foldBytes: 128 } })
    try {
      await streams.open({ token: 'grows', live: false, abandon: false, held: false,
        session: { agentId: 'a', sessionId: 'cursor', engine: 'cursor', transcriptPath: path, store: null } })
      appendFileSync(path, JSON.stringify({ events: [started('past-the-limit')], padding: 'x'.repeat(300) }) + '\n')
      await watcher.pollSession('cursor')
      expect(reads).not.toHaveLength(0)
      expect(reads.every(count => count() === 0)).toBe(true)
      expect(streams.ack({})).toEqual(['grows'])
      expect(streams.stream('grows')).toBeUndefined()
    } finally { streams.clear(); await watcher.stop() }
  })

  it('bounds aggregate queued bytes and recovers its budget after acknowledgements and forget', async () => {
    const run = setup({ limits: { totalBytes: 2_000 } })
    for (let i = 0; i < 4; i++) await run.open(`t${i}`, 'pi', null)
    const event = { events: [{ type: 'text_delta', payload: { content: 'x'.repeat(600) } }] }
    run.line('s-t0', 'pi', event); run.line('s-t1', 'pi', event); run.line('s-t2', 'pi', event)
    expect(run.streams.stream('t2')).toBeUndefined()
    expect((await run.ask(STREAMS_WAIT, { acks: { t0: 1 } })).answer.lost).toEqual(['t2'])
    run.line('s-t3', 'pi', event)
    expect(run.streams.stream('t3')).toBeDefined()
    run.streams.forget('t1')
    run.line('s-t3', 'pi', event)
    expect(run.streams.stream('t3')).toBeDefined()
    run.streams.clear()
  })

  it('bounds concurrent opens and cancels queued opens without allocating a fold', async () => {
    const run = setup()
    const loaded: Array<() => void> = []
    run.load.mockImplementation(() => new Promise(resolve => { loaded.push(() => resolve(code)) }))
    const opening = Array.from({ length: 8 }, (_, i) => run.open(`t${i}`, 'pi', null))
    await vi.waitFor(() => expect(run.load).toHaveBeenCalledTimes(4))
    await run.ask(STREAM_OP, { token: 't7', op: 'forget' })
    for (const done of loaded.splice(0)) done()
    await vi.waitFor(() => expect(run.load).toHaveBeenCalledTimes(7))
    for (const done of loaded.splice(0)) done()
    const answers = await Promise.all(opening)
    expect(answers.slice(0, 7).every(answer => answer.answer)).toBe(true)
    expect(answers[7]).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    run.streams.clear()
  })

  it('bounds acknowledgements and Task inputs by encoded bytes, and ends an already closed wait', async () => {
    const run = setup()
    await run.open('t1', 'pi', file([]))
    for (const acks of [{ t1: -1 }, { t1: '1' }, Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`t${i}`, 0]))]) {
      expect(await run.ask(STREAMS_WAIT, { acks })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    }
    expect(await run.ask(STREAM_OP, { token: 't1', op: 'task', toolUseId: 'tool', input: '界'.repeat(90_000) }))
      .toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    const abort = new AbortController()
    abort.abort()
    expect(await run.requests[STREAMS_WAIT]({ version: STREAM_VERSION, acks: {} }, run.CORE, abort.signal))
      .toEqual({ version: STREAM_VERSION, answer: { pages: [], lost: [] } })
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
    expect(second.pages[0].frames.map((f: { serial: number }) => f.serial)).toEqual([2])
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
    expect(run.watcher.removeSession).toHaveBeenCalledWith('s-t1')
  })

  it('tails a transcript the session found later, from its start when asked, and lets a held stream go', async () => {
    const run = setup()
    await run.open('t1', 'pi', null, { held: true })
    expect(await run.ask(STREAM_OP, { op: 'tail', token: 't1', path: 'relative', fromStart: true })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    const path = file([])
    await run.ask(STREAM_OP, { op: 'tail', token: 't1', path, fromStart: true })
    expect(run.watcher.addSession).toHaveBeenCalledWith({ sessionId: 's-t1', engine: 'pi', transcriptPath: path }, { fromStart: true, stamp: expect.any(Function), current: expect.any(Function) })
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
    expect(run.watcher.addSession).toHaveBeenLastCalledWith(expect.objectContaining({ transcriptPath: path }), { fromOffset: offset, validate: expect.any(Function), stamp: expect.any(Function), current: expect.any(Function) })
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

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()

// A Hermes in the default home gained `hermesHome: <default>` on an attach during its stop, and the stop refused the Close (#4361).
describe.skipIf(!hasSqlite)('the Hermes store answer', () => {
  const DEFAULT = '20260727_162325_e25264', PROFILE = '20260921_152236_a1b2c3', UNKNOWN = '20261116_090000_abcdef'
  let profile: string
  /** A home whose store holds exactly the sessions given. */
  const makeHome = (root: string, sessions: string[]) => {
    mkdirSync(root, { recursive: true })
    execFileSync('sqlite3', [hermesDbPath(root), 'CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, cwd TEXT);'
      + sessions.map(id => `INSERT INTO sessions VALUES ('${id}','cli','/tmp/x');`).join('')])
  }
  const ask = (sessionId: string, extra: Record<string, unknown> = {}) =>
    setup().ask(STREAM_STORE, { session: { sessionId, engine: 'hermes', ...extra } })
  // Each case has a default home of its own and deletes it after. Not env's: on Windows that is the person's real
  // %LOCALAPPDATA%\hermes, which vitest.setup.ts does not move. The home listing is cached whatever the home, so it goes too.
  beforeEach(() => {
    const was = env.HERMES_HOME, home = mkdtempSync(join(tmpdir(), 'hermes-home-'))
    ;(env as { HERMES_HOME: string }).HERMES_HOME = home
    profile = join(home, 'profiles', 'work')
    forgetHermesHomes()
    return () => { (env as { HERMES_HOME: string }).HERMES_HOME = was; forgetHermesHomes(); rmSync(home, { recursive: true, force: true }) }
  })

  it('answers no home for a session in the default home', async () => {
    makeHome(env.HERMES_HOME, [DEFAULT])
    expect(await ask(DEFAULT)).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(env.HERMES_HOME) } })
  })
  it('names the profile home a session was found in', async () => {
    makeHome(env.HERMES_HOME, [DEFAULT]); makeHome(profile, [PROFILE])
    expect(await ask(PROFILE)).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(profile), home: profile } })
  })
  it('answers the store of a home the row already names, and no home', async () => {
    makeHome(env.HERMES_HOME, [PROFILE]); makeHome(profile, [PROFILE])
    expect(await ask(PROFILE, { hermesHome: profile })).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(profile) } })
  })
  it('answers the default store and no home for a session no store holds', async () => {
    makeHome(env.HERMES_HOME, [DEFAULT])
    expect(await ask(UNKNOWN)).toEqual({ version: STREAM_VERSION, answer: { store: hermesDbPath(env.HERMES_HOME) } })
  })
})
