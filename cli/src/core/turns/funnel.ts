/**
 * The event funnel: the one place a session's live events fan out from, to the app, search, input, the
 * teams, the device's input, the device service, the heartbeat, the question watcher and the recaps. The
 * order is exact and it matters: per event, the frame goes to the app before anything acts on it; the
 * recaps hear the whole batch after the loop; the device stream comes last and never on a replay.
 *
 * Until the core has built what the funnel feeds, events wait: a hook can register a session the instant
 * the hook server binds. `arm` installs the funnel and delivers what waited, in order. `emit` is the same
 * function before and after, so whoever holds it keeps a working funnel.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 8: docs/design/2026-10-03-harnessd.md).
 */
import { correlateAgentEvent } from '../../lib/agentEvent.js'
import type { AutonomousDeviceInput } from '../deviceInput.js'
import { isDeviceInputBoundary } from '../deviceInput.js'
import type { WifiFeed } from '../wifi.js'
import type { CommanderMirror } from '../../lib/commander.js'
import { deviceErrorText } from '../cardText.js'
import { preview, sid } from '../../lib/log.js'
import type { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import type { QuestionWatcher } from '../../lib/askQuestion.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import type { TurnActivity } from '../../lib/turnActivity.js'
import type { SwarmPromptScopes } from '../../teams/promptScope.js'

type Events = ReturnType<CursorNormalizer['ingest']>
type EmitOptions = { resumed?: boolean; replay?: boolean }
type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface FunnelClients {
  /** The app. */
  send(frame: Frame): void
  /** The dial. */
  sendCommander(frame: Frame): void
}

/** What the funnel feeds, built by the time it is armed. */
export interface FunnelDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  tokenUsage: { changed(target: RegisteredSession): void }
  agentIdFor: (sessionId: string) => string
  turnActivity: Pick<TurnActivity, 'observe' | 'snapshot'>
  isSubagentSession: (sessionId: string) => boolean
  clients: Pick<FunnelClients, 'send'>
  search: { touch(sessionId: string): void } | null | undefined
  turnStartedAt: Map<string, number>
  input: Pick<SessionInputController, 'onTurnStarted' | 'onTurnEnded'>
  teams: Pick<SwarmPromptScopes, 'started'>
  deviceInput: Pick<AutonomousDeviceInput, 'onTurnStarted' | 'onTurnEnded'>
  device: () => Pick<WifiFeed, 'turnStarted' | 'turnEnded' | 'stream'> | undefined
  startHeartbeat: (sessionId: string) => void
  questionWatcher: Pick<QuestionWatcher, 'start' | 'noteTurnStart' | 'stop'>
  mirror: Pick<CommanderMirror, 'ingest'>
  /** How a consumer outside the core is called ([outsideConsumers]). */
  outside?: OutsideConsumers
}

type OutsideConsumers = (consumer: string, call: () => void) => void

/**
 * A consumer outside the core — the teams and the device service — answers for itself: one that
 * throws is logged, at most once a minute per consumer and with how many were not, and every consumer
 * after it still gets the event. The heartbeat, the question watcher and the recaps must not miss a
 * turn because a device was unplugged mid-call. The services on the boundary are guarded the same way
 * (core/serviceHost.ts), and so are the dial and the window bridges on the local socket (cli.ts).
 */
export function outsideConsumers(options: {
  log?: (line: string) => void
  now?: () => number
  /** What the lines start with: `[funnel]` by default. */
  prefix?: string
  /** Consumers to fail on every call, for the end-to-end suite only (`HARNESSD_TEST_FAULTS`). */
  faults?: ReadonlySet<string>
} = {}): OutsideConsumers {
  const log = options.log ?? ((line: string) => console.error(line))
  const now = options.now ?? Date.now
  const prefix = options.prefix ?? 'funnel'
  const said = new Map<string, { at: number; quiet: number }>()
  return (consumer, call) => {
    try {
      if (options.faults?.has(consumer)) throw new Error(`injected fault: ${consumer}`)
      call()
    } catch (error) {
      const at = now()
      const last = said.get(consumer)
      if (last && at - last.at < 60_000) { last.quiet++; return }
      log(`[${prefix}] ${consumer} failed · ${error instanceof Error ? error.message : String(error)}${last?.quiet ? ` · ${last.quiet} more since` : ''}`)
      said.set(consumer, { at, quiet: 0 })
    }
  }
}

