/**
 * The event funnel: the one place a session's live events fan out from, to the app, search, input, the
 * heartbeat, the question watcher and the recaps. The
 * order is exact and it matters: per event, the frame goes to the app before anything acts on it; the
 * recaps hear the whole batch after the loop. Negotiated app consumers receive its batch identity.
 *
 * Until the core has built what the funnel feeds, events wait: a hook can register a session the instant
 * the hook server binds. `arm` installs the funnel and delivers what waited, in order. `emit` is the same
 * function before and after, so whoever holds it keeps a working funnel.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 8: docs/design/2026-10-03-harnessd.md).
 */
import { withoutOutputTail } from '../../lib/cardUpdate.js'
import { correlateAgentEvent } from '../../lib/agentEvent.js'
import type { TurnRecaps } from './recaps.js'
import type { QuietTitles } from '../agents/quietTitles.js'
import type { ShortTurnGuard } from './shortTurnGuard.js'
import type { SessionFailure } from '../api.js'
import { errorKind, preview, sid } from '../../lib/log.js'
import type { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import type { QuestionWatcher } from '../../lib/questionController.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import { promptLine } from '../../lib/activitySummary.js'
import { isProgressEvent, type TurnActivity } from '../../lib/turnActivity.js'
import type { SessionEventBatch } from '../../lib/sessionEvents.js'

type Events = ReturnType<CursorNormalizer['ingest']>
type EmitOptions = { resumed?: boolean; replay?: boolean }
type Frame = { type: string; agentId?: string; dbSessionId?: string; payload: Record<string, unknown> }

export interface FunnelClients {
  /** The app. */
  send(frame: Frame, batch?: SessionEventBatch): void
}

/** What the funnel feeds, built by the time it is armed. */
export interface FunnelDeps {
  bySession: (sessionId: string) => RegisteredSession | undefined
  tokenUsage: { changed(target: RegisteredSession): void }
  agentIdFor: (sessionId: string) => string
  turnActivity: Pick<TurnActivity, 'observe' | 'snapshot'>
  isSubagentSession: (sessionId: string) => boolean
  /** Whether the turn open in a session was started by a quiet delivery (core/turns/recaps.ts `quietTurnOpen`): a line
   *  the daemon typed for the agent alone, as Hachi's wake is. Absent, none is. */
  quietTurnOpen?: (sessionId: string) => boolean
  clients: Pick<FunnelClients, 'send'>
  search: { touch(sessionId: string): void } | null | undefined
  turnStartedAt: Map<string, number>
  /** The prompt of each agent's last turn start, by agent, for the one-line summary of what it does (turns/summaries.ts).
   *  Not cleared when the turn ends: an idle agent with no recap is summarised by its last prompt. */
  prompts?: Map<string, string>
  input: Pick<SessionInputController, 'onTurnStarted' | 'onTurnEnded' | 'onUserMessage'>
  startHeartbeat: (sessionId: string) => void
  questionWatcher: Pick<QuestionWatcher, 'start' | 'noteTurnStart' | 'stop'>
  mirror: Pick<TurnRecaps, 'ingest'>
  /** The agent's engine is working now: a live turn start or its progress, never a re-read (the mover's quiet clock,
   *  lib/hostMove/quiet.ts). */
  working?: (agentId: string) => void
  /** Each live turn's start and end, never a re-read: the short-turn guard holds automatic input to an agent that
   *  loops (shortTurnGuard.ts). */
  shortTurns?: Pick<ShortTurnGuard, 'started' | 'ended'>
  /** Each live turn's start, told before the input can say a quiet delivery started it: an agent's quiet stretch ends there, and a
   *  title its engine gives after it may name it again (core/agents/quietTitles.ts). */
  quietTitles?: Pick<QuietTitles, 'turnStarted'>
}

/** The funnel itself, over what it feeds. */
export function funnelFor({
  bySession, tokenUsage, agentIdFor, turnActivity, isSubagentSession, clients, search, turnStartedAt, prompts, input,
  startHeartbeat, questionWatcher, mirror, working, shortTurns,
  quietTitles, quietTurnOpen,
}: FunnelDeps) {
  let batch = 0
  return (sessionId: string, events: Events, opts?: EmitOptions): void => {
    if (!events.length || !bySession(sessionId)?.active) return
    const usageSession = bySession(sessionId)
    if (usageSession?.engine === 'opencode') tokenUsage.changed(usageSession)
    const id = ++batch
    for (let index = 0; index < events.length; index++) {
      const event = events[index]
      const agentId = agentIdFor(sessionId)
      const replay = !!(opts?.resumed || opts?.replay)
      turnActivity.observe(sessionId, event.type, replay)
      if (!replay && isProgressEvent(event.type)) working?.(agentId)
      if (!replay && event.type === 'turn_started') {
        shortTurns?.started(sessionId, agentId)
        quietTitles?.turnStarted(agentId)
      } else if (!replay && event.type === 'turn_ended') shortTurns?.ended(sessionId)
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
        // A turn the daemon started with a line of its own (a quiet delivery, as Hachi's wake is) is no one's news either:
        // the person did not ask for it, so the window makes no unread mark or done notice of it
        // (docs/design/2026-11-12-hachi.md, "Hachi's own turns"). Read before the recaps hear this batch, which ends the mark.
        else if (!replay && quietTurnOpen?.(sessionId)) frame.subagent = true
      }
      clients.send(withoutOutputTail(frame), { id, index, count: events.length, ...(opts?.replay ? { replay: true as const } : {}) })
      if (!replay && event.type === 'user_message') input.onUserMessage(agentId, event.payload.content)
      if (event.type === 'turn_started' || event.type === 'turn_ended') search?.touch(sessionId)
      if (event.type === 'turn_started') {
        turnStartedAt.set(sessionId, Date.now())
        const line = promptLine(event.payload.userMessage)
        if (line) prompts?.set(agentId, line)
        else prompts?.delete(agentId)
        console.log(`[turn] ${sid(sessionId)} started · engine=${bySession(sessionId)?.engine ?? 'claude'} · bytes=${Buffer.byteLength(event.payload.userMessage, 'utf8')}`)
        input.onTurnStarted(agentIdFor(sessionId), event.payload.userMessage)
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
        input.onTurnEnded(agentIdFor(sessionId))
        // Command Code asks AFTER the turn: `ask_user_question` ends the turn (its Stop hook fires), the
        // dialog goes up, and the answer opens a NEW turn. Stopping the watcher here is what left the
        // terminal sitting on a question the device never showed. Its watcher runs off the session, not
        // the turn — see the attach path — so leave it alone.
        if (bySession(sessionId)?.engine !== 'commandcode') questionWatcher.stop(sessionId)
        // Do NOT stop the heartbeat here: the turn is closed but its recap is just being cut (the recaps
        // hear the batch below and say its card is busy). The timer keeps beating for the device's card and
        // stops once mirror.heartbeat() reads it idle, which is at once while the recaps are off.
      }
    }
    mirror.ingest(events, sessionId, { replay: !!(opts?.resumed || opts?.replay) })
  }
}

export function createEventFunnel({ clients, agentIdFor, failure }: {
  clients: FunnelClients; agentIdFor: (sessionId: string) => string; failure(failure: SessionFailure): void
}) {
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
    failureSummary?: string,
  ): void => {
    console.log(`[turn] ${sid(sessionId)} aborted by ${engine} error · ${preview(message)}`)
    const agentId = agentIdFor(sessionId)
    clients.send({ type: 'error', agentId, dbSessionId: sessionId, payload: { message } })
    failure({ agentId, sessionId, engine, message, ...(failureSummary === undefined ? {} : { failureSummary }) })
  }
  return { emit, arm, announceTurnAborted }
}

export type EventFunnel = ReturnType<typeof createEventFunnel>
