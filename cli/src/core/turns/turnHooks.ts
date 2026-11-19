/**
 * Turn hooks: what the engines' own hooks say about a turn. Command Code's PreToolUse opens its turn;
 * Cursor's Task tool start registers a sub-agent; and the Stop hooks close turns the transcript alone
 * would leave open: each engine drains what is unread first, waits a grace, and closes only what is
 * still open — or, for an error, announces why. Claude Code's and Codex's declare theirs as hooks
 * (engines/hooks.ts); the other engines' as Stop rules (engines/otherEngines.ts `STOP_RULES`), applied here
 * with what their worker does to their parsers (core/engines/otherStreams.ts). Once Claude Code or Codex has sent a
 * Stop, the end its transcript reads of a turn is held here for that turn's Stop; their wait hooks withdraw
 * Working while the person is waited on; and Claude Code's subagent hooks keep a lead's turn open while its
 * subagents run (docs/plans/2026-11-16-hook-driven-agent-status-plan.md, Turn rules).
 *
 * Moved verbatim out of the hook server's options in `runForeground` (the core boundary, step 9:
 * docs/design/2026-10-03-harnessd.md).
 */
import { hooksFor } from '../../engines/hooks.js'
import type { HookTurnContext } from '../../engines/facets/hooks.js'
import { isOtherEngine, STOP_RULES } from '../../engines/otherEngines.js'
import type { OtherStreams } from '../engines/otherStreams.js'
import type { TurnRecaps } from './recaps.js'
import { sid } from '../../lib/log.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionNormalizers } from '../transcripts/normalizers.js'
import type { TranscriptRead } from '../transcripts/ingest.js'
import { isProgressEvent, type TurnActivity } from '../../lib/turnActivity.js'

// Claude's Stop hook fires when the agent finishes, but the transcript can lag a moment behind
// (docs: "the transcript file may lag behind the in-memory conversation"). Acting immediately races
// that flush → an empty recap + a premature close. So the Stop hook waits this grace for the turn's end, and
// only if the turn is still open after it + a re-poll do we force-close (by then the assistant
// text is on disk, so its end is usually read first and the recap isn't empty).
export const STOP_HOOK_GRACE_MS = 1_500
/** How many sessions' hook records are kept. */
export const HOOKS_KEPT = 512
/** A held end with no hook for this long had its Stop lost: it goes on, as Orca's 2-minute rule does (R6). */
export const HOOK_SILENCE_MS = 120_000
/** Subagents counted at most: a start past it is not counted. */
export const SUBAGENTS_MAX = 64
/** Subagents running with no hook and no progress for this long lost a SubagentStop: none is counted (R5). */
export const SUBAGENT_TIMEOUT_MS = 600_000

/** What a session's hooks have said of its turn. One a session. When the daemon read or heard something (`held.at`,
 *  `hookAt`, `progressAt`) is on the monotonic clock: it times the waits, which a wall clock set back would stretch. */
interface HookTurn {
  /** When its engine ran its latest prompt hook: a Stop run before it is about an earlier turn. */
  promptAt?: number
  /** It has sent a Stop in this daemon run, so its engine sends them: its turns end by hook (R0). */
  endsByHook: boolean
  /** The turn's own end, read and held for its Stop, and when it was read. */
  held?: { end: LiveEvent; identity?: string; openedAt?: number; at: number }
  /** The turn a Stop came for before its end was read, by identity, or by the time the Stop ran when none of its turn
   *  was read yet: that end goes on as it is read (R2). */
  awaited?: string | number
  /** When its latest end or wait hook reached the daemon: an engine still sending them has not lost the Stop. */
  hookAt: number
  /** When the hook of the wait on the person ran, while it is open (R4). */
  waitAt?: number
  /** How many of its subagents run, by Claude Code's SubagentStart and SubagentStop (R5). */
  subagents: number
  /** When its engine ran a SubagentStop taken with none counted: a SubagentStart it ran before, taken after, is its. */
  subagentStopAt?: number
  /** When progress was last read while they run. */
  progressAt: number
}

/** A turn's end, or the lead's own progress: a subagent's tool, or its end, is not the lead writing on (R4). */
const leadsOn = (event: LiveEvent): boolean => event.type === 'turn_ended'
  || (isProgressEvent(event.type) && event.type !== 'subagent_finished' && !(event.payload as { parentToolUseId?: string }).parentToolUseId)