/** The funnel itself, over what it feeds. */
export function funnelFor({
  bySession, tokenUsage, agentIdFor, turnActivity, isSubagentSession, clients, search, turnStartedAt, input, teams,
  deviceInput, device, startHeartbeat, questionWatcher, mirror, outside = outsideConsumers(),
}: FunnelDeps) {
  return (sessionId: string, events: Events, opts?: EmitOptions): void => {
    if (!events.length || !bySession(sessionId)?.active) return
    const usageSession = bySession(sessionId)
    if (usageSession?.engine === 'opencode') tokenUsage.changed(usageSession)
    for (const [eventIndex, event] of events.entries()) {
      const agentId = agentIdFor(sessionId)
      const replay = !!(opts?.resumed || opts?.replay)
      turnActivity.observe(sessionId, event.type, replay)
      const frame = correlateAgentEvent({ ...event, payload: { ...event.payload, activity: turnActivity.snapshot(sessionId) } }, sessionId, agentId)
      // A `turn_started` that is not a turn starting NOW — a turn picked back up at attach, or a prompt
      // re-read from a transcript that was already on disk — says so in the clear, beside `agentId`
      // (the payload is E2EE; the backend can only read the envelope). The backend's daily turn count
      // skips these; every other consumer ignores an unknown field. Measured before this existed: one
      // agent credited with 42 turns in a single second, all re-reads.
      if (replay) { frame.replay = true; frame.payload.replay = true }
      // The end of a turn carries the two facts an app needs to decide whether it is NEWS, in the clear
      // beside `agentId` for the same reason `replay` is — the payload is E2EE and the apps read this
      // without opening it:
      //   `replay`   — a turn re-read from disk, not one finishing now;
      //   `subagent` — a specialist's turn nobody asked to hear about, the dial's `silent`. The dial has
      //                always been told and the window never was, so an Orchestrator project of four
      //                specialists put ONE row on the dial and FIVE marks in the window. Same predicate
      //                for every screen now — see isSubagentSession.
      // The phone notifies on neither. Absent = false, so a client that predates these reads every end as
      // it always did.
      if (event.type === 'turn_ended') {
        if (opts?.resumed || opts?.replay) frame.replay = true
        if (isSubagentSession(sessionId)) frame.subagent = true
      }
      clients.send(frame)
      if (event.type === 'turn_started' || event.type === 'turn_ended') search?.touch(sessionId)
      if (event.type === 'turn_started') {
        turnStartedAt.set(sessionId, Date.now())
        console.log(`[turn] ${sid(sessionId)} started · engine=${bySession(sessionId)?.engine ?? 'claude'} · bytes=${Buffer.byteLength(event.payload.userMessage, 'utf8')}`)
        input.onTurnStarted(agentIdFor(sessionId), event.payload.userMessage)
        if (!opts?.resumed && !opts?.replay) outside('teams', () => teams.started(agentId, event.payload.userMessage, 'transcript', bySession(sessionId)?.engine))
        deviceInput.onTurnStarted(agentId, event.payload.userMessage)
        outside('devices', () => device()?.turnStarted(agentId))
        startHeartbeat(sessionId)
        questionWatcher.start(sessionId)   // Claude opens its dialog INSIDE a turn
        // ...and anything already drawn belongs to the turn BEFORE this one — unless this is a turn the
        // daemon is picking back up at attach: a dialog on the pane then is THIS turn's, still waiting,
        // and marking it pre-turn is how a restarted daemon never announced a question Codex had open.
        if (!opts?.resumed) questionWatcher.noteTurnStart(sessionId)
      } else if (event.type === 'turn_ended') {
        const startedAt = turnStartedAt.get(sessionId)
        turnStartedAt.delete(sessionId)
        // Say when a turn was KILLED. The log previously showed an interrupt as a fresh `[turn] started
        // "[Request interrupted by user]"`, which read like a new prompt and hid the bug for weeks.
        console.log(
          `[turn] ${sid(sessionId)} ended${event.payload.aborted ? ' · aborted (interrupted)' : ''}` +
            `${startedAt ? ` · ${Date.now() - startedAt}ms` : ''}`,
        )
        // Filter only the Device receipt view; shared normalizers, mirror, and local input stay unchanged.
        if (!isDeviceInputBoundary(usageSession?.engine ?? '', events, eventIndex)) {
          outside('devices', () => device()?.turnEnded(agentId, event.payload.aborted === true))
          deviceInput.onTurnEnded(agentId)
        }
        input.onTurnEnded(agentIdFor(sessionId))
        // Command Code asks AFTER the turn: `ask_user_question` ends the turn (its Stop hook fires), the
        // dialog goes up, and the answer opens a NEW turn. Stopping the watcher here is what left the
        // terminal sitting on a question the device never showed. Its watcher runs off the session, not
        // the turn — see the attach path — so leave it alone.
        if (bySession(sessionId)?.engine !== 'commandcode') questionWatcher.stop(sessionId)
        // Do NOT stop the heartbeat here: the turn is closed but the device summarize is just starting
        // (mirror sets summarizing=true in the mirror.ingest below). The timer keeps fanning "Summarizing…"
        // to the device and self-cancels once mirror.heartbeat() reports idle (summary done).
      }
    }
    mirror.ingest(events, sessionId, { replay: !!(opts?.resumed || opts?.replay) })
    // Subscribed devices only (lib/autonomous-device/stream.ts). A transcript re-read is history, not live.
    if (!opts?.replay) outside('devices', () => device()?.stream(agentIdFor(sessionId), events))
  }
}

