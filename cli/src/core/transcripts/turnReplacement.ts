import type { LiveState } from '../../engines/facets/live.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { recoveryBoundary, type RecoveryBoundary } from '../../lib/transcriptBoundary.js'
import type { TranscriptClose } from '../../lib/transcriptControls.js'
import type { SessionNormalizers } from './normalizers.js'

export interface ReplacementPlan { readonly revision: number; readonly closes: readonly TranscriptClose[] }

/** Control remains eager while interpretation is replaced. A cancellation is replayed at its original
 * file boundary, never against whichever turn a later retry happens to hydrate. Uncorrelated Stop
 * intent remains visible until native evidence can resolve it. */
export function createTurnReplacements(normalizers: Pick<SessionNormalizers, 'liveParsers' | 'sessionTurnState'>) {
  const pending = new Map<string, ReturnType<typeof create>>()
  let generation = 0
  const create = (session: RegisteredSession, active = true) => {
    const id = session.sessionId
    const binding = JSON.stringify([session.agentId, id, session.engine])
    let transcriptPath = session.transcriptPath
    let state = normalizers.liveParsers.get(id)?.snapshot()
      ?? { identity: `held:${++generation}`, turnOpen: normalizers.sessionTurnState(id) ?? false, continued: false }
    let revision = 0, stopRevision = 0, cancelRevision = 0, failure: string | undefined
    const boundaries: RecoveryBoundary[] = []
    const verify = (): void => {
      if (failure) throw new Error(failure)
      for (const boundary of boundaries) recoveryBoundary(transcriptPath!, boundary)
    }
    const stop = (): void => { stopRevision = ++revision }
    const handle: LiveState = {
      engine: session.engine,
      get turnOpen() { return state.turnOpen },
      snapshot: () => ({ ...state }),
      closeTurn(reason) {
        state = { ...state, turnOpen: false }
        revision++
        if (reason !== 'cancel') { stop(); return }
        try {
          if (!transcriptPath) throw new Error('the native store has no file cancellation boundary')
          const boundary = recoveryBoundary(transcriptPath)
          const last = boundaries.at(-1)
          // A new explicit cancellation also closes the current incarnation after a rewrite. This is
          // a new control decision, never a retry moving the old decision to a more convenient EOF.
          if (last) {
            try { recoveryBoundary(transcriptPath, last) }
            catch { boundaries.length = 0 }
          }
          const current = boundaries.at(-1)
          if (current?.offset === boundary.offset) { recoveryBoundary(transcriptPath, current); cancelRevision = revision; failure = undefined; return }
          if (boundaries.length === 128) throw new Error('too many unresolved cancellation boundaries')
          boundaries.push(boundary)
          cancelRevision = revision
          failure = undefined
        } catch (error) { failure = error instanceof Error ? error.message : String(error) }
      },
    }
    const replacement = {
      binding, handle, stop,
      cancel(path: RegisteredSession['transcriptPath']): string | undefined {
        transcriptPath = path
        handle.closeTurn('cancel')
        return failure
      },
      activate(path: RegisteredSession['transcriptPath']): void {
        if (!active) {
          state = normalizers.liveParsers.get(id)?.snapshot()
            ?? { ...state, turnOpen: normalizers.sessionTurnState(id) ?? state.turnOpen }
          active = true; revision++
        }
        if (path !== transcriptPath) { transcriptPath = path; revision++ }
        normalizers.liveParsers.set(id, handle)
      },
      plan(): ReplacementPlan {
        verify()
        return { revision, closes: boundaries.map(boundary => ({ offset: boundary.offset, reason: 'cancel', boundary: { ...boundary } })) }
      },
      check(plan: ReplacementPlan): void {
        if (revision !== plan.revision) throw new Error('turn control changed while interpretation was being prepared')
        verify()
        // Even a naturally closed fold may predate this Stop's opener. Only a later explicit cancel
        // supersedes uncorrelated completion intent; parser availability does not grant that authority.
        if (stopRevision > cancelRevision) throw new Error('Stop could not be matched to its turn; Cancel can resolve this hold')
      },
      commit(plan: ReplacementPlan, next?: LiveState): boolean {
        if (!active || pending.get(id) !== replacement || normalizers.liveParsers.get(id) !== handle) return false
        replacement.check(plan)
        active = false
        if (!boundaries.length && !stopRevision) pending.delete(id)
        if (next) normalizers.liveParsers.set(id, next)
        else normalizers.liveParsers.delete(id)
        return true
      },
    }
    if (active) normalizers.liveParsers.set(id, handle)
    return replacement
  }
  const stage = (session: RegisteredSession) => {
    const previous = pending.get(session.sessionId)
    if (previous && previous.binding === JSON.stringify([session.agentId, session.sessionId, session.engine])) {
      previous.activate(session.transcriptPath)
      return previous
    }
    const replacement = create(session)
    pending.set(session.sessionId, replacement)
    return replacement
  }
  const remember = (session: RegisteredSession) => {
    let record = pending.get(session.sessionId)
    if (record?.binding !== JSON.stringify([session.agentId, session.sessionId, session.engine])) {
      record = create(session, false)
      pending.set(session.sessionId, record)
    }
    return record
  }
  return { stage,
    retains: (session: RegisteredSession) => pending.get(session.sessionId)?.binding === JSON.stringify([session.agentId, session.sessionId, session.engine]),
    cancel: (session: RegisteredSession) => remember(session).cancel(session.transcriptPath),
    stop: (session: RegisteredSession) => remember(session).stop(),
    forget: (sessionId: string) => { pending.delete(sessionId) },
  }
}
