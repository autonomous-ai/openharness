/**
 * Core's side of an engine's own control connection (Codex's shared app-server), which runs in the engine's
 * worker. Core decides from what it holds and the engine's declared contract (`SharedServerContract`):
 * the process table, the session's identity and store, whether its client owns its conversation, whether the
 * server runs, whether an unbound chat was never used. Only a conversation established to be on a running
 * server goes to the worker, which asks core before each effect under a single-use grant; only core signals
 * the client afterwards. Moved from lib/codexSessionLifecycle.ts, whose outcomes and messages it keeps.
 */
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import type { EngineNativeControl, NativeConversation } from '../../engines/facets/nativeControl.js'
import type { SharedServerContract } from '../../engines/facets/launch.js'
import { createNativeStopHost, NATIVE_UNCONFIRMED } from '../../engines/worker/nativeControlHost.js'
import { boundConversation, nativeActivity, nativeConversation, nativeEnvelope, nativeMessage, nativeStopAction, nativeStopAnswer,
  NATIVE_ACTIVITY, NATIVE_ACTIVITY_IN_FLIGHT, NATIVE_ACTIVITY_QUEUED, NATIVE_ACTIVITY_WAIT_MS, NATIVE_CONTROL_CAPABILITIES,
  NATIVE_CONTROL_HOST, NATIVE_CONTROL_VERSION, NATIVE_RECOVER, NATIVE_RECOVER_WAIT_MS, NATIVE_REPLY_BYTES, NATIVE_STOP,
  NATIVE_STOP_IN_FLIGHT, NATIVE_STOP_QUERIES, NATIVE_STOP_WAIT_MS, type NativeStopAnswer } from '../../engines/worker/nativeControlProtocol.js'
import { READER_SERVICES, type ReaderEngine } from '../../engines/worker/protocol.js'
import { sid } from '../../lib/log.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { sameProcessIdentity } from '../../lib/terminalRuntime.js'
import type { ProcessRow } from '../../lib/tmux.js'
import type { ActivityState } from '../../lib/turnActivity.js'
import { boundedControl } from './controlTransport.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'

export interface NativeControlsDeps extends SnapshotTransportDeps {
  /** The engines whose CLI can leave work on a server of their own, as their launch contracts declare. */
  servers: Readonly<Record<string, SharedServerContract>>
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
  readFile(path: string): Promise<string>
  log?(message: string): void
  now?(): number
}

const CANCELLED = 'The close request was cancelled or the session changed'

interface Grant {
  service: string
  engine: ReaderEngine
  conversation: NativeConversation
  current(): boolean
  queries: number
}

