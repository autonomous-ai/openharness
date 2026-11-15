/**
 * The core's side of the other engines' live streams (engines/others/streams.ts, in their worker): a handle per
 * followed session, the one wait for what their streams made, and what the core does when the worker does not answer.
 * The core keeps each turn's state from what it took, decides every close, and checks and bounds every answer.
 *
 * The worker gone, their panes run on: the core says so, holds each handle as it was, and closes a turn a Stop or a
 * backstop ends itself. Once a worker is back, each stream is opened again where the core took it: the transcript's
 * tail from its acknowledged byte, the turn as the core holds it (docs/design/2026-11-15-core-plan/engines.md).
 */
import { randomUUID } from 'node:crypto'
import type { LiveEvent } from '../../engines/kit/events.js'
import {
  streamFrame, streamOpened, streamTurn, STREAM_OP, STREAM_OP_WAIT_MS, STREAM_OPEN, STREAM_OPEN_WAIT_MS, STREAM_VERSION, STREAMS_WAIT,
  STREAMS_WAIT_MS, type StreamFrame, type StreamOp, type StreamOpened, type StreamTurn,
} from '../../engines/worker/otherStreamProtocol.js'
import { liveEvent } from '../../engines/worker/liveProtocol.js'
import { READER_PART, READER_VERSION, record } from '../../engines/worker/protocol.js'
import { sid } from '../../lib/log.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { joinParts } from './readers.js'

