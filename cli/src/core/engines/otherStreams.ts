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
import { isAbsolute } from 'node:path'
import type { LiveStamp } from '../../engines/worker/liveProtocol.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import {
  boundedStreamReply, streamFrame, streamOpened, streamTurn, STREAM_OP, STREAM_OP_WAIT_MS, STREAM_OPEN, STREAM_STORE, STREAM_OPEN_WAIT_MS, STREAM_VERSION, STREAMS_WAIT,
  STREAMS_WAIT_MS, STREAMS_MAX, STREAM_FRAMES_MAX, streamEvents, type StreamFrame, type StreamOp, type StreamOpened, type StreamTurn,
} from '../../engines/worker/otherStreamProtocol.js'
import { READER_PART, READER_VERSION, record } from '../../engines/worker/protocol.js'
import { sid } from '../../lib/log.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { paneReadIdentity, transcriptReadIdentity } from '../transcripts/readIdentity.js'
import { joinParts } from './readers.js'

export interface OtherStreamsDeps {
  /** A request of the worker: its link, or its handlers in this process (services/inline.ts). */
  call(type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  bySession(id: string): RegisteredSession | undefined
  /** What a frame says, for its session (core/transcripts/ingest.ts). */
  frame(session: RegisteredSession, frame: StreamFrame): void
  /** Attach the session again from its transcript: rewritten in place, or given up by the worker. */
  reattach(session: RegisteredSession): void
  /** The live view is waiting on its reader; panes and Stop remain usable. */
  held?(session: RegisteredSession, held: boolean, rewritten?: boolean | 'lost'): void
  /** The lifecycle's existing reservation. Reader recovery never changes its authority while Stop owns it. */
  stopping?(session: RegisteredSession): Promise<unknown> | undefined
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
  stamp: LiveStamp | null | undefined
  /** The worker that holds the stream is gone: nothing is asked of it until it is opened again. */
  orphan: boolean
  /** The reader tries the stream no more until its worker connects again. */
  givenUp: boolean
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
  const pending = new Map<string, string>()
  /** Sessions whose open was not answered: attached again once the worker is there. */
  const unopened = new Map<string, { timer?: ReturnType<typeof setTimeout>;
    stop?: { identity: string; generation?: number } }>()
  const attempts = new Map<string, number>()
  let connected = true
  /** One request, its answer put back together when it came in parts, all within the request's own wait. */
  const call = async (type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> => {
    const deadline = performance.now() + waitMs
    const first = await deps.call(type, payload, waitMs)
    if (first.part === undefined) {
      if (!boundedStreamReply(first)) throw new Error('ENGINE_INVALID_REPLY')
      return first
    }
    return joinParts(first, async (offset) => {
      const left = Math.ceil(deadline - performance.now())
      if (left <= 0) throw new Error('ENGINE_UNAVAILABLE')
      return deps.call(READER_PART, { version: READER_VERSION, part: first.part, offset }, left)
    })
  }
  const ignored = () => undefined
  const forgetToken = (token: string): void => {
    void deps.call(STREAM_OP, { version: STREAM_VERSION, token, op: 'forget' }, STREAM_OP_WAIT_MS).catch(ignored)
  }
  let generation = 0
  let waiting = false
  let stopped = false
  let endBackoff: (() => void) | undefined

  const clearRecovery = (sessionId: string): void => {
    const recovery = unopened.get(sessionId)
    clearTimeout(recovery?.timer)
    // Forget revokes the binding, not the lifetime of its pending Stop. Keep its cancelled marker until that
    // promise settles, so repeated forget/open cannot append more callbacks to one still-running operation.
    if (recovery?.stop) recovery.stop.generation = undefined
    else unopened.delete(sessionId)
  }
  const cancelDeferredRecovery = (): void => {
    // Keep the one continuation until its Stop settles. A reconnect may authorize it afresh for the same binding;
    // adding another promise callback on every disconnect would retain unbounded callbacks during a long Stop.
    for (const recovery of unopened.values()) if (recovery.stop) recovery.stop.generation = undefined
  }
  // A lost reader's retry cleared its hold while Close waited for SIGTERM to finish, changing evidenceRevision
  // and refusing a safe Close after the engine had exited (storage comparison, 2026-11-16). Only optional reader
  // recovery waits: native evidence still reaches frame(), and every native Stop fence remains in force.
  const deferRecovery = (session: RegisteredSession): boolean => {
    if (stopped) return true
    const job = deps.stopping?.(session)
    if (!job) return false
    const sessionId = session.sessionId
    const deferred = unopened.get(sessionId)?.stop
    if (deferred) {
      if (deferred.identity === paneReadIdentity(session)) deferred.generation = generation
      return true
    }
    if (!unopened.has(sessionId) && unopened.size >= STREAMS_MAX) {
      log('[engine-others] live recovery limit reached')
      return true
    }
    clearRecovery(sessionId)
    const authority: { identity: string; generation?: number } = { identity: paneReadIdentity(session), generation }
    const recovery = { stop: authority }
    unopened.set(sessionId, recovery)
    const settled = (): void => {
      if (unopened.get(sessionId) !== recovery) return
      unopened.delete(sessionId)
      const latest = deps.bySession(sessionId)
      if (stopped || authority.generation !== generation || !latest || paneReadIdentity(latest) !== authority.identity) return
      // A later Stop can take ownership before this continuation runs. It owns the same single recovery.
      if (deferRecovery(latest)) return
      if (!connected) {
        deps.held?.(latest, true)
        unopened.set(sessionId, {})
        return
      }
      deps.held?.(latest, false)
      deps.reattach(deps.bySession(sessionId)!)
    }
    void job.then(settled, settled).catch(() => log('[engine-others] LIVE_RECOVERY_FAILED'))
    return true
  }
  const held = (session: RegisteredSession, value: boolean, rewritten?: boolean | 'lost'): void => {
    if (deferRecovery(session)) return
    if (rewritten === undefined) deps.held?.(session, value)
    else deps.held?.(session, value, rewritten)
  }
  const reattach = (session: RegisteredSession): void => {
    if (!deferRecovery(session)) deps.reattach(session)
  }

  const apply = (handle: Handle, frames: readonly StreamFrame[]): boolean => {
    for (const frame of frames) {
      if (frame.serial <= handle.applied || byToken.get(handle.token) !== handle) continue
      if (frame.serial !== handle.applied + 1) {
        log('[engine-others] live stream skipped a frame · attaching it again')
        gone(handle)
        return false
      }
      handle.applied = frame.serial
      if (frame.offset !== undefined) { handle.offset = frame.offset; handle.stamp = frame.stamp }
      if (!handle.closing || frame.turn.identity !== handle.turn.identity) handle.turn = frame.turn
      handle.quietUntil = 0
      const session = deps.bySession(handle.sessionId)
      if (session && session.engine === handle.engine) {
        if (frame.rewritten) {
          log(`[watcher] ${sid(handle.sessionId)} transcript rewritten in place — attaching it again from its end`)
          reattach(session)
        }
        try { deps.frame(session, frame) } catch { log(`[engine-others] ${sid(handle.sessionId)} frame could not be applied`); unavailable(session) }
      }
    }
    return true
  }
  /** The answer's own checks: its version, its error, and only what an answer of the kind may hold. */
  const answerOf = (reply: Record<string, unknown>): Record<string, unknown> | null =>
    reply.version === STREAM_VERSION && reply.error === undefined && record(reply.answer) ? reply.answer : null

  const op = async (handle: Handle, kind: StreamOp, data: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
    if (handle.orphan || stopped) return null
    const token = handle.token, at = generation, applied = handle.applied
    let reply: Record<string, unknown>
    try { reply = await call(STREAM_OP, { version: STREAM_VERSION, token, op: kind, ...data }, STREAM_OP_WAIT_MS) } catch { return null }
    // A reconnect reuses the handle, but no result from its old connection belongs to the new stream.
    if (stopped || at !== generation || handle.token !== token || byToken.get(token) !== handle) return null
    const answer = answerOf(reply)
    if (!answer || !Object.keys(answer).every(key => ANSWER_KEYS.includes(key)) || !Array.isArray(answer.frames)
      || answer.frames.length > STREAM_FRAMES_MAX || !answer.frames.every(streamFrame) || !streamTurn(answer.turn)
      || (['close', 'abort', 'cancel', 'open'].includes(kind) ? !streamEvents(answer.events) : answer.events !== undefined && !streamEvents(answer.events))) {
      if (reply.error === 'ENGINE_STREAM_GONE') gone(handle)
      return null
    }
    if (!apply(handle, answer.frames)) return null
    const last = (answer.frames as StreamFrame[]).at(-1)?.serial ?? applied
    if (handle.applied <= last && !(handle.closing && answer.turn.identity === data.identity)) handle.turn = answer.turn
    return answer
  }

  /** The worker lost a stream the core still follows: the session is attached again, from what is on disk. */
  const gone = (handle: Handle): void => {
    byToken.delete(handle.token)
    forgetToken(handle.token)
    handle.orphan = true
    const session = deps.bySession(handle.sessionId)
    log(`[engine-others] ${sid(handle.sessionId)} its live stream was given up by the worker · attaching it again`)
    if (!session) { handles.delete(handle.sessionId); return }
    held(session, true, 'lost')
    retryLater(session)
  }

  const handleOf = (session: RegisteredSession, token: string, opened: StreamOpened, store: string | null): Handle => {
    const handle: Handle = {
      engine: session.engine, sessionId: session.sessionId, store, token, applied: 0, turn: opened.turn,
      offset: opened.offset, stamp: opened.stamp, orphan: false, givenUp: false, closing: 0, quietUntil: 0,
      get turnOpen() { return handle.turn.turnOpen },
      closeTurn(reason) {
        handle.turn = { ...handle.turn, turnOpen: false }
        handle.closing++
        void op(handle, reason === 'cancel' ? 'cancel' : 'close', { identity: handle.turn.identity }).finally(() => { handle.closing-- })
      },
    }
    return handle
  }

  const opening = async (session: RegisteredSession, token: string, payload: Record<string, unknown>, current: () => boolean): Promise<StreamOpened | null> => {
    let reply: Record<string, unknown>
    try { reply = await call(STREAM_OPEN, { version: STREAM_VERSION, token, ...payload }, STREAM_OPEN_WAIT_MS) } catch { reply = {} }
    const answer = answerOf(reply)
    if (current() && answer && streamOpened(answer)) return answer
    // Not answered, or not checkable: the worker may hold a stream nobody follows; it is told to forget it.
    forgetToken(token)
    if (!current()) return null
    if (reply.error === 'ENGINE_TRANSCRIPT_CHANGED') {
      log('[engine-others] transcript changed while its reader was unavailable · rebuilding history; missed live events cannot be recovered')
      held(session, true, true)
      retryLater(session)
    } else if (reply.error === undefined || reply.error === 'ENGINE_UNAVAILABLE' || reply.error === 'SERVICE_UNAVAILABLE') {
      unavailable(session)
    } else giveUp(session.sessionId)
    return null
  }
  // A stream given up with its worker connected is left to a discovery pass to revalidate: no connection may come to
  // resume it, and the row would stay held until the daemon restarts (#4362 final review).
  const giveUp = (sessionId: string): void => {
    const handle = handles.get(sessionId)
    if (handle) handle.givenUp = true
  }
  const retryLater = (session: RegisteredSession): void => {
    if (stopped || unopened.has(session.sessionId)) return
    const count = attempts.get(session.sessionId) ?? 0
    if (count >= 5) { log('[engine-others] live reader unavailable after 5 retries · waiting for its next connection'); giveUp(session.sessionId); return }
    if (unopened.size >= STREAMS_MAX || (!attempts.has(session.sessionId) && attempts.size >= STREAMS_MAX)) {
      log('[engine-others] live retry limit reached')
      giveUp(session.sessionId)
      return
    }
    attempts.set(session.sessionId, count + 1)
    const timer = setTimeout(() => {
      if (!connected) return
      unopened.delete(session.sessionId)
      const latest = deps.bySession(session.sessionId)
      if (latest && latest.engine === session.engine) {
        held(latest, false)
        reattach(deps.bySession(session.sessionId)!)
      }
    }, retryMs * 2 ** count)
    timer.unref?.()
    unopened.set(session.sessionId, { timer })
  }

  const unavailable = (session: RegisteredSession): void => {
    held(session, true)
    retryLater(session)
  }

  /** The one wait for what every stream made: running while any is followed, and the worker is there. */
  const wait = async (): Promise<void> => {
    if (waiting || stopped || !connected || !byToken.size) return
    waiting = true
    const at = generation
    let failed = 0
    try {
      while (!stopped && connected && at === generation && byToken.size) {
        const acks = Object.fromEntries([...byToken.values()].map(handle => [handle.token, handle.applied]))
        let reply: Record<string, unknown>
        try { reply = await call(STREAMS_WAIT, { version: STREAM_VERSION, acks }, STREAMS_WAIT_MS + 10_000) } catch { reply = {} }
        if (stopped || at !== generation) return
        const answer = answerOf(reply)
        if (!answer || !Array.isArray(answer.pages) || answer.pages.length > STREAMS_MAX || !Array.isArray(answer.lost) || answer.lost.length > STREAMS_MAX) {
          log('[engine-others] live wait unavailable or invalid · delivery held')
          for (const handle of byToken.values()) {
            const session = deps.bySession(handle.sessionId)
            if (session) held(session, true)
          }
          if (++failed === 5) return
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { endBackoff = undefined; resolve() }, retryMs * 2 ** (failed - 1))
            timer.unref?.()
            endBackoff = () => { clearTimeout(timer); endBackoff = undefined; resolve() }
          })
          continue
        }
        failed = 0
        for (const page of answer.pages) {
          if (!record(page) || typeof page.token !== 'string') continue
          if (!Array.isArray(page.frames) || page.frames.length > STREAM_FRAMES_MAX || !page.frames.every(streamFrame)) {
            const handle = byToken.get(page.token)
            const session = handle && deps.bySession(handle.sessionId)
            if (session) unavailable(session)
            log('[engine-others] live page invalid · delivery held')
            continue
          }
          const handle = byToken.get(page.token)
          if (handle) {
            const session = deps.bySession(handle.sessionId)
            if (session) held(session, false)
            apply(handle, page.frames)
          }
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
    if (!handle.orphan) forgetToken(handle.token)
  }

  return {
    unavailable,
    /** Location is read by the worker; no answer is unavailable, never evidence of no store. */
    async locateStore(session: Pick<RegisteredSession, 'sessionId' | 'engine' | 'hermesHome' | 'openclawStateDir' | 'processIdentity'>): Promise<{ store: string | null; home?: string }> {
      const reply = await call(STREAM_STORE, { version: STREAM_VERSION, session: {
        sessionId: session.sessionId, engine: session.engine, hermesHome: session.hermesHome,
        openclawStateDir: session.openclawStateDir, pid: session.processIdentity?.pid ?? 0,
      } }, STREAM_OP_WAIT_MS)
      const answer = answerOf(reply)
      const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 32_768 && !value.includes('\0') && isAbsolute(value)
      if (!answer || !(answer.store === null || path(answer.store)) || !(answer.home === undefined || path(answer.home))) throw new Error('ENGINE_UNAVAILABLE')
      return { store: answer.store, ...(answer.home === undefined ? {} : { home: answer.home as string }) }
    },
    /** Opens the session's stream: its fold, and the tail or the poll after it. Null when the worker did not answer. */
    async open(session: RegisteredSession, options: OtherStreamOpen): Promise<StreamOpened | null> {
      if (stopped || deferRecovery(session)) return null
      if (!handles.has(session.sessionId) && !pending.has(session.sessionId) && handles.size + pending.size >= STREAMS_MAX) {
        log('[engine-others] live stream limit reached')
        unavailable(session)
        return null
      }
      clearRecovery(session.sessionId)
      const token = randomUUID(), at = generation
      const binding = { ...session }, identity = transcriptReadIdentity(session)
      pending.set(session.sessionId, token)
      const current = (): boolean => {
        const latest = deps.bySession(binding.sessionId)
        return !stopped && at === generation && pending.get(binding.sessionId) === token && !!latest
          && transcriptReadIdentity(latest) === identity
      }
      const opened = await opening(session, token, { live: options.live, abandon: options.abandon, held: options.held,
        session: { agentId: session.agentId, sessionId: session.sessionId, engine: session.engine, transcriptPath: session.transcriptPath ?? null, store: options.store } }, current)
      const accepted = current()
      if (pending.get(session.sessionId) === token) pending.delete(session.sessionId)
      if (!opened || !accepted) return null
      attempts.delete(session.sessionId)
      const handle = handleOf(session, token, opened, options.store)
      const previous = handles.get(session.sessionId)
      handles.set(session.sessionId, handle)
      byToken.set(token, handle)
      if (previous) forgetHandle(previous)
      held(session, false)
      if (!apply(handle, opened.frames)) return null
      void wait()
      return opened
    },
    get: (sessionId: string): OtherStream | undefined => handles.get(sessionId),
    has: (sessionId: string): boolean => handles.has(sessionId),
    /** A retained handle alone is not a running reader: loss and recovery keep its turn state here. */
    ready(sessionId: string): boolean {
      const handle = handles.get(sessionId), session = deps.bySession(sessionId)
      return !!handle && !!session && handle.engine === session.engine && connected && !stopped && waiting && !endBackoff
        && !handle.orphan && !handle.closing && byToken.get(handle.token) === handle
        && !pending.has(sessionId) && !unopened.has(sessionId) && !deps.stopping?.(session)
    },
    /** Whether the reader takes the session's stream up again itself: held, and, its worker here, not given up. */
    follows(sessionId: string): boolean {
      const handle = handles.get(sessionId)
      return !!handle && !(connected && handle.givenUp)
    },
    /** A Stop's or a backstop's close: what the parser emits closing; when the worker does not answer, the core closes the
     *  turn itself and says so, so a Stop never leaves a turn open. */
    async close(sessionId: string, how: { abort?: boolean; error?: boolean; stop?: boolean }): Promise<LiveEvent[]> {
      const handle = handles.get(sessionId)
      if (!handle) return []
      const identity = handle.turn.identity
      const answer = await op(handle, how.abort ? 'abort' : 'close', { identity, error: !!how.error, stop: !!how.stop })
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
      await deps.call(STREAM_OP, { version: STREAM_VERSION, op: 'drain' }, STREAM_OP_WAIT_MS).catch(ignored)
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
      attempts.delete(sessionId)
      clearRecovery(sessionId)
      const token = pending.get(sessionId)
      pending.delete(sessionId)
      if (token) forgetToken(token)
      const handle = handles.get(sessionId)
      if (!handle) return
      handles.delete(sessionId)
      forgetHandle(handle)
    },
    connected(): void {
      if (connected || stopped) return
      connected = true
      attempts.clear()
      generation++
      cancelDeferredRecovery()
      waiting = false
      const at = generation
      const orphans = [...handles.values()].filter(handle => handle.orphan)
      for (const handle of handles.values()) handle.givenUp = false
      if (orphans.length) log(`[engine-others] the other engines' worker is back · following ${orphans.length} conversation(s) again`)
      for (const handle of orphans) void (async () => {
        const session = deps.bySession(handle.sessionId)
        if (!session || session.engine !== handle.engine || handles.get(handle.sessionId) !== handle || deferRecovery(session)) return
        const token = randomUUID(), identity = transcriptReadIdentity(session)
        const opened = await opening(session, token, { live: false, abandon: false, held: false,
          resume: { turnOpen: handle.turnOpen, ...(handle.offset !== undefined ? { offset: handle.offset, ...(handle.stamp !== undefined ? { stamp: handle.stamp } : {}) } : {}) },
          session: { agentId: session.agentId, sessionId: session.sessionId, engine: session.engine, transcriptPath: session.transcriptPath ?? null, store: handle.store } }, () => !stopped && at === generation && handles.get(handle.sessionId) === handle && transcriptReadIdentity(deps.bySession(handle.sessionId)) === identity)
        if (!opened) return
        byToken.delete(handle.token)
        Object.assign(handle, { token, applied: 0, orphan: false, turn: opened.turn, offset: opened.offset ?? handle.offset, stamp: opened.stamp })
        byToken.set(token, handle)
        held(session, false)
        if (!apply(handle, opened.frames)) return
        void wait()
      })()
      for (const [sessionId, recovery] of [...unopened]) {
        if (recovery.stop) continue
        clearRecovery(sessionId)
        const session = deps.bySession(sessionId)
        if (session) { held(session, false); reattach(deps.bySession(sessionId)!) }
      }
      void wait()
    },
    disconnected(): void {
      if (!connected) return
      connected = false
      endBackoff?.()
      generation++
      cancelDeferredRecovery()
      waiting = false
      for (const sessionId of pending.keys()) {
        const session = deps.bySession(sessionId)
        if (session) unavailable(session)
      }
      if (!handles.size) return
      for (const handle of handles.values()) {
        handle.orphan = true
        const session = deps.bySession(handle.sessionId)
        if (session) held(session, true)
      }
      log(`[engine-others] the other engines' worker is gone · ${handles.size} conversation(s) held at what the core took, their panes running on`)
    },
    stop(): void {
      stopped = true
      endBackoff?.()
      generation++
      for (const token of pending.values()) forgetToken(token)
      pending.clear()
      attempts.clear()
      for (const recovery of unopened.values()) clearTimeout(recovery.timer)
      unopened.clear()
      for (const handle of handles.values()) forgetHandle(handle)
      handles.clear()
    },
  }
}

export type OtherStreams = ReturnType<typeof createOtherStreams>