export interface TurnHookDeps {
  holdStop?: (session: RegisteredSession, force?: boolean) => boolean
  afterStop?: (session: RegisteredSession) => void
  resolve: (id: string) => RegisteredSession | undefined
  normalizers: Pick<SessionNormalizers, 'liveParsers'>
  /** The other engines' streams: their parsers are their worker's. */
  others: Pick<OtherStreams, 'get' | 'close' | 'openTurn' | 'task'>
  emit: (sessionId: string, events: LiveEvent[], opts?: { replay?: boolean; resumed?: true }) => void
  /** Read what the transcript has that the tail has not delivered yet (Watcher.pollSession). */
  drain: (sessionId: string) => Promise<void>
  announceTurnAborted: (sessionId: string, engine: string, message: string) => void
  armAgyIdleWatch: (sessionId: string) => void
  clearAgyIdleWatch: (sessionId: string) => void
  mirror: Pick<TurnRecaps, 'noteEngineStopped'>
  /** A wait withdraws the Working claim, and every window is told, as a cancel tells it (core/turns/heartbeats.ts). */
  turnActivity: Pick<TurnActivity, 'withdraw'>
  tell: (sessionId: string) => void
  /** QuestionWatcher.awaitDialog: no pane is read at the hook. */
  awaitDialog: (sessionId: string) => void
  log?: (line: string) => void
}