export interface OtherStreamsDeps {
  /** A request of the worker: its link, or its handlers in this process (services/inline.ts). */
  call(type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  bySession(id: string): RegisteredSession | undefined
  /** What a frame says, for its session (core/transcripts/ingest.ts). */
  frame(session: RegisteredSession, frame: StreamFrame): void
  /** Attach the session again from its transcript: rewritten in place, or given up by the worker. */
  reattach(session: RegisteredSession): void
  log?(line: string): void
  /** How long a failed wait or open waits before it is tried again. */
  retryMs?: number
}

export interface OtherStreamOpen {
  live: boolean
  abandon: boolean
  held: boolean
  store: string | null
}

/** A followed session's stream, as the core last took it. */
export interface OtherStream {
  readonly engine: string
  readonly sessionId: string
  readonly turnOpen: boolean
  readonly turn: StreamTurn
  /** Where the transcript's next untaken record starts. */
  readonly offset: number | undefined
  /** A cancel's close: marked here at once, and told to the worker, which emits nothing for it. */
  closeTurn(reason: 'cancel' | 'abandoned' | 'hook'): void
}

interface Handle extends OtherStream {
  store: string | null
  token: string
  applied: number
  turn: StreamTurn
  offset: number | undefined
  /** The worker that holds the stream is gone: nothing is asked of it until it is opened again. */
  orphan: boolean
  /** A close is on its way: what an older frame says of the turn does not open it again. */
  closing: number
  quietUntil: number
}

const ANSWER_KEYS = ['frames', 'turn', 'events', 'closed', 'quietFor']

export function createOtherStreams(deps: OtherStreamsDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const retryMs = deps.retryMs ?? 1_000
  const handles = new Map<string, Handle>()
  const byToken = new Map<string, Handle>()
  /** Sessions whose open was not answered: attached again once the worker is there. */
  const unopened = new Map<string, ReturnType<typeof setTimeout>>()
  let connected = true
  /** One request, its answer put back together when it came in parts, all within the request's own wait. */
  const call = async (type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> => {
    const deadline = performance.now() + waitMs
    const first = await deps.call(type, payload, waitMs)
    if (first.part === undefined) return first
    return joinParts(first, async (offset) => {
      const left = Math.ceil(deadline - performance.now())
      if (left <= 0) throw new Error('ENGINE_UNAVAILABLE')
      return deps.call(READER_PART, { version: READER_VERSION, part: first.part, offset }, left)
    })
  }
  let generation = 0
  let waiting = false
  let stopped = false

  const apply = (handle: Handle, frames: readonly StreamFrame[]): void => {
    for (const frame of frames) {
      if (frame.serial <= handle.applied || byToken.get(handle.token) !== handle) continue
      handle.applied = frame.serial
      if (frame.offset !== undefined) handle.offset = frame.offset
      if (!handle.closing) handle.turn = frame.turn
      handle.quietUntil = 0
      const session = deps.bySession(handle.sessionId)
      if (session && session.engine === handle.engine) {
        if (frame.rewritten) {
          log(`[watcher] ${sid(handle.sessionId)} transcript rewritten in place — attaching it again from its end`)
          deps.reattach(session)
        }
        try { deps.frame(session, frame) } catch (error) { log(`[engine-others] ${sid(handle.sessionId)} frame failed · ${error instanceof Error ? error.message : error}`) }
      }
    }
  }
  /** The answer's own checks: its version, its error, and only what an answer of the kind may hold. */
  const answerOf = (reply: Record<string, unknown>): Record<string, unknown> | null =>
    reply.version === STREAM_VERSION && reply.error === undefined && record(reply.answer) ? reply.answer : null

  const op = async (handle: Handle, kind: StreamOp, data: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
    if (handle.orphan || stopped) return null
    const token = handle.token, at = generation
    let reply: Record<string, unknown>
    try { reply = await call(STREAM_OP, { version: STREAM_VERSION, token, op: kind, ...data }, STREAM_OP_WAIT_MS) } catch { return null }
    // A reconnect reuses the handle, but no result from its old connection belongs to the new stream.
    if (stopped || at !== generation || handle.token !== token || byToken.get(token) !== handle) return null
    const answer = answerOf(reply)
    if (!answer || !Object.keys(answer).every(key => ANSWER_KEYS.includes(key)) || !Array.isArray(answer.frames)
      || !answer.frames.every(streamFrame) || (answer.turn !== undefined && !streamTurn(answer.turn))
      || (answer.events !== undefined && !(Array.isArray(answer.events) && answer.events.every(liveEvent)))) {
      if (reply.error === 'ENGINE_STREAM_GONE') gone(handle)
      return null
    }
    apply(handle, answer.frames)
    if (answer.turn && byToken.get(handle.token) === handle) handle.turn = answer.turn as StreamTurn
    return answer
  }

  /** The worker lost a stream the core still follows: the session is attached again, from what is on disk. */
  const gone = (handle: Handle): void => {
    if (byToken.get(handle.token) !== handle) return
    byToken.delete(handle.token)
    handles.delete(handle.sessionId)
    const session = deps.bySession(handle.sessionId)
    log(`[engine-others] ${sid(handle.sessionId)} its live stream was given up by the worker · attaching it again`)
    if (session) deps.reattach(session)
  }

  const handleOf = (session: RegisteredSession, token: string, opened: StreamOpened, store: string | null): Handle => {
    const handle: Handle = {
      engine: session.engine, sessionId: session.sessionId, store, token, applied: 0, turn: opened.turn,
      offset: opened.offset, orphan: false, closing: 0, quietUntil: 0,
      get turnOpen() { return handle.turn.turnOpen },
      closeTurn(reason) {
        handle.turn = { ...handle.turn, turnOpen: false }
        handle.closing++
        void op(handle, reason === 'cancel' ? 'cancel' : 'close').finally(() => { handle.closing-- })
      },
    }
    return handle
  }

  const opening = async (session: RegisteredSession, token: string, payload: Record<string, unknown>): Promise<StreamOpened | null> => {
    let reply: Record<string, unknown>
    try { reply = await call(STREAM_OPEN, { version: STREAM_VERSION, token, ...payload }, STREAM_OPEN_WAIT_MS) } catch { reply = {} }
    const answer = answerOf(reply)
    if (answer && streamOpened(answer)) return answer
    // Not answered, or not checkable: the worker may hold a stream nobody follows; it is told to forget it.
    void deps.call(STREAM_OP, { version: STREAM_VERSION, token, op: 'forget' }, STREAM_OP_WAIT_MS).catch(() => undefined)
    if (reply.error === undefined || reply.error === 'ENGINE_UNAVAILABLE' || reply.error === 'SERVICE_UNAVAILABLE') retryLater(session)
    return null
  }
  const retryLater = (session: RegisteredSession): void => {
    if (stopped || unopened.has(session.sessionId)) return
    const timer = setTimeout(() => {
      unopened.delete(session.sessionId)
      const latest = deps.bySession(session.sessionId)
      if (latest && latest.engine === session.engine && connected) deps.reattach(latest)
    }, retryMs)
    timer.unref?.()
    unopened.set(session.sessionId, timer)
  }

  /** The one wait for what every stream made: running while any is followed, and the worker is there. */
  const wait = async (): Promise<void> => {
    if (waiting || stopped || !connected || !byToken.size) return
    waiting = true
    const at = generation
    try {
      while (!stopped && connected && at === generation && byToken.size) {
        const acks = Object.fromEntries([...byToken.values()].map(handle => [handle.token, handle.applied]))
        let reply: Record<string, unknown>
        try { reply = await call(STREAMS_WAIT, { version: STREAM_VERSION, acks }, STREAMS_WAIT_MS + 10_000) } catch { reply = {} }
        if (stopped || at !== generation) return
        const answer = answerOf(reply)
        if (!answer || !Array.isArray(answer.pages) || !Array.isArray(answer.lost)) {
          // A worker that cannot answer is waited for, never asked in a loop.
          await new Promise(resolve => setTimeout(resolve, retryMs).unref?.())
          continue
        }
        for (const page of answer.pages) {
          if (!record(page) || typeof page.token !== 'string' || !Array.isArray(page.frames) || !page.frames.every(streamFrame)) continue
          const handle = byToken.get(page.token)
          if (handle) apply(handle, page.frames)
        }
        for (const token of answer.lost) {
          const handle = typeof token === 'string' ? byToken.get(token) : undefined
          if (handle) gone(handle)
        }
      }
    } finally { if (at === generation) waiting = false }
  }

  /** The worker did not answer a close: the core closes the turn itself, and says so. */
  const closedHere = (handle: Handle): boolean => {
    if (!handle.turnOpen) return false
    handle.turn = { ...handle.turn, turnOpen: false }
    log(`[turn] ${sid(handle.sessionId)} closed by the core itself · the other engines' worker did not answer`)
    return true
  }
  const forgetHandle = (handle: Handle): void => {
    byToken.delete(handle.token)
    if (!handle.orphan) void deps.call(STREAM_OP, { version: STREAM_VERSION, token: handle.token, op: 'forget' }, STREAM_OP_WAIT_MS).catch(() => undefined)
  }

  return {
    /** Opens the session's stream: its fold, and the tail or the poll after it. Null when the worker did not answer. */
    async open(session: RegisteredSession, options: OtherStreamOpen): Promise<StreamOpened | null> {
      clearTimeout(unopened.get(session.sessionId))
      unopened.delete(session.sessionId)
      const token = randomUUID()
      const opened = await opening(session, token, { live: options.live, abandon: options.abandon, held: options.held,
        session: { agentId: session.agentId, sessionId: session.sessionId, engine: session.engine, transcriptPath: session.transcriptPath ?? null, store: options.store } })
      if (!opened || stopped) return null
      const handle = handleOf(session, token, opened, options.store)
      const previous = handles.get(session.sessionId)
      handles.set(session.sessionId, handle)
      byToken.set(token, handle)
      if (previous) forgetHandle(previous)
      apply(handle, opened.frames)
      void wait()
      return opened
    },
    get: (sessionId: string): OtherStream | undefined => handles.get(sessionId),
    has: (sessionId: string): boolean => handles.has(sessionId),
    /** A Stop's or a backstop's close: what the parser emits closing; when the worker does not answer, the core closes the
     *  turn itself and says so, so a Stop never leaves a turn open. */
    async close(sessionId: string, how: { abort?: boolean; error?: boolean; stop?: boolean }): Promise<LiveEvent[]> {
      const handle = handles.get(sessionId)
      if (!handle) return []
      const identity = handle.turn.identity
      const answer = await op(handle, how.abort ? 'abort' : 'close', { error: !!how.error, stop: !!how.stop })
      if (answer) return answer.events as LiveEvent[]
      if (handles.get(sessionId) !== handle || handle.turn.identity !== identity || !closedHere(handle)) return []
      return [{ type: 'turn_ended', payload: how.abort || how.error ? { aborted: true } : {} }]
    },
    /** A turn an attach's history left open, closed silently if it is still that turn: whether it was. */
    async closeIf(sessionId: string, identity: string): Promise<boolean> {
      const handle = handles.get(sessionId)
      if (!handle || handle.turn.identity !== identity) return false
      const answer = await op(handle, 'close', { identity })
      if (answer) return answer.closed === true
      return handle.turn.identity === identity && closedHere(handle)
    },
    /** A read now of what the session has that its stream has not delivered: best effort, bounded. */
    async drain(sessionId: string): Promise<void> {
      const handle = handles.get(sessionId)
      if (handle) await op(handle, 'drain')
    },
    async drainAll(): Promise<void> {
      if (!handles.size || !connected || stopped) return
      await deps.call(STREAM_OP, { version: STREAM_VERSION, op: 'drain' }, STREAM_OP_WAIT_MS).catch(() => undefined)
    },
    async tail(sessionId: string, path: string, fromStart: boolean): Promise<void> {
      const handle = handles.get(sessionId)
      if (handle) await op(handle, 'tail', { path, fromStart })
    },
    /** Command Code's turn opened from outside its transcript; nothing when the worker does not answer. */
    async openTurn(sessionId: string, text?: string): Promise<LiveEvent[]> {
      const handle = handles.get(sessionId)
      const answer = handle ? await op(handle, 'open', text === undefined ? {} : { text }) : null
      return (answer?.events as LiveEvent[] | undefined) ?? []
    },
    /** Cursor's Task hook, for the sub-agent it starts. */
    task(sessionId: string, toolUseId: string, input: unknown): void {
      const handle = handles.get(sessionId)
      if (handle) void op(handle, 'task', { toolUseId, input })
    },
    /** A bind pass read OpenClaw's pane: whether a stream takes it. */
    paneRead(sessionId: string, reading: { ready: boolean; gatewayLost: boolean; running: boolean }): boolean {
      const handle = handles.get(sessionId)
      if (!handle) return false
      void op(handle, 'pane', { reading }).then(answer => {
        const quiet = answer?.quietFor
        if (typeof quiet === 'number' && quiet > 0 && quiet <= 60_000) handle.quietUntil = Date.now() + quiet
      })
      return true
    },
    /** Whether the next bind pass reads the pane: always, but while its stream says it is quiet. */
    paneDue(sessionId: string): boolean {
      const handle = handles.get(sessionId)
      return !handle || Date.now() >= handle.quietUntil
    },
    release(sessionId: string): void {
      const handle = handles.get(sessionId)
      if (handle) void op(handle, 'release')
    },
    forget(sessionId: string): void {
      clearTimeout(unopened.get(sessionId))
      unopened.delete(sessionId)
      const handle = handles.get(sessionId)
      if (!handle) return
      handles.delete(sessionId)
      forgetHandle(handle)
    },
    connected(): void {
      if (connected || stopped) return
      connected = true
      generation++
      waiting = false
      const at = generation
      const orphans = [...handles.values()].filter(handle => handle.orphan)
      if (orphans.length) log(`[engine-others] the other engines' worker is back · following ${orphans.length} conversation(s) again`)
      for (const handle of orphans) void (async () => {
        const session = deps.bySession(handle.sessionId)
        if (!session || session.engine !== handle.engine || handles.get(handle.sessionId) !== handle) return
        const token = randomUUID()
        const opened = await opening(session, token, { live: false, abandon: false, held: false,
          resume: { turnOpen: handle.turnOpen, ...(handle.offset !== undefined ? { offset: handle.offset } : {}) },
          session: { agentId: session.agentId, sessionId: session.sessionId, engine: session.engine, transcriptPath: session.transcriptPath ?? null, store: handle.store } })
        if (!opened) return
        if (stopped || at !== generation || handles.get(handle.sessionId) !== handle) {
          void deps.call(STREAM_OP, { version: STREAM_VERSION, token, op: 'forget' }, STREAM_OP_WAIT_MS).catch(() => undefined)
          return
        }
        byToken.delete(handle.token)
        Object.assign(handle, { token, applied: 0, orphan: false, turn: opened.turn, offset: opened.offset ?? handle.offset })
        byToken.set(token, handle)
        apply(handle, opened.frames)
        void wait()
      })()
      for (const [sessionId, timer] of unopened) {
        clearTimeout(timer)
        unopened.delete(sessionId)
        const session = deps.bySession(sessionId)
        if (session) deps.reattach(session)
      }
      void wait()
    },
    disconnected(): void {
      if (!connected) return
      connected = false
      generation++
      waiting = false
      if (!handles.size) return
      for (const handle of handles.values()) handle.orphan = true
      log(`[engine-others] the other engines' worker is gone · ${handles.size} conversation(s) held at what the core took, their panes running on`)
    },
    stop(): void {
      stopped = true
      generation++
      for (const timer of unopened.values()) clearTimeout(timer)
      unopened.clear()
      for (const handle of handles.values()) forgetHandle(handle)
      handles.clear()
    },
  }
}

export type OtherStreams = ReturnType<typeof createOtherStreams>
