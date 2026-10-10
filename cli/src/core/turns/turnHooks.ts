/**
 * Turn hooks: what the engines' own hooks say about a turn. Command Code's PreToolUse opens its turn;
 * Cursor's Task tool start registers a sub-agent; and the Stop hooks close turns the transcript alone
 * would leave open: each engine drains what is unread first, waits a grace, and closes only what is
 * still open — or, for an error, announces why.
 *
 * Moved verbatim out of the hook server's options in `runForeground` (the core boundary, step 9:
 * docs/design/2026-10-03-harnessd.md).
 */
import { hooksFor } from '../../engines/hooks.js'
import type { HookTurnContext } from '../../engines/facets/hooks.js'
import { removePendingCursorTasks } from '../engines/cursorTasks.js'
import type { CursorSubagentManager } from '../../engines/cursor/subagent.js'
import type { CursorTaskHookQueue } from '../../engines/cursor/taskHookQueue.js'
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
  normalizers: SessionNormalizers
  emit: (sessionId: string, events: LiveEvent[]) => void
  /** Read what the transcript has that the tail has not delivered yet (Watcher.pollSession). */
  drain: (sessionId: string) => Promise<void>
  onCursorTaskStart: (sessionId: string, toolUseId: string, toolInput: unknown) => void
  cursorTaskHooks: Pick<CursorTaskHookQueue, 'wait'>
  cursorSubagents: Pick<CursorSubagentManager, 'closeParent'>
  announceTurnAborted: (sessionId: string, engine: string, message: string) => void
  armAgyIdleWatch: (sessionId: string) => void
  clearAgyIdleWatch: (sessionId: string) => void
  mirror: Pick<TurnRecaps, 'noteEngineStopped'>
  dataDir: string
}

