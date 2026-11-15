/**
 * Turn hooks: what the engines' own hooks say about a turn. Command Code's PreToolUse opens its turn;
 * Cursor's Task tool start registers a sub-agent; and the Stop hooks close turns the transcript alone
 * would leave open: each engine drains what is unread first, waits a grace, and closes only what is
 * still open — or, for an error, announces why. Claude Code's and Codex's declare theirs as hooks
 * (engines/hooks.ts); the other engines' as Stop rules (engines/otherEngines.ts `STOP_RULES`), applied here
 * with what their worker does to their parsers (core/engines/otherStreams.ts).
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

// Claude's Stop hook fires when the agent finishes, but the transcript can lag a moment behind
// (docs: "the transcript file may lag behind the in-memory conversation"). Acting immediately races
// that flush → an empty recap + a premature close. So the Stop hook is a DELAYED fallback: poll, and
// only if the turn is still open after this grace + a re-poll do we force-close (by then the assistant
// text is on disk, so the natural close usually wins and the recap isn't empty).
export const STOP_HOOK_GRACE_MS = 1_500
/** How many sessions' latest prompt hooks are remembered. */
const PROMPT_HOOKS_KEPT = 512

export interface TurnHookDeps {
  holdStop?: (session: RegisteredSession, force?: boolean) => boolean
  afterStop?: (session: RegisteredSession) => void
  resolve: (id: string) => RegisteredSession | undefined
  normalizers: Pick<SessionNormalizers, 'liveParsers'>
  /** The other engines' streams: their parsers are their worker's. */
  others: Pick<OtherStreams, 'get' | 'close' | 'openTurn' | 'task'>
  emit: (sessionId: string, events: LiveEvent[]) => void
  /** Read what the transcript has that the tail has not delivered yet (Watcher.pollSession). */
  drain: (sessionId: string) => Promise<void>
  announceTurnAborted: (sessionId: string, engine: string, message: string) => void
  armAgyIdleWatch: (sessionId: string) => void
  clearAgyIdleWatch: (sessionId: string) => void
  mirror: Pick<TurnRecaps, 'noteEngineStopped'>
  log?: (line: string) => void
}

export function createTurnHooks({
  resolve, normalizers, others, emit, drain, announceTurnAborted, armAgyIdleWatch, clearAgyIdleWatch, mirror, holdStop, afterStop,
  log = (line) => console.log(line),
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
  /** When each session's latest prompt hook was run by its engine: a Stop run before it is about an earlier
   *  turn. Bounded: a session's entry outlives it only until enough newer ones come. */
  const promptFiredAt = new Map<string, number>()
  const onPromptHook = (sessionId: string, firedAt: number): void => {
    if (firedAt <= (promptFiredAt.get(sessionId) ?? 0)) return
    promptFiredAt.delete(sessionId)
    promptFiredAt.set(sessionId, firedAt)
    if (promptFiredAt.size > PROMPT_HOOKS_KEPT) promptFiredAt.delete(promptFiredAt.keys().next().value!)
  }
  const hookTurns: HookTurnContext = {
    turnState: (sessionId) => {
      const parser = liveParsers.get(sessionId)
      return parser && parser.engine === resolve(sessionId)?.engine ? parser.snapshot() : undefined
    },
    closeTurn: (sessionId, identity) => {
      const parser = liveParsers.get(sessionId)
      if (!parser || parser.engine !== resolve(sessionId)?.engine || parser.snapshot().identity !== identity) return false
      parser.closeTurn('hook')
      afterStop?.(resolve(sessionId)!)
      return true
    },
    latestPromptAt: (sessionId) => promptFiredAt.get(sessionId),
    drain,
    noteEngineStopped: (sessionId) => mirror.noteEngineStopped(sessionId),
    emit,
    graceMs: STOP_HOOK_GRACE_MS,
  }
  // Cursor's Task tool start: the sub-agent it starts is followed in Cursor's stream, behind a drain of its transcript.
  const onToolStart = ({ sessionId, toolUseId, toolName, input: toolInput }: { sessionId: string; toolUseId: string; toolName: string; input: unknown }): void => {
    if (toolName === 'Task' && resolve(sessionId)?.engine === 'cursor') others.task(sessionId, toolUseId, toolInput)
  }
  const onTurnStop = ({ sessionId, status, firedAt }: { sessionId: string; status?: string; firedAt?: number }): void => {
    const session = resolve(sessionId)
    if (!session) return
    const authority = JSON.stringify([session.agentId, session.sessionId, session.engine, session.transcriptPath,
      session.evidenceRevision, session.identityHold])
    const binding = JSON.stringify([session.agentId, session.sessionId, session.engine])
    let retained = false
    const current = (): boolean => {
      const latest = resolve(sessionId)
      if (!latest || JSON.stringify([latest.agentId, latest.sessionId, latest.engine]) !== binding) return false
      const changed = authority !== JSON.stringify([latest.agentId, latest.sessionId, latest.engine, latest.transcriptPath,
        latest.evidenceRevision, latest.identityHold])
      if ((latest.identityHold || latest.interpretationHold || changed) && holdStop) {
        // Claude already supplies positive stale-event evidence. A hold does not turn a proven old
        // Stop into an unknown completion that would require cancelling the newer turn.
        if (session.engine === 'claude' && firedAt !== undefined && (promptFiredAt.get(sessionId) ?? 0) > firedAt) return false
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
    const hooks = hooksFor(session.engine)
    if (hooks) {
      if (!hooks.onStop || !current()) return
      // Invoke synchronously: the engine snapshots which turn the hook arrived about before draining.
      const failed = (error: unknown): void => {
        console.error(`[hooks] ${session.engine} stop hook failed:`, error instanceof Error ? error.message : error)
      }
      const context: HookTurnContext = { ...hookTurns,
        turnState: id => current() ? hookTurns.turnState(id) : undefined,
        closeTurn: (id, identity) => current() && hookTurns.closeTurn(id, identity),
        noteEngineStopped: id => { if (current()) hookTurns.noteEngineStopped(id) },
        emit: (id, events) => { if (current()) emit(id, events) },
      }
      try { void Promise.resolve(hooks.onStop(context, { sessionId, status, firedAt })).catch(failed) } catch (error) { failed(error) }
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
  return { onTurnStart, onToolStart, onTurnStop, onPromptHook }
}
