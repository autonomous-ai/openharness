/**
 * Core's side of an engine's own control connection (Codex's shared app-server), which runs in the engine's
 * worker. Core identifies the conversation (the process table, the session's identity, its store) and keeps
 * every decision: a stop asks core, under a single-use grant, whether it is still wanted, which processes
 * run and whether an unbound chat was never used, and only core signals the client afterwards.
 */
import { randomBytes } from 'node:crypto'
import type { EngineNativeControl, NativeConversation } from '../../engines/facets/nativeControl.js'
import { createNativeStopHost, NATIVE_UNCONFIRMED } from '../../engines/worker/nativeControlHost.js'
import { nativeActivity, nativeConversation, nativeEnvelope, nativeMessage, nativeStopAction, nativeStopAnswer,
  NATIVE_ACTIVITY, NATIVE_ACTIVITY_IN_FLIGHT, NATIVE_ACTIVITY_QUEUED, NATIVE_ACTIVITY_WAIT_MS, NATIVE_CONTROL_CAPABILITIES,
  NATIVE_CONTROL_ENGINES, NATIVE_CONTROL_HOST, NATIVE_CONTROL_VERSION, NATIVE_QUERY_MS, NATIVE_REPLY_BYTES, NATIVE_STOP,
  NATIVE_STOP_IN_FLIGHT, NATIVE_STOP_QUERIES, NATIVE_STOP_WAIT_MS, type NativeStopAnswer } from '../../engines/worker/nativeControlProtocol.js'
import { READER_SERVICES, type ReaderEngine } from '../../engines/worker/protocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { sameProcessIdentity } from '../../lib/terminalRuntime.js'
import type { ProcessRow } from '../../lib/tmux.js'
import type { ActivityState } from '../../lib/turnActivity.js'
import { boundedControl } from './controlTransport.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'

export interface NativeControlsDeps extends SnapshotTransportDeps {
  /** The engine's control runs in its supervised worker. */
  handles(engine: string): boolean
  /** Explicit inline mode and older masters only; a failed worker never selects it. */
  inline(engine: string): EngineNativeControl | undefined
  /** The process table, or null when it could not be read. */
  rows(): Promise<ProcessRow[] | null>
  /** The engine's store for this session (its CODEX_HOME). */
  home(session: RegisteredSession): string
  /** A process's command line as its argv (lib/tmux.ts argvTokens), passed in: the process table's reader
   *  is the terminal layer's, and this broker loads none of it. */
  argv(args: string): string[]
  now?(): number
}

const CANCELLED = 'The close request was cancelled or the session changed'

interface Grant {
  service: string
  current(): boolean
  rows: ProcessRow[]
  unused(): Promise<boolean>
  pending: boolean
  queries: number
}