export function createTurnHooks({
  resolve, normalizers, emit, drain, onCursorTaskStart, cursorTaskHooks, cursorSubagents, announceTurnAborted,
  armAgyIdleWatch, clearAgyIdleWatch, mirror, dataDir, holdStop, afterStop,
}: TurnHookDeps) {
  const { liveParsers, commandcodeNormalizers, cursorNormalizers, devinReaders, copilotNormalizers, agyNormalizers, grokNormalizers } = normalizers
  // Command Code's PreToolUse — the one live "a turn is running" signal this engine has. Without it the
  // adapter only learned of a turn from Stop, and emitted turn_started+turn_ended in the same
  // millisecond, so the device tile jumped from idle straight to the recap with no working state.
  const onTurnStart = ({ sessionId }: { sessionId: string }): void => {
    const session = resolve(sessionId)
    if (!session || session.engine !== 'commandcode') return
    const normalizer = commandcodeNormalizers.get(sessionId)
    if (!normalizer) return
    emit(sessionId, normalizer.openTurn())   // no-op after the turn's first tool call
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
  const onToolStart = ({ sessionId, toolUseId, toolName, input: toolInput }: { sessionId: string; toolUseId: string; toolName: string; input: unknown }): void => {
    if (toolName === 'Task') onCursorTaskStart(sessionId, toolUseId, toolInput)
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
    // Waiting is explicitly not a completion: preserve agy's eager backstop signal.
    if (session.engine === 'agy' && status === 'waiting') { armAgyIdleWatch(sessionId); return }
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
    if (!current()) return
    if (session.engine === 'cursor') {
      void (async () => {
        await cursorTaskHooks.wait(sessionId)
        if (!current()) return
        await drain(sessionId)
        if (!current()) return
        const normalizer = cursorNormalizers.get(sessionId)
        if (!normalizer) return
        cursorSubagents.closeParent(sessionId, status === 'error')
        const closing = normalizer.closeTurn()
        afterStop?.(session)
        emit(sessionId, closing)
        // Cursor can fail a turn BEFORE it writes anything to the transcript — observed as a Stop hook
        // with status=error 2.4s after beforeSubmitPrompt, with no transcript file discovered and no
        // rows to read. The normalizer never opened a turn, so closeTurn() returns nothing, so nothing
        // reaches the device: the tile just sits on the previous recap forever while the user waits.
        //
        // Every other engine already routes its failures through announceTurnAborted (codex, devin,
        // commandcode); cursor was the one that stayed silent. Announce only when the close produced no
        // events — if there WAS output, the `done` event above already tells the device the turn ended.
        if (status === 'error' && closing.length === 0) {
          announceTurnAborted(sessionId, 'cursor', 'Cursor ended the turn with an error before producing any output')
        }
        setTimeout(() => void removePendingCursorTasks(dataDir, sessionId), 2_500)
      })().catch((err) => {
        console.error('[cursor] stop hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    // Command Code has no UserPromptSubmit and commits records per turn, so Stop is its authoritative
    // close: drain the transcript first (the natural close usually wins), then force-close what's left.
    if (session.engine === 'commandcode') {
      void (async () => {
        await drain(sessionId)
        if (!current()) return
        const normalizer = commandcodeNormalizers.get(sessionId)
        if (!normalizer?.turnOpen) return
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        if (!current()) return
        await drain(sessionId)
        if (!current()) return
        if (!normalizer.turnOpen) return
        normalizer.closeTurn()
        afterStop?.(session)
        console.log(`[turn] ${sid(sessionId)} force-closed by Stop hook (after grace)`)
        emit(sessionId, [{ type: 'turn_ended', payload: {} }])
      })().catch((err) => {
        console.error('[hooks] commandcode stop hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    // Devin: same deal, except the un-read history is in SQLite rather than a file, so the drain is the
    // reader's own poll. Its rows only land once the model round-trip commits, so the grace matters.
    if (session.engine === 'devin') {
      void (async () => {
        const reader = devinReaders.get(sessionId)
        if (!reader?.turnOpen) return
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        if (!current()) return
        if (!reader.turnOpen) return
        reader.closeTurn()
        afterStop?.(session)
        console.log(`[turn] ${sid(sessionId)} force-closed by Stop hook (after grace)`)
        emit(sessionId, [{ type: 'turn_ended', payload: {} }])
      })().catch((err) => {
        console.error('[hooks] devin stop hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    // Copilot's agentStop hook is the turn boundary: its own `assistant.turn_end` records mark model
    // round-trips, several per exchange. Drain first so the closing text is on the wire, then close.
    if (session.engine === 'copilot') {
      void (async () => {
        await drain(sessionId)
        if (!current()) return
        const normalizer = copilotNormalizers.get(sessionId)
        if (!normalizer?.turnOpen) return
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        if (!current()) return
        await drain(sessionId)
        if (!current()) return
        if (!normalizer.turnOpen) return
        if (status === 'error') {
          announceTurnAborted(sessionId, 'copilot', 'Copilot ended the turn early')
          const closing = normalizer.abortTurn()
          afterStop?.(session)
          emit(sessionId, closing)
          return
        }
        console.log(`[turn] ${sid(sessionId)} closed by copilot agentStop hook (after grace)`)
        const closing = normalizer.closeTurn()
        afterStop?.(session)
        emit(sessionId, closing)
      })().catch((err) => {
        console.error('[hooks] copilot stop hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    // agy's Stop hook is the ONLY turn boundary it has. Nothing in the transcript says a turn ended:
    // a backgrounded step is written `status: RUNNING` and, the file being append-only, stays that way
    // forever. Drain first so the closing prose is on the wire before turn_ended, then force-close.
    if (session.engine === 'agy') {
      // `waiting` = agy's loop stopped only because it is standing by for its sub-agents. The turn is
      // NOT over, so nothing closes here — but the run that proved this necessary also finished its
      // sub-agents and then never sent another Stop, so a backstop watches the pane instead.
      clearAgyIdleWatch(sessionId)
      void (async () => {
        await drain(sessionId)
        if (!current()) return
        const normalizer = agyNormalizers.get(sessionId)
        if (!normalizer?.turnOpen) return
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        if (!current()) return
        await drain(sessionId)
        if (!current()) return
        if (!normalizer.turnOpen) return
        if (status === 'error') {
          announceTurnAborted(sessionId, 'agy', 'agy ended the turn early')
          const closing = normalizer.abortTurn()
          afterStop?.(session)
          emit(sessionId, closing)
          return
        }
        console.log(`[turn] ${sid(sessionId)} closed by agy Stop hook (after grace)`)
        const closing = normalizer.closeTurn()
        afterStop?.(session)
        emit(sessionId, closing)
      })().catch((err) => {
        console.error('[hooks] agy stop hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    if (session.engine === 'grok') {
      void (async () => {
        await drain(sessionId)
        if (!current()) return
        const normalizer = grokNormalizers.get(sessionId)
        if (status === 'error') {
          announceTurnAborted(sessionId, 'grok', 'Grok ended the turn with an error')
          const closing = normalizer?.abortTurn() ?? []
          afterStop?.(session)
          emit(sessionId, closing)
        }
      })().catch((err) => {
        console.error('[hooks] grok StopFailure hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
  }
  return { onTurnStart, onToolStart, onTurnStop, onPromptHook }
}