export function createNativeControls(deps: NativeControlsDeps) {
  const now = deps.now ?? (() => performance.now())
  const log = deps.log ?? ((message: string) => console.log(message))
  const kind = { version: NATIVE_CONTROL_VERSION, capabilities: NATIVE_CONTROL_CAPABILITIES, capability: 'nativeControl', replyBytes: NATIVE_REPLY_BYTES }
  const reads = createSnapshotTransport(deps, { ...kind, inFlight: NATIVE_ACTIVITY_IN_FLIGHT, queued: NATIVE_ACTIVITY_QUEUED, waitMs: NATIVE_ACTIVITY_WAIT_MS })
  // Stops are rare and each holds a grant: refused beyond four at once rather than queued behind each other.
  const stops = createSnapshotTransport(deps, { ...kind, inFlight: NATIVE_STOP_IN_FLIGHT, queued: 0, waitMs: NATIVE_STOP_WAIT_MS })
  const recoveries = createSnapshotTransport(deps, { ...kind, inFlight: NATIVE_STOP_IN_FLIGHT, queued: NATIVE_ACTIVITY_QUEUED, waitMs: NATIVE_RECOVER_WAIT_MS })
  const grants = new Map<string, Grant>()
  /** A step a stop said it was taking that must be undone if cut off (Codex's archive), by grant. */
  const repairs = new Map<string, { service: string; engine: ReaderEngine; conversation: NativeConversation }>()
  let rowsAt = -Infinity
  let rowsRead: Promise<ProcessRow[] | null> | undefined

  /** The engine process core holds for the session: its identity and executable, never a name or an argv match. */
  const ownerOf = (session: RegisteredSession, rows: ProcessRow[] | null) => rows?.find(row => sameProcessIdentity(row, session.processIdentity)
    && row.executable === session.processIdentity!.executable)
  /** How the client was started, read from its argv by the engine's declared flags. */
  const startedAs = (server: SharedServerContract, owner: ProcessRow) => {
    const args = deps.argv(owner.args)
    // An interpreter running the CLI's script (`node …/codex.js`): its options start after the script.
    const option = /^node(?:\.exe)?$/.test(basename(args[0] ?? '')) && server.scripts.includes(basename(args[1] ?? '')) ? 2 : 1
    // Harness inserts the owned flag as the FIRST option, before resume/fork or prompt
    // text. A prompt merely mentioning it is not proof of ownership.
    return {
      owned: args[option] === server.ownedFlag,
      remote: args.slice(option).some(arg => arg === server.remoteFlag || arg.startsWith(`${server.remoteFlag}=`)),
    }
  }
  /** The server's own record of its process, in the store; null when it keeps none (older or process-owned). */
  const serverProcess = async (server: SharedServerContract, home: string): Promise<{ pid: number; startedAt: string } | null> => {
    let text: string
    try { text = await deps.readFile(join(home, server.pidFile)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const value = JSON.parse(text)
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.processStartTime !== 'string') throw new Error('Invalid Codex server identity')
    return { pid: value.pid, startedAt: value.processStartTime }
  }
  const sameStart = (a: string, b: string) => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ')

  /** A stop's question, answered under its grant; anything outside it is refused and ends the grant. */
  const answer = (service: string, query: string, payload: Record<string, unknown>): Record<string, unknown> | null => {
    if (query !== NATIVE_CONTROL_HOST) return null
    const denied = { version: NATIVE_CONTROL_VERSION, error: 'ANSWER_FAILED' }
    if (!nativeEnvelope(payload, ['query', 'token', 'action']) || typeof payload.token !== 'string' || !nativeStopAction(payload.action)) return denied
    const token = payload.token, grant = grants.get(token), action = payload.action
    if (!grant || grant.service !== service) return denied
    if (++grant.queries > NATIVE_STOP_QUERIES) { grants.delete(token); return denied }
    // The step is undone, or was never taken: nothing is left to repair.
    if (action.kind === 'settled') { repairs.delete(token); return { version: NATIVE_CONTROL_VERSION, value: true } }
    let value: boolean
    try { value = grant.current() } catch { grants.delete(token); return denied }
    // No longer wanted: this stop may do nothing more, whatever it asks next.
    if (!value) grants.delete(token)
    // Noted before the step is taken: if this worker is lost before `settled`, the next one undoes it.
    else if (action.kind === 'pending') repairs.set(token, { service: grant.service, engine: grant.engine, conversation: grant.conversation })
    return { version: NATIVE_CONTROL_VERSION, value }
  }

  /** What a lost worker's stop may have left, undone once through the worker that replaced it. */
  const recover = async (token: string): Promise<void> => {
    const repair = repairs.get(token)!
    repairs.delete(token)
    const what = `${repair.engine} conversation ${sid(repair.conversation.sessionId)}`
    try {
      const done = await recoveries.read(repair.engine, NATIVE_RECOVER, { conversation: repair.conversation }, value => typeof value === 'boolean')
      log(done ? `[stop] restored the history of ${what}, which a lost worker's stop had archived`
        : `[stop] could not restore the history of ${what}; it may still be archived on its server`)
    } catch { log(`[stop] could not ask the engine's worker to restore ${what}; it may still be archived on its server`) }
  }

  return {
    answer,

    /** What the engine's server says a conversation is doing; unknown whenever it cannot say. */
    async activity(session: RegisteredSession): Promise<ActivityState> {
      const server = deps.servers[session.engine]
      if (!server || !session.processIdentity) return 'unknown'
      if (!rowsRead || now() - rowsAt > 2_000) { rowsAt = now(); rowsRead = deps.rows() }
      const owner = ownerOf(session, await rowsRead)
      if (!owner) return 'unknown'
      const started = startedAs(server, owner)
      const conversation = { home: deps.home(session), sessionId: session.sessionId }
      if (started.owned || started.remote || !nativeConversation(conversation)) return 'unknown'
      try {
        const state = deps.handles(session.engine)
          ? await reads.read(session.engine, NATIVE_ACTIVITY, { conversation }, nativeActivity) as ActivityState
          : await deps.inline(session.engine)?.activity(conversation)
        return state ?? 'unknown'
      } catch { return 'unknown' }
    },

    /**
     * Called AFTER a checkpoint and BEFORE signalling the terminal: unload the session's conversation from its
     * engine's server when it is on one. Throws the person's message when the client must not be signalled.
     * Every decision but the server's protocol is core's, so a stop needs the engine's worker only for a
     * conversation that is on a running server, as the former code needed the server's connection only then.
     */
    async stop(session: RegisteredSession, current: () => boolean, confirmUnusedConversation?: (session: RegisteredSession) => Promise<boolean>): Promise<void> {
      const server = deps.servers[session.engine]
      if (!server) return
      const rows = await deps.rows()
      if (!rows) throw new Error(server.messages.unverified)
      const guard = () => { if (!current()) throw new Error(CANCELLED) }
      // Close can beat discovery's exit reconciliation: the client has already
      // returned to its shell, with no conversation ever bound. Its checkpoint is
      // saved, and an unrelated shared server is not a reason to keep that pane.
      // Missing/recycled process identity and previously bound conversations still
      // need the normal verification below.
      if (session.processIdentity && !rows.some(row => row.pid === session.processIdentity!.pid)
        && !session.sessionId && !session.transcriptPath && session.boundAt == null && !session.resumeOnly) {
        guard()
        return
      }
      const owner = ownerOf(session, rows)
      if (owner) {
        const started = startedAs(server, owner)
        // A remote app-server is not controlled by this machine's profile. Do not
        // report its work stopped merely because its local terminal was closed.
        if (started.remote) throw new Error(server.messages.remote)
        if (started.owned) return
      }
      const home = deps.home(session)
      const daemon = await serverProcess(server, home)
      if (!daemon) return // Older/process-owned engine has no detached writer.
      if (!rows.some(row => row.pid === daemon.pid && sameStart(row.startMarker, daemon.startedAt))) return
      if (!session.sessionId) {
        // An unused TUI has no conversation to unload. Close supplies fresh proof
        // of its empty composer after saving the screen; Pause and uncertain
        // discovery still require an exact conversation identity.
        if (owner && await confirmUnusedConversation?.(session)) {
          guard()
          return
        }
        throw new Error(server.messages.unidentified)
      }
      const conversation = { home, sessionId: session.sessionId }
      if (!boundConversation(conversation)) throw new Error(NATIVE_UNCONFIRMED)
      const engine = session.engine as ReaderEngine, service = READER_SERVICES[engine]
      const token = randomBytes(32).toString('hex')
      grants.set(token, { service, engine, conversation, current, queries: 0 })
      let answered: NativeStopAnswer | null = null
      try {
        if (deps.handles(engine)) answered = await stops.read(engine, NATIVE_STOP, { token, conversation }, nativeStopAnswer) as NativeStopAnswer
        else {
          const control = deps.inline(engine)
          if (!control) throw new Error(NATIVE_UNCONFIRMED)
          const host = createNativeStopHost(async action => answer(service, NATIVE_CONTROL_HOST, { version: NATIVE_CONTROL_VERSION, token, action })!)
          answered = await boundedControl(control.stop(conversation, host).then(() => ({ stopped: true as const }),
            (error: unknown) => ({ refused: error instanceof Error && nativeMessage(error.message) ? error.message : NATIVE_UNCONFIRMED })),
          NATIVE_STOP_WAIT_MS, () => new Error(NATIVE_UNCONFIRMED))
        }
      } catch {
        // The worker did not answer: as when the former in-process connection to the server failed, the
        // stop is not confirmed and the client is not signalled. A step it noted stays to be undone.
        log(`[stop] ${sid(session.agentId)} the ${engine} worker did not answer the stop; its conversation is not confirmed stopped, and its pane stays`)
      }
      finally {
        grants.delete(token)
        // Answered, the worker made its own attempt to undo its step; only a lost one leaves it to repair.
        if (answered || !deps.handles(engine)) repairs.delete(token)
      }
      if (!answered) throw new Error(NATIVE_UNCONFIRMED)
      if ('refused' in answered) throw new Error(answered.refused)
    },

    connected(service: string): void {
      reads.connected(service); stops.connected(service); recoveries.connected(service); revoke(service)
      for (const [token, repair] of repairs) if (repair.service === service) void recover(token)
    },
    disconnected(service: string): void { reads.disconnected(service); stops.disconnected(service); recoveries.disconnected(service); revoke(service) },
    /** The inline control's connections, as the core shuts down; a worker's close with its process. */
    close(): void { for (const engine of Object.keys(deps.servers)) deps.inline(engine)?.close() },
  }

  /** A stop never continues on a replaced connection: its grant goes with the one that asked. */
  function revoke(service: string): void {
    for (const [token, grant] of grants) if (grant.service === service) grants.delete(token)
  }
}

export type NativeControls = ReturnType<typeof createNativeControls>