export function createNativeControls(deps: NativeControlsDeps) {
  const now = deps.now ?? (() => performance.now())
  const kind = { version: NATIVE_CONTROL_VERSION, capabilities: NATIVE_CONTROL_CAPABILITIES, capability: 'nativeControl', replyBytes: NATIVE_REPLY_BYTES }
  const reads = createSnapshotTransport(deps, { ...kind, inFlight: NATIVE_ACTIVITY_IN_FLIGHT, queued: NATIVE_ACTIVITY_QUEUED, waitMs: NATIVE_ACTIVITY_WAIT_MS })
  // Stops are rare and each holds a grant: refused beyond four at once rather than queued behind each other.
  const stops = createSnapshotTransport(deps, { ...kind, inFlight: NATIVE_STOP_IN_FLIGHT, queued: 0, waitMs: NATIVE_STOP_WAIT_MS })
  const grants = new Map<string, Grant>()
  let rowsAt = -Infinity
  let rowsRead: Promise<ProcessRow[] | null> | undefined

  /** The engine process core holds for the session: its identity and executable, never a name or an argv match. */
  const ownerOf = (session: RegisteredSession, rows: ProcessRow[] | null) => rows?.find(row => sameProcessIdentity(row, session.processIdentity)
    && row.executable === session.processIdentity!.executable)
  const conversationOf = (session: RegisteredSession, owner: ProcessRow | undefined): NativeConversation | null => {
    const conversation = { home: deps.home(session), sessionId: session.sessionId, owner: owner ? deps.argv(owner.args) : null }
    return nativeConversation(conversation) ? conversation : null
  }

  /** A stop's question, answered under its grant; anything outside it is refused and ends the grant. */
  const answer = (service: string, query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> | null => {
    if (query !== NATIVE_CONTROL_HOST) return null
    return (async () => {
      const denied = { version: NATIVE_CONTROL_VERSION, error: 'ANSWER_FAILED' }
      if (!nativeEnvelope(payload, ['query', 'token', 'action']) || typeof payload.token !== 'string' || !nativeStopAction(payload.action)) return denied
      const grant = grants.get(payload.token), action = payload.action
      if (!grant || grant.service !== service) return denied
      if (grant.pending || ++grant.queries > NATIVE_STOP_QUERIES) { grants.delete(payload.token); return denied }
      if (action.kind !== 'unused') {
        // Answered from what core holds, in line: whether the stop is still wanted, and the process table
        // it read as the stop began (start markers compared as the table prints them, spacing aside).
        let value: boolean
        try {
          value = action.kind === 'current' ? grant.current() : grant.rows.some(row => row.pid === action.pid
            && row.startMarker.trim().replace(/\s+/g, ' ') === action.startedAt.trim().replace(/\s+/g, ' '))
        } catch { grants.delete(payload.token); return denied }
        // No longer wanted: this stop may do nothing more, whatever it asks next.
        if (!value && action.kind === 'current') grants.delete(payload.token)
        return { version: NATIVE_CONTROL_VERSION, value }
      }
      grant.pending = true
      try { return { version: NATIVE_CONTROL_VERSION, value: await boundedControl(grant.unused(), NATIVE_QUERY_MS, () => new Error(NATIVE_UNCONFIRMED)) } }
      catch { grants.delete(payload.token); return denied }
      finally { grant.pending = false }
    })()
  }

  return {
    answer,

    /** What the engine's server says a conversation is doing; unknown whenever it cannot say. */
    async activity(session: RegisteredSession): Promise<ActivityState> {
      if (!NATIVE_CONTROL_ENGINES.includes(session.engine) || !session.processIdentity) return 'unknown'
      if (!rowsRead || now() - rowsAt > 2_000) { rowsAt = now(); rowsRead = deps.rows() }
      const owner = ownerOf(session, await rowsRead)
      const conversation = owner && conversationOf(session, owner)
      if (!conversation) return 'unknown'
      try {
        const state = deps.handles(session.engine)
          ? await reads.read(session.engine, NATIVE_ACTIVITY, { conversation }, nativeActivity) as ActivityState
          : await deps.inline(session.engine)?.activity(conversation)
        return state ?? 'unknown'
      } catch { return 'unknown' }
    },

    /**
     * Called AFTER a checkpoint and BEFORE signalling the terminal: unload the session's conversation from
     * its engine's server. Throws the person's message when the client must not be signalled.
     */
    async stop(session: RegisteredSession, current: () => boolean, confirmUnusedConversation?: (session: RegisteredSession) => Promise<boolean>): Promise<void> {
      if (!NATIVE_CONTROL_ENGINES.includes(session.engine)) return
      const rows = await deps.rows()
      if (!rows) throw new Error('Could not verify the Codex server before stopping')
      // Close can beat discovery's exit reconciliation: the client has already
      // returned to its shell, with no conversation ever bound. Its checkpoint is
      // saved, and an unrelated shared server is not a reason to keep that pane.
      // Missing/recycled process identity and previously bound conversations still
      // need the normal verification below.
      if (session.processIdentity && !rows.some(row => row.pid === session.processIdentity!.pid)
        && !session.sessionId && !session.transcriptPath && session.boundAt == null && !session.resumeOnly) {
        if (!current()) throw new Error(CANCELLED)
        return
      }
      const conversation = conversationOf(session, ownerOf(session, rows))
      if (!conversation) throw new Error(NATIVE_UNCONFIRMED)
      const engine = session.engine as ReaderEngine
      const token = randomBytes(32).toString('hex')
      grants.set(token, { service: READER_SERVICES[engine], current, rows, pending: false, queries: 0,
        unused: async () => !!await confirmUnusedConversation?.(session) })
      let answered: NativeStopAnswer
      try {
        if (deps.handles(engine)) answered = await stops.read(engine, NATIVE_STOP, { token, conversation }, nativeStopAnswer) as NativeStopAnswer
        else {
          const control = deps.inline(engine)
          if (!control) throw new Error(NATIVE_UNCONFIRMED)
          const host = createNativeStopHost(action => answer(READER_SERVICES[engine], NATIVE_CONTROL_HOST,
            { version: NATIVE_CONTROL_VERSION, token, action })!)
          answered = await boundedControl(control.stop(conversation, host).then(() => ({ stopped: true as const }),
            (error: unknown) => ({ refused: error instanceof Error && nativeMessage(error.message) ? error.message : NATIVE_UNCONFIRMED })),
          NATIVE_STOP_WAIT_MS, () => new Error(NATIVE_UNCONFIRMED))
        }
      } catch { answered = { refused: NATIVE_UNCONFIRMED } }
      finally { grants.delete(token) }
      if ('refused' in answered) throw new Error(answered.refused)
    },

    connected(service: string): void { reads.connected(service); stops.connected(service); revoke(service) },
    disconnected(service: string): void { reads.disconnected(service); stops.disconnected(service); revoke(service) },
    /** The inline control's connections, as the core shuts down; a worker's close with its process. */
    close(): void { for (const engine of NATIVE_CONTROL_ENGINES) deps.inline(engine)?.close() },
  }

  /** A stop never continues on a replaced connection: its grant goes with the one that asked. */
  function revoke(service: string): void {
    for (const [token, grant] of grants) if (grant.service === service) grants.delete(token)
  }
}

export type NativeControls = ReturnType<typeof createNativeControls>
