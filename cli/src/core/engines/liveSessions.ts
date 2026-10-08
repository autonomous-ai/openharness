import { randomUUID } from 'node:crypto'
import type { LiveState } from '../../engines/facets/live.js'
import type { LiveFrame, LivePage, LivePull } from '../../engines/worker/liveProtocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { HOLD_TIMEOUT_MS, type TailHold } from '../../watcher/watcher.js'
import { transcriptReadIdentity } from '../transcripts/readIdentity.js'
import { EngineLiveError, type LiveTransport } from './liveTransport.js'

interface SessionState {
  ask: LivePull
  identity: string
  epoch: number
  handle: LiveState
}
interface Tail {
  path: string
  dirty: boolean
  running: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  holds: Set<TailHold>
  unheld: Promise<void> | null
  release: (() => void) | null
  moves: number
  offset: number | null
  rewritten: boolean
}
export interface PreparedLive {
  state: SessionState
  parent: SessionState | undefined
  parentEpoch: number | undefined
  moves: number
  page: LivePage
  records: number
  content: boolean
}
export interface LiveSessionDeps {
  handles(engine: string): boolean
  transport: LiveTransport
  bySession(id: string): RegisteredSession | undefined
  frame(session: RegisteredSession, frame: LiveFrame): void
  /** Reduce side evidence before acknowledging the page; the returned commit must be synchronous. */
  prepareFrames?(session: RegisteredSession, frames: readonly LiveFrame[]): Promise<() => boolean>
  reattach(session: RegisteredSession): Promise<unknown>
  watch(path: string): void
  unwatch(path: string): void
  log?(message: string): void
}