export function createTurnHooks({
  resolve, normalizers, others, emit, drain, announceTurnAborted, armAgyIdleWatch, clearAgyIdleWatch, mirror, holdStop, afterStop,
  turnActivity, tell, awaitDialog, log = (line) => console.log(line),
}: TurnHookDeps) {
  const { liveParsers } = normalizers
  // Command Code's PreToolUse — the one live "a turn is running" signal this engine has. Without it the
  // adapter only learned of a turn from Stop, and emitted turn_started+turn_ended in the same
  // millisecond, so the device tile jumped from idle straight to the recap with no working state.
  const onTurnStart = ({ sessionId }: { sessionId: string }): void => {
    const session = resolve(sessionId)
    if (!session || session.engine !== 'commandcode' || !others.get(sessionId)) return
    // A no-op after the turn's first tool call.
    void others.openTurn(sessionId).then(events => { if (events.length) emit(sessionId, events) })
  }
  /** Each session's hook record. Bounded: a session's entry outlives it only until enough newer ones come. */
  const turns = new Map<string, HookTurn>()
  /** The person is no longer waited on (R4): its turn ended, a question closed, or the pane read clear. */
  const waitOver = (sessionId: string): void => { const turn = turns.get(sessionId); if (turn) turn.waitAt = undefined }
  /** The held end goes to the funnel, its turn closed and its wait over before: what the funnel runs on it reads so. */
  const deliver = (sessionId: string): boolean => {
    const turn = turns.get(sessionId)
    if (!turn?.held) return false
    const { end } = turn.held
    turn.held = turn.waitAt = undefined
    emit(sessionId, [end])
    return true
  }
  /** The session's record, made the newest. The oldest makes room, its held end delivered first. */
  const record = (sessionId: string): HookTurn => {
    const turn = turns.get(sessionId) ?? { endsByHook: false, hookAt: 0, subagents: 0, progressAt: 0 }
    turns.delete(sessionId)
    turns.set(sessionId, turn)
    if (turns.size > HOOKS_KEPT) {
      const oldest = turns.keys().next().value!
      deliver(oldest)
      turns.delete(oldest)
    }
    return turn
  }
  const onPromptHook = (sessionId: string, firedAt: number): void => {
    if (firedAt <= (turns.get(sessionId)?.promptAt ?? 0)) return
    const turn = record(sessionId)
    turn.promptAt = firedAt
    // A new prompt: a SubagentStop that was lost keeps the count no longer (R5).
    turn.subagents = 0
  }
  /** Every transcript read of a session, on its way to the funnel (R1): a turn's end waits for its Stop. */
  const transcript = (sessionId: string, events: LiveEvent[], read: TranscriptRead = {}): void => {
    const turn = turns.get(sessionId)
    // The person is waited on until the lead writes on after the wait's hook ran (R4): the waited tool's own start,
    // written before it, is often read after it.
    if (turn?.waitAt !== undefined && read.at !== undefined && read.at > turn.waitAt && events.some(leadsOn)) turn.waitAt = undefined
    if (read.replay) {
      // The transcript was read again: what it says of its turns is the latest word.
      if (turn?.held && events.some(event => event.type === 'turn_started' || event.type === 'turn_ended')) turn.held = undefined
      return emit(sessionId, events, { replay: true })
    }
    // A turn an attach picks back up: the end held before it goes on first (R1.4).
    if (read.resumed) { deliver(sessionId); return emit(sessionId, events, { resumed: true }) }
    if (turn?.subagents && events.some(event => isProgressEvent(event.type))) turn.progressAt = performance.now()
    if (!turn?.endsByHook || (!turn.held && !events.some(event => event.type === 'turn_ended'))) return emit(sessionId, events)
    // An aborted end, one no Stop follows (a paused /goal pass), and one its Stop came for already go on at once.
    const { awaited } = turn, ofTurn = read.turn
    const atOnce = read.over || (ofTurn && (ofTurn.identity === awaited
      || (typeof awaited === 'number' && ofTurn.openedAt !== undefined && ofTurn.openedAt <= awaited)))
    const out: LiveEvent[] = []
    for (const event of events) {
      if (event.type === 'turn_started' && turn.held) { out.push(turn.held.end); turn.held = undefined }
      if (event.type !== 'turn_ended' || event.payload.aborted || atOnce) { out.push(event); continue }
      turn.held = { end: event, identity: read.turn?.identity, openedAt: read.turn?.openedAt, at: performance.now() }
    }
    if (out.length) emit(sessionId, out)
  }
  /** The person is waited on, or its turns end by hook and none is open or held: progress read now claims no work
   *  (lib/turnActivity.ts). */
  const withheld = (sessionId: string): boolean => {
    const turn = turns.get(sessionId)
    return !!turn && (turn.waitAt !== undefined || (turn.endsByHook && !turn.held && !liveParsers.get(sessionId)?.turnOpen))
  }
  /** The lead's subagents run: work goes on with nothing in its transcript (lib/turnActivity.ts). */
  const atWork = (sessionId: string): boolean => !!turns.get(sessionId)?.subagents
  const hookTurns: Omit<HookTurnContext, 'heldBeforeHook'> = {
    turnState: (sessionId) => {
      const parser = liveParsers.get(sessionId)
      return parser && parser.engine === resolve(sessionId)?.engine ? parser.snapshot() : undefined
    },
    closeTurn: (sessionId, identity) => {
      const parser = liveParsers.get(sessionId)
      if (!parser || parser.engine !== resolve(sessionId)?.engine || parser.snapshot().identity !== identity) return false
      parser.closeTurn('hook')
      waitOver(sessionId)
      afterStop?.(resolve(sessionId)!)
      return true
    },
    latestPromptAt: (sessionId) => turns.get(sessionId)?.promptAt,
    drain,
    noteEngineStopped: (sessionId) => mirror.noteEngineStopped(sessionId),
    emit,
    graceMs: STOP_HOOK_GRACE_MS,
    heldEnd: (sessionId) => turns.get(sessionId)?.held,
    awaitEnd: (sessionId, identity) => { const turn = turns.get(sessionId); if (turn) turn.awaited = identity },
    deliverHeldEnd: deliver,
    subagentsRun: atWork,
  }
  /** A hook's time, unless its session holds a time later than now: one taken before the wall clock was set back (an NTP
   *  correction: e2e/clockjump.e2e.ts), which it orders nothing against, so the hook goes on as one that came with none. */
  const ordered = (sessionId: string, firedAt: number | undefined): number | undefined => {
    const turn = turns.get(sessionId), now = Date.now()
    return [turn?.promptAt, turn?.held?.openedAt, hookTurns.turnState(sessionId)?.openedAt]
      .some(at => at !== undefined && at > now) ? undefined : firedAt
  }
  // Cursor's Task tool start: the sub-agent it starts is followed in Cursor's stream, behind a drain of its transcript.
  const onToolStart = ({ sessionId, toolUseId, toolName, input: toolInput }: { sessionId: string; toolUseId: string; toolName: string; input: unknown }): void => {
    if (toolName === 'Task' && resolve(sessionId)?.engine === 'cursor') others.task(sessionId, toolUseId, toolInput)
  }
  const onTurnStop = ({ sessionId, status, firedAt: ran }: { sessionId: string; status?: string; firedAt?: number }): void => {
    const session = resolve(sessionId)
    if (!session) return
    const firedAt = ordered(sessionId, ran)
    const authority = JSON.stringify([session.agentId, session.sessionId, session.engine, session.transcriptPath,
      session.evidenceRevision, session.identityHold])
    const binding = JSON.stringify([session.agentId, session.sessionId, session.engine])
    let retained = false
    const hooks = hooksFor(session.engine), onStop = hooks?.onStop
    const current = (): boolean => {
      const latest = resolve(sessionId)
      if (!latest || JSON.stringify([latest.agentId, latest.sessionId, latest.engine]) !== binding) return false
      const changed = authority !== JSON.stringify([latest.agentId, latest.sessionId, latest.engine, latest.transcriptPath,
        latest.evidenceRevision, latest.identityHold])
      if ((latest.identityHold || latest.interpretationHold || changed) && holdStop) {
        // Claude Code and Codex already supply positive stale-event evidence. A hold does not turn a proven old
        // Stop into an unknown completion that would require cancelling the newer turn.
        if (hooks && firedAt !== undefined && (turns.get(sessionId)?.promptAt ?? 0) > firedAt) return false
        if (!retained) retained = holdStop(latest, changed)
        if (retained) return false
      }
      return !changed
    }
    const rule = isOtherEngine(session.engine) ? STOP_RULES[session.engine] : undefined
    // Waiting is explicitly not a completion: preserve agy's eager backstop signal. agy reports it when it stands by for
    // its sub-agents; the turn is NOT over, so nothing closes, but the run that proved this necessary also finished its
    // sub-agents and then never sent another Stop, so a backstop watches the pane instead (core/turns/agyBackstop.ts).
    if (rule?.backstop && status === 'waiting') { armAgyIdleWatch(sessionId); return }
    if (hooks) {
      // Its engine sends Stops: from this one on, its turns end by hook (R0).
      const turn = record(sessionId)
      // Taken before this Stop counts as a hook: the lead wrote on after its end was read (R5).
      const heldBeforeHook = !!turn.held && turn.held.at < turn.hookAt
      turn.endsByHook = true
      turn.hookAt = performance.now()
      if (status === 'interrupted') {
        // Codex's Interrupt (R3): Codex waits for it before it writes turn_aborted, so the open turn ends here, before
        // the route answers, as aborted, the way Claude Code's interrupt line ends one: no drain, no wait, no key. The
        // parser, closed, ends nothing at that turn_aborted. One run before the latest prompt hook, or before the open
        // turn opened, is about an earlier turn (kit/stopHook.ts).
        const open = hookTurns.turnState(sessionId)
        if (current() && open?.turnOpen && !(firedAt !== undefined && Math.max(turn.promptAt ?? 0, open.openedAt ?? 0) > firedAt)
          && hookTurns.closeTurn(sessionId, open.identity)) emit(sessionId, [{ type: 'turn_ended', payload: { aborted: true } }])
        return
      }
      // That is all a Codex Stop says: Codex runs it before it writes the turn's end, which goes on as it is read.
      if (!onStop || !current()) return
      // Invoke synchronously: the engine snapshots which turn the hook arrived about before draining.
      const failed = (error: unknown): void => {
        console.error(`[hooks] ${session.engine} stop hook failed:`, error instanceof Error ? error.message : error)
      }
      const context: HookTurnContext = { ...hookTurns, heldBeforeHook,
        turnState: id => current() ? hookTurns.turnState(id) : undefined,
        closeTurn: (id, identity) => current() && hookTurns.closeTurn(id, identity),
        noteEngineStopped: id => { if (current()) hookTurns.noteEngineStopped(id) },
        emit: (id, events) => { if (current()) emit(id, events) },
        deliverHeldEnd: id => current() && deliver(id),
      }
      try { void Promise.resolve(onStop(context, { sessionId, status, firedAt })).catch(failed) } catch (error) { failed(error) }
      return
    }
    if (!rule || !current()) return
    if (rule.backstop) clearAgyIdleWatch(sessionId)
    const error = status === 'error'
    void (async () => {
      if (rule.drain) { await drain(sessionId); if (!current()) return }
      if (!others.get(sessionId) || (!rule.always && !others.get(sessionId)!.turnOpen)) return
      if (rule.grace) {
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        if (!current()) return
        if (rule.drain) { await drain(sessionId); if (!current()) return }
        if (!others.get(sessionId)?.turnOpen) return
      }
      if (rule.onlyError && !error) return
      if (error && rule.error) announceTurnAborted(sessionId, session.engine, rule.error)
      const closing = await others.close(sessionId, { abort: error && !!rule.error, error, stop: true })
      afterStop?.(session)
      log(`[turn] ${sid(sessionId)} closed by its ${session.engine} Stop hook${rule.grace ? ' (after grace)' : ''}`)
      emit(sessionId, rule.plainEnd ? [{ type: 'turn_ended', payload: {} }] : closing)
      if (error && rule.errorIfSilent && !closing.length) announceTurnAborted(sessionId, session.engine, rule.errorIfSilent)
    })().catch((err) => {
      console.error(`[hooks] ${session.engine} stop hook failed:`, err instanceof Error ? err.message : err)
    })
  }
  /**
   * The engine waits on the person: a permission, a question (R4), in any turn, its first too. It draws its dialog
   * after this hook returns, so no pane is read here: the watcher reads it at its next poll. One dialog can post twice
   * (Claude Code's PreToolUse, then its PermissionRequest): the same wait, open from the later.
   */
  const onWait = ({ sessionId, firedAt: ran }: { sessionId: string; firedAt?: number }): void => {
    const firedAt = ordered(sessionId, ran), turn = record(sessionId)
    turn.hookAt = performance.now()
    // One run before the latest prompt hook is about an earlier turn.
    if (firedAt !== undefined && (turn.promptAt ?? 0) > firedAt) return
    turn.waitAt = firedAt ?? Date.now()
    turnActivity.withdraw(sessionId)
    tell(sessionId)
    awaitDialog(sessionId)
  }
  /** Claude Code's SubagentStart and SubagentStop (R5). One started before this daemon run can stop in it. Each hook is
   *  a process of its own, so a slow daemon can take a stop before its start. */
  const onSubagent = ({ sessionId, started, firedAt }: { sessionId: string; started: boolean; firedAt?: number }): void => {
    const turn = record(sessionId)
    turn.hookAt = performance.now()
    if (!started) { if (turn.subagents) turn.subagents--; else turn.subagentStopAt = firedAt }
    else if ((firedAt ?? Infinity) < (turn.subagentStopAt ?? 0)) turn.subagentStopAt = undefined
    else if (turn.subagents < SUBAGENTS_MAX) turn.subagents++
    else log(`[turn] ${sid(sessionId)} subagent not counted · ${SUBAGENTS_MAX} running`)
  }
  /**
   * The open turn's heartbeat. While subagents run, none is counted after SUBAGENT_TIMEOUT_MS with no hook and no
   * progress, and the held end goes on (R5); else an end held with no hook since for HOOK_SILENCE_MS lost its Stop,
   * and goes on (R6).
   */
  const beat = (sessionId: string): void => {
    const turn = turns.get(sessionId)
    if (turn?.subagents) {
      if (performance.now() - Math.max(turn.hookAt, turn.progressAt) < SUBAGENT_TIMEOUT_MS) return
      turn.subagents = 0
      log(`[turn] ${sid(sessionId)} subagent count reset · no hook or progress in 10 min`)
      deliver(sessionId)
      return
    }
    if (!turn?.held || performance.now() - Math.max(turn.hookAt, turn.held.at) < HOOK_SILENCE_MS) return
    log(`[turn] ${sid(sessionId)} ended by its transcript · no Stop in 2 min`)
    deliver(sessionId)
  }
  return {
    onTurnStart, onToolStart, onTurnStop, onPromptHook, transcript, withheld, beat, onWait, onSubagent, atWork,
    /** The turn's own end is read and held for its Stop: the turn is still open (R7). */
    held: (sessionId: string): boolean => !!turns.get(sessionId)?.held,
    /** The turn was closed without its end (a cancel): what is held goes, unsent, and its wait ends. */
    closed: (sessionId: string): void => { const turn = turns.get(sessionId); if (turn) turn.held = turn.waitAt = undefined },
    /** The watcher: a question closed, or the pane read clear. */
    waitOver,
    forget: (sessionId: string): void => { turns.delete(sessionId) },
  }
}

export type TurnHooks = ReturnType<typeof createTurnHooks>
