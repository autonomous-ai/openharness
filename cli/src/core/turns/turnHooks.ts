/**
 * Turn hooks: what the engines' own hooks say about a turn. Command Code's PreToolUse opens its turn;
 * Cursor's Task tool start registers a sub-agent; and the Stop hooks close turns the transcript alone
 * would leave open: each engine drains what is unread first, waits a grace, and closes only what is
 * still open — or, for an error, announces why.
 *
 * Moved verbatim out of the hook server's options in `runForeground` (the core boundary, step 9:
 * docs/design/2026-10-03-harnessd.md).
 */
import { removeCursorPendingTasks } from '../../engines/cursor/pendingTasks.js'
import type { CursorSubagentManager } from '../../engines/cursor/subagent.js'
import type { CursorTaskHookQueue } from '../../engines/cursor/taskHookQueue.js'
import type { CommanderMirror } from '../../lib/commander.js'
import { sid } from '../../lib/log.js'
import type { LiveEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { SessionNormalizers } from '../transcripts/normalizers.js'

// Claude's Stop hook fires when the agent finishes, but the transcript can lag a moment behind
// (docs: "the transcript file may lag behind the in-memory conversation"). Acting immediately races
// that flush → an empty recap + a premature close. So the Stop hook is a DELAYED fallback: poll, and
// only if the turn is still open after this grace + a re-poll do we force-close (by then the assistant
// text is on disk, so the natural close usually wins and the recap isn't empty).
export const STOP_HOOK_GRACE_MS = 1_500

export interface TurnHookDeps {
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
  mirror: Pick<CommanderMirror, 'noteEngineStopped'>
  dataDir: string
}

export function createTurnHooks({
  resolve, normalizers, emit, drain, onCursorTaskStart, cursorTaskHooks, cursorSubagents, announceTurnAborted,
  armAgyIdleWatch, clearAgyIdleWatch, mirror, dataDir,
}: TurnHookDeps) {
  const { turnStates, commandcodeNormalizers, cursorNormalizers, devinReaders, copilotNormalizers, agyNormalizers, grokNormalizers } = normalizers
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
  const onToolStart = ({ sessionId, toolUseId, toolName, input: toolInput }: { sessionId: string; toolUseId: string; toolName: string; input: unknown }): void => {
    if (toolName === 'Task') onCursorTaskStart(sessionId, toolUseId, toolInput)
  }
  const onTurnStop = ({ sessionId, status }: { sessionId: string; status?: string }): void => {
    const session = resolve(sessionId)
    if (!session) return
    if (session.engine === 'cursor') {
      void (async () => {
        await cursorTaskHooks.wait(sessionId)
        await drain(sessionId)
        const normalizer = cursorNormalizers.get(sessionId)
        if (!normalizer) return
        cursorSubagents.closeParent(sessionId, status === 'error')
        const closing = normalizer.closeTurn()
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
        setTimeout(() => void removeCursorPendingTasks(dataDir, sessionId), 2_500)
      })().catch((err) => {
        console.error('[cursor] stop hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    // claude: authoritative turn-close from the Stop/StopFailure hook. Drain any un-read JSONL FIRST
    // (may emit the real turn_ended → st.turnOpen already false); only force-close if still open. A
    // later real end_turn line is then a no-op (lineToEvents guards on state.turnOpen). This closes
    // the B1/B2 cases (max_tokens/refusal/API-error/wedged tool) the JSONL parse would otherwise miss.
    // Command Code has no UserPromptSubmit and commits records per turn, so Stop is its authoritative
    // close: drain the transcript first (the natural close usually wins), then force-close what's left.
    if (session.engine === 'commandcode') {
      void (async () => {
        await drain(sessionId)
        const normalizer = commandcodeNormalizers.get(sessionId)
        if (!normalizer?.turnOpen) return
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        await drain(sessionId)
        if (!normalizer.turnOpen) return
        normalizer.closeTurn()
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
        if (!reader.turnOpen) return
        reader.closeTurn()
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
        const normalizer = copilotNormalizers.get(sessionId)
        if (!normalizer?.turnOpen) return
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        await drain(sessionId)
        if (!normalizer.turnOpen) return
        if (status === 'error') {
          announceTurnAborted(sessionId, 'copilot', 'Copilot ended the turn early')
          emit(sessionId, normalizer.abortTurn())
          return
        }
        console.log(`[turn] ${sid(sessionId)} closed by copilot agentStop hook (after grace)`)
        emit(sessionId, normalizer.closeTurn())
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
      if (status === 'waiting') {
        armAgyIdleWatch(sessionId)
        return
      }
      clearAgyIdleWatch(sessionId)
      void (async () => {
        await drain(sessionId)
        const normalizer = agyNormalizers.get(sessionId)
        if (!normalizer?.turnOpen) return
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        await drain(sessionId)
        if (!normalizer.turnOpen) return
        if (status === 'error') {
          announceTurnAborted(sessionId, 'agy', 'agy ended the turn early')
          emit(sessionId, normalizer.abortTurn())
          return
        }
        console.log(`[turn] ${sid(sessionId)} closed by agy Stop hook (after grace)`)
        emit(sessionId, normalizer.closeTurn())
      })().catch((err) => {
        console.error('[hooks] agy stop hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    if (session.engine === 'grok') {
      void (async () => {
        await drain(sessionId)
        const normalizer = grokNormalizers.get(sessionId)
        if (status === 'error') {
          announceTurnAborted(sessionId, 'grok', 'Grok ended the turn with an error')
          emit(sessionId, normalizer?.abortTurn() ?? [])
        }
      })().catch((err) => {
        console.error('[hooks] grok StopFailure hook failed:', err instanceof Error ? err.message : err)
      })
      return
    }
    if (session.engine !== 'claude') return
    void (async () => {
      await drain(sessionId)
      // A Stop hook is the one precise "the engine stopped writing" signal we get. When the mirror is
      // HOLDING a turn-end for finished async sub-agents, this is what tells it the wrap-up message is
      // on disk — without it the recap fires on its settle timer and can beat claude's closing summary
      // to the punch (measured: recap at 10:18:41, wrap-up written at 10:18:44).
      mirror.noteEngineStopped(sessionId)
      if (!turnStates.get(sessionId)?.turnOpen) return // natural JSONL close already won → nothing to do
      // Still open: the transcript may just be lagging the Stop hook. Wait, re-poll, and only force-close
      // if it STILL hasn't closed — a genuinely wedged turn, whose assistant text is on disk by now.
      await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
      await drain(sessionId)
      const st = turnStates.get(sessionId)
      if (st?.turnOpen) {
        st.turnOpen = false
        st.pendingTools.clear()
        console.log(`[turn] ${sid(sessionId)} force-closed by ${status === 'error' ? 'StopFailure' : 'Stop'} hook (after grace)`)
        emit(sessionId, [{ type: 'turn_ended', payload: status === 'error' ? { aborted: true } : {} }])
      }
    })().catch((err) => {
      console.error('[hooks] claude stop hook failed:', err instanceof Error ? err.message : err)
    })
  }
  return { onTurnStart, onToolStart, onTurnStop }
}