/** Core retains only binding facts and the last accepted checkpoint. Unread events stay on disk. */
export function createLiveSessions(deps: LiveSessionDeps) {
  const states = new Map<string, SessionState>()
  const firstLive = new Map<string, string>()
  const tails = new Map<string, Tail>()
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const queues = new Map<string, Promise<void>>()
  const queued = new Map<string, number>()
  const errors = new Map<string, string>()
  let stopped = false
  const valid = (s: SessionState): boolean => !stopped && s.identity === transcriptReadIdentity(deps.bySession(s.ask.session.sessionId))
  const report = (id: string, error: unknown): void => {
    const code = error instanceof Error ? error.message : String(error)
    if (errors.get(id) === code) return
    errors.set(id, code)
    ;(deps.log ?? console.warn)(`[engine] ${id} transcript paused at its acknowledged position · ${code}`)
  }
  const slot = async <T>(engine: string, run: () => Promise<T>): Promise<T> => {
    if ((queued.get(engine) ?? 0) >= 256) throw new EngineLiveError('ENGINE_BUSY')
    queued.set(engine, (queued.get(engine) ?? 0) + 1)
    const before = queues.get(engine) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    queues.set(engine, current)
    await before
    try { return await run() } finally {
      queued.set(engine, queued.get(engine)! - 1); release()
      if (queues.get(engine) === current) queues.delete(engine)
    }
  }
  const pull = (ask: LivePull) => slot(ask.session.engine, () => {
    if (stopped) throw new EngineLiveError('ENGINE_UNAVAILABLE')
    return deps.transport.pull(ask)
  })
  // Forget shares the worker's one request slot with pulls. Otherwise activating a replacement can
  // make its first read fail ENGINE_BUSY while the old parser is still being released.
  const forget = (engine: string, token: string): void => {
    void slot(engine, () => deps.transport.forget(engine, token)).catch(() => {})
  }
  const makeState = (session: RegisteredSession, live: boolean, end?: number): SessionState => {
    const state: SessionState = { identity: transcriptReadIdentity(session), epoch: 0,
      ask: { token: randomUUID(), session: { agentId: session.agentId, sessionId: session.sessionId,
        engine: session.engine, transcriptPath: session.transcriptPath, cwd: session.cwd, model: session.model,
        cliVersion: session.cliVersion, codexHome: session.codexHome }, cursor: null, fromStart: live,
        replay: false, liveStart: live, ...(end === undefined ? {} : { end }),
        ...(tails.get(session.sessionId)?.rewritten ? { rewritten: true } : {}) },
      handle: {
        engine: session.engine,
        // Handles escape prepare only after the worker has supplied a validated cursor.
        get turnOpen() { return state.ask.cursor!.turn.turnOpen },
        snapshot: () => ({ ...state.ask.cursor!.turn }),
        closeTurn(reason) {
          const cursor = state.ask.cursor!
          // An in-flight reply predates this decision and cannot overwrite it. Reconstructing from this
          // checkpoint applies the engine's own close semantics before reading unseen records.
          state.epoch++
          state.ask.cursor = { ...cursor, closed: reason, turn: { ...cursor.turn, turnOpen: false } }
          schedule(session.sessionId)
        },
      },
    }
    return state
  }
  const retry = (session: RegisteredSession): void => {
    const id = session.sessionId, identity = transcriptReadIdentity(session)
    if (stopped || retries.has(id)) return
    retries.set(id, setTimeout(() => {
      retries.delete(id)
      if (identity !== transcriptReadIdentity(deps.bySession(id))) return
      void deps.reattach(session).catch(error => { report(id, error); retry(session) })
    }, 1_000))
  }
  function schedule(id: string, delay = 40): void {
    const tail = tails.get(id)
    if (!tail || stopped) return
    tail.dirty = true
    if (tail.timer || tail.running || tail.holds.size || tail.offset !== null) return
    tail.timer = setTimeout(() => {
      tail.timer = null
      void pollSession(id).catch(error => { report(id, error); schedule(id, 1_000) })
    }, delay)
  }
  async function pollSession(id: string): Promise<void> {
    const tail = tails.get(id)
    if (!tail || stopped) return
    if (tail.unheld) await tail.unheld
    if (tail.running) return tail.running
    if (tail.offset !== null || tails.get(id) !== tail) return
    tail.dirty = false
    tail.running = (async () => {
      let more = true
      while (more && !stopped && tails.get(id) === tail && !tail.holds.size && tail.offset === null) {
        const state = states.get(id)
        if (!state || !valid(state)) return
        const epoch = state.epoch
        let page: LivePage
        try { page = await pull({ ...state.ask }) }
        catch (error) {
          if (error instanceof EngineLiveError && error.code === 'ENGINE_TRANSCRIPT_CHANGED') {
            // No cursor from the changed file is accepted. Re-attach under a hold and a new identity.
            tail.rewritten = true
            const session = deps.bySession(id)
            if (session) retry(session)
          }
          throw error
        }
        if (!valid(state) || states.get(id) !== state || state.epoch !== epoch) return
        const session = deps.bySession(id)!
        if (deps.prepareFrames) {
          const commit = await deps.prepareFrames(session, page.frames)
          if (!valid(state) || states.get(id) !== state || state.epoch !== epoch) return
          if (!commit()) throw new EngineLiveError('ENGINE_STALE_REPLY')
        }
        state.ask.cursor = page.cursor
        errors.delete(id)
        for (const frame of page.frames) {
          try { deps.frame(session, frame) } catch (error) { report(id, error) }
        }
        more = page.more
      }
    })()
    let failed = false
    try { await tail.running } catch (error) { failed = true; tail.dirty = true; throw error } finally {
      tail.running = null
      if (tail.dirty) schedule(id, failed ? 1_000 : 40)
    }
  }
  const removeSession = async (id: string): Promise<void> => {
    firstLive.delete(id)
    const state = states.get(id); states.delete(id)
    if (state) { state.epoch++; forget(state.ask.session.engine, state.ask.token) }
    const tail = tails.get(id); tails.delete(id)
    if (tail) {
      if (tail.timer) clearTimeout(tail.timer)
      for (const hold of [...tail.holds]) hold.release()
      if (![...tails.values()].some(other => other.path === tail.path)) deps.unwatch(tail.path)
    }
    const timer = retries.get(id)
    if (timer) clearTimeout(timer)
    retries.delete(id); errors.delete(id)
  }
  return {
    handles: deps.handles,
    current(session: RegisteredSession): boolean { return states.get(session.sessionId)?.identity === transcriptReadIdentity(session) },
    async prepare(session: RegisteredSession, options: { live: boolean; end?: number }, observe: (frame: LiveFrame) => void,
      observePage?: (frames: readonly LiveFrame[]) => Promise<void>): Promise<PreparedLive> {
      // A retry has no original attach flags. Keep first-turn delivery intent until activation;
      // otherwise a failed first prepare turns the user's completed first response into silent history.
      if (options.live) firstLive.set(session.sessionId, transcriptReadIdentity(session))
      const state = makeState(session, firstLive.get(session.sessionId) === transcriptReadIdentity(session), options.end)
      const parent = states.get(session.sessionId), parentEpoch = parent?.epoch
      const moves = tails.get(session.sessionId)?.moves ?? 0
      let records = 0, content = false
      try {
        for (;;) {
          const page = await pull(state.ask)
          if (!valid(state)) throw new EngineLiveError('ENGINE_STALE_REPLY')
          if (observePage) {
            await observePage(page.frames)
            if (!valid(state)) throw new EngineLiveError('ENGINE_STALE_REPLY')
          }
          state.ask.cursor = page.cursor; records += page.records; content ||= page.content
          for (const frame of page.frames) observe(frame)
          if (page.prepared) return { state, parent, parentEpoch, moves, page, records, content }
        }
      } catch (error) {
        forget(session.engine, state.ask.token)
        report(session.sessionId, error)
        throw error
      }
    },
    install(prepared: PreparedLive): boolean {
      const { state, parent, parentEpoch, moves } = prepared, id = state.ask.session.sessionId
      if (!valid(state) || states.get(id) !== parent || parent?.epoch !== parentEpoch || (tails.get(id)?.moves ?? 0) !== moves) return false
      states.set(id, state)
      firstLive.delete(id)
      const tail = tails.get(id)
      if (tail) { tail.offset = null; tail.rewritten = false }
      errors.delete(id)
      const timer = retries.get(id)
      if (timer) clearTimeout(timer)
      retries.delete(id)
      if (parent) forget(parent.ask.session.engine, parent.ask.token)
      return true
    },
    discard(prepared: PreparedLive): void {
      forget(prepared.state.ask.session.engine, prepared.state.ask.token)
    },
    retry,
    async follow(session: RegisteredSession): Promise<void> {
      const id = session.sessionId, path = session.transcriptPath
      if (!path || !states.has(id)) return
      const previous = tails.get(id)
      if (previous?.path === path) { schedule(id); return }
      if (previous) {
        tails.delete(id)
        if (previous.timer) clearTimeout(previous.timer)
        for (const hold of [...previous.holds]) hold.release()
        if (![...tails.values()].some(other => other.path === previous.path)) deps.unwatch(previous.path)
      }
      tails.set(id, { path, dirty: false, running: null, timer: null, holds: new Set(), unheld: null,
        release: null, moves: 0, offset: null, rewritten: false })
      deps.watch(path)
      // First-turn delivery follows activation. It never builds one unbounded initialEvents array.
      await pollSession(id).catch(error => { report(id, error); schedule(id, 1_000) })
    },
    changed(path: string): void { for (const [id, tail] of tails) if (tail.path === path) schedule(id) },
    tails(id: string, path: string): boolean { return tails.get(id)?.path === path },
    async hold(id: string, path: string, timeoutMs = HOLD_TIMEOUT_MS): Promise<TailHold | null> {
      const tail = tails.get(id)
      if (!tail || tail.path !== path) return null
      let expired = false, released = false
      let offset = 0
      const hold: TailHold = {
        get offset() { return offset }, get expired() { return expired },
        // Installation already puts the precise new cursor in the session. A released hold cannot
        // move it back after a reset or an explicit setTail changed the transcript underneath it.
        release() {
          if (released) return
          released = true; clearTimeout(timer); tail.holds.delete(hold)
          if (!tail.holds.size) { tail.release?.(); tail.release = null; tail.unheld = null; schedule(id) }
        },
      }
      const timer = setTimeout(() => { expired = true; hold.release() }, timeoutMs)
      if (!tail.holds.size) tail.unheld = new Promise(resolve => { tail.release = resolve })
      tail.holds.add(hold)
      await tail.running?.catch(() => {})
      offset = tail.offset ?? states.get(id)?.ask.cursor?.offset ?? 0
      return hold
    },
    setTail(id: string, offset: number): void {
      const tail = tails.get(id), state = states.get(id)
      if (!tail || !state) return
      state.epoch++; tail.moves++; tail.offset = offset; tail.rewritten = false
      const session = deps.bySession(id)
      if (session) retry(session)
    },
    pollSession,
    async pollAll(): Promise<void> { await Promise.all([...tails.keys()].map(id => pollSession(id).catch(error => { report(id, error); schedule(id, 1_000) }))) },
    removeSession,
    async stop(): Promise<void> {
      stopped = true
      await Promise.all([...new Set([...states.keys(), ...tails.keys(), ...retries.keys(), ...firstLive.keys()])].map(removeSession))
    },
  }
}

export type LiveSessions = ReturnType<typeof createLiveSessions>