export function createEventFunnel({ clients, agentIdFor }: { clients: FunnelClients; agentIdFor: (sessionId: string) => string }) {
  const queuedSessionEvents: Array<{ sessionId: string; events: Events; opts?: EmitOptions }> = []
  let funnel: ((sessionId: string, events: Events, opts?: EmitOptions) => void) | null = null
  const emit = (sessionId: string, events: Events, opts?: EmitOptions): void => {
    if (funnel) funnel(sessionId, events, opts)
    else if (events.length) queuedSessionEvents.push({ sessionId, events, opts })
  }
  /** Install the funnel and deliver what waited for it, in order. */
  const arm = (deps: FunnelDeps): void => {
    funnel = funnelFor(deps)
    for (const queued of queuedSessionEvents.splice(0)) funnel(queued.sessionId, queued.events, queued.opts)
  }
  /**
   * A turn died inside the engine instead of finishing. Neither devin nor commandcode has a StopFailure
   * hook, so nothing else would tell the clients: the web would sit on the typing indicator and the
   * device tile would stay "Working…". Surface the failure to both; the CALLER closes the turn (the devin
   * reader and the commandcode normalizer each own their own turn state).
   */
  const announceTurnAborted = (
    sessionId: string,
    engine: string,
    message: string,
    deviceMessage = message,
  ): void => {
    console.log(`[turn] ${sid(sessionId)} aborted by ${engine} error · ${preview(message)}`)
    clients.send({ type: 'error', agentId: agentIdFor(sessionId), dbSessionId: sessionId, payload: { message } })
    clients.sendCommander({
      type: 'commander_event',
      agentId: agentIdFor(sessionId),
      dbSessionId: sessionId,
      payload: { kind: 'error', text: deviceErrorText(deviceMessage, engine) },
    })
  }
  return { emit, arm, announceTurnAborted }
}

export type EventFunnel = ReturnType<typeof createEventFunnel>
