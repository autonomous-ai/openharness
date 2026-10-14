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
export const STOP_COMPLETION_WAIT_MS = 5_000
/** How many sessions' latest prompt hooks are remembered. */
const PROMPT_HOOKS_KEPT = 512

export type CapturedStopOutcome = 'completed' | 'superseded' | 'held'
export interface StopExecution { current(): boolean; verify(): void; confirm?(): Promise<void> }
export type CapturedStop = ((execution?: StopExecution) => Promise<CapturedStopOutcome>) & {
  /** Preparation can retry only after its actual work settled without entering a Stop effect. */
  retryable?(): boolean
}
export interface StopHook { sessionId: string; status?: string; firedAt?: number }

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
  /** A legacy Claude notification can arrive while registration is still pending.
   * Keep its arrival's parser and turn, including a proved no-open-turn observation,
   * through that wait. A later attachment is never this notification's target. */
  const captureDeclaredStop = (session: RegisteredSession, stop: StopHook, notCancelled: () => boolean): CapturedStop => {
    const { sessionId, firedAt } = stop
    const original = liveParsers.get(sessionId), arrived = original?.snapshot(), turn = normalizers.captureTurn(sessionId)
    const noEffect = !arrived?.turnOpen && !session.identityHold && !session.interpretationHold
    const binding = JSON.stringify([session.agentId, sessionId, session.engine])
    const interpretation = JSON.stringify([session.transcriptPath, session.evidenceRevision])
    type Attempt = { execution: StopExecution; deadline: number; revoked: boolean; settled: boolean; dispatched: boolean;
      outcome?: CapturedStopOutcome; completion?: Promise<CapturedStopOutcome> }
    let attempt: Attempt | undefined
    const state = (work?: Attempt): 'current' | 'held' | 'superseded' => {
      if (!notCancelled() || turn && !turn()) return 'superseded'
      const latest = resolve(sessionId)
      if (!latest || JSON.stringify([latest.agentId, latest.sessionId, latest.engine]) !== binding
        || firedAt !== undefined && (promptFiredAt.get(sessionId) ?? 0) > firedAt) return 'superseded'
      if (work && (work.revoked || !work.execution.current() || performance.now() >= work.deadline)) return 'held'
      if (noEffect) return 'current'
      if (!original || !arrived || liveParsers.get(sessionId) !== original
        || latest.identityHold || latest.interpretationHold
        || JSON.stringify([latest.transcriptPath, latest.evidenceRevision]) !== interpretation) return 'held'
      return original.snapshot().identity === arrived.identity ? 'current' : 'superseded'
    }
    const confirmed = (work: Attempt): boolean => {
      if (state(work) !== 'current') return false
      work.execution.verify()
      return state(work) === 'current'
    }
    const complete = (work: Attempt): Promise<CapturedStopOutcome> => {
      if (noEffect) { work.settled = true; return Promise.resolve('completed') }
      const context: HookTurnContext = { ...hookTurns,
        turnState: id => id === sessionId && state(work) === 'current' ? original!.snapshot() : undefined,
        closeTurn: (id, identity) => {
          if (id !== sessionId || !confirmed(work)) return false
          work.dispatched = true
          return hookTurns.closeTurn(id, identity)
        },
        noteEngineStopped: id => {
          if (id === sessionId && confirmed(work)) { work.dispatched = true; mirror.noteEngineStopped(id) }
        },
        emit: (id, events) => {
          if (id === sessionId && confirmed(work)) { work.dispatched = true; emit(id, events) }
        },
        drain: async id => { await drain(id); if (state(work) === 'current') await work.execution.confirm?.() },
      }
      const actual = Promise.resolve().then(() => hooksFor(session.engine)!.onStop!(context, stop))
      // A logical timeout revokes this attempt immediately. Its actual reader
      // still owns the slot until settlement; a retry never revives old callbacks.
      return new Promise<CapturedStopOutcome>((resolve) => {
        let done = false, timer: ReturnType<typeof setTimeout> | undefined
        const finish = (outcome: CapturedStopOutcome) => {
          if (done) return
          done = true; work.revoked = true; clearTimeout(timer); resolve(outcome)
        }
        actual.then(() => {
          work.settled = true
          const value = state(work); finish(value === 'current' ? 'completed' : value)
        }, () => { work.settled = true; finish(state(work) === 'superseded' ? 'superseded' : 'held') })
        const check = () => {
          const value = state(work)
          if (value !== 'current') { finish(value); return }
          timer = setTimeout(check, 25)
        }
        check()
      })
    }
    const retryable = () => !attempt || attempt.settled && !attempt.dispatched && attempt.outcome === 'held'
    return Object.assign((owner?: StopExecution) => {
      if (state() === 'superseded') return Promise.resolve('superseded' as const)
      if (attempt && !retryable()) return attempt.completion!
      const work: Attempt = { execution: owner ?? { current: () => true, verify: () => {} },
        deadline: Infinity, revoked: false, settled: false, dispatched: false }
      // A failed read/confirmation is preparation, not a dispatched Stop. Once
      // settled it may retry with fresh proof, on this exact original turn only.
      try {
        if (!confirmed(work)) return Promise.resolve(state(work) === 'superseded' ? 'superseded' as const : 'held' as const)
      } catch { return Promise.resolve(state(work) === 'superseded' ? 'superseded' as const : 'held' as const) }
      work.deadline = performance.now() + STOP_COMPLETION_WAIT_MS
      attempt = work
      return work.completion = complete(work).then(outcome => { work.outcome = outcome; return outcome })
    }, { retryable })
  }
  /** A registration already carries Cursor/Command Code's complete Stop. Capture its turn before
   *  admission waits, and let the registration's durable claim await this exact effect. A recovered
   *  parser is not evidence about which turn that original Stop meant to close. */
  const captureStop = (session: RegisteredSession, stop: StopHook, notCancelled: () => boolean): CapturedStop => {
    if (session.engine === 'claude') return captureDeclaredStop(session, stop, notCancelled)
    const { sessionId, status } = stop
    const states = session.engine === 'cursor' ? cursorNormalizers : commandcodeNormalizers
    const original = states.get(sessionId)
    const turn = normalizers.captureTurn(sessionId)
    const tasks = session.engine === 'cursor' ? cursorNormalizers.get(sessionId)?.pendingTaskIds() : undefined
    let execution: StopExecution = { current: () => true, verify: () => {} }
    let revoked = false, deadline = Infinity
    const binding = JSON.stringify([session.agentId, sessionId, session.engine])
    const interpretation = JSON.stringify([session.transcriptPath, session.evidenceRevision, session.identityHold, session.interpretationHold])
    const state = (): 'current' | 'superseded' | 'held' => {
      if (!notCancelled()) return 'superseded'
      if (!execution.current()) return 'held'
      const latest = resolve(sessionId)
      if (!latest || JSON.stringify([latest.agentId, latest.sessionId, latest.engine]) !== binding) return 'superseded'
      if (!original || !turn || states.get(sessionId) !== original) return 'held'
      if (!turn()) return 'superseded'
      if (performance.now() >= deadline) revoked = true
      if (revoked) return 'held'
      if (latest.identityHold || latest.interpretationHold || interpretation !== JSON.stringify([
        latest.transcriptPath, latest.evidenceRevision, latest.identityHold, latest.interpretationHold,
      ])) return 'held'
      return 'current'
    }
    const hold = (): CapturedStopOutcome => {
      if (state() === 'superseded') return 'superseded'
      if (!execution.current()) return 'held'
      // state() just proved this binding synchronously; no reader or callback intervenes.
      holdStop?.(resolve(sessionId)!, true)
      return 'held'
    }
    let completion: Promise<CapturedStopOutcome> | undefined
    const complete = async (): Promise<CapturedStopOutcome> => {
      deadline = performance.now() + STOP_COMPLETION_WAIT_MS
      // Bound the logical wait even if the underlying reader never settles. Cancel and shutdown
      // revoke the continuation; the original Promise is observed, never restarted on an admission retry.
      const wait = (work: Promise<unknown>): Promise<'current' | 'superseded' | 'held'> => new Promise((resolve, reject) => {
        let done = false, timer: ReturnType<typeof setTimeout> | undefined
        const finish = (result: 'current' | 'superseded' | 'held') => {
          if (done) return
          done = true; clearTimeout(timer); resolve(result)
        }
        work.then(() => finish(state()), error => { if (!done) { done = true; clearTimeout(timer); reject(error) } })
        const check = () => {
          const authority = state()
          if (authority !== 'current') { finish(authority); return }
          timer = setTimeout(check, 25)
        }
        check()
      })
      try {
        let authority = state()
        if (authority !== 'current') return authority === 'held' ? hold() : authority
        if (session.engine === 'cursor') {
          authority = await wait(cursorTaskHooks.wait(sessionId))
          if (authority !== 'current') return authority === 'held' ? hold() : authority
        }
        authority = await wait(drain(sessionId))
        if (authority !== 'current') return authority === 'held' ? hold() : authority
        execution.verify()
        authority = state()
        if (authority !== 'current') return authority === 'held' ? hold() : authority
        if (session.engine === 'cursor') {
          // These exact task IDs belong to the completed turn even after registration rebuilds its
          // parser. A successor's IDs are never selected; shutdown still revokes every continuation.
          const current = () => execution.current()
          cursorSubagents.closeParent(sessionId, status === 'error', current, tasks)
          const closing = cursorNormalizers.get(sessionId)!.closeTurn()
          afterStop?.(session)
          emit(sessionId, closing)
          if (status === 'error' && closing.length === 0) {
            announceTurnAborted(sessionId, 'cursor', 'Cursor ended the turn with an error before producing any output')
          }
          // Finish file cleanup before the admission receipt can release recovery attachment, which
          // would otherwise replay those original tasks into the replacement parser.
          authority = await wait(removePendingCursorTasks(dataDir, sessionId, current, tasks))
          if (authority !== 'current') return authority === 'held' ? hold() : authority
        } else if (original!.turnOpen) {
          authority = await wait(new Promise(resolve => setTimeout(resolve, STOP_HOOK_GRACE_MS)))
          if (authority !== 'current') return authority === 'held' ? hold() : authority
          authority = await wait(drain(sessionId))
          if (authority !== 'current') return authority === 'held' ? hold() : authority
          execution.verify()
          authority = state()
          if (authority !== 'current') return authority === 'held' ? hold() : authority
          if (original!.turnOpen) {
            original!.closeTurn()
            afterStop?.(session)
            emit(sessionId, [{ type: 'turn_ended', payload: {} }])
          }
        }
        return 'completed'
      } catch (error) {
        if (state() === 'superseded') return 'superseded'
        console.warn(`[hooks] ${session.engine} Stop outcome held:`, error)
        return hold()
      }
    }
    return (owner) => {
      // Cancel can resolve an uncertain Stop, but persistence retries must never repeat its effect.
      if (completion) return state() === 'superseded' ? Promise.resolve('superseded') : completion
      if (owner) execution = owner
      return completion = complete()
    }
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
  return { onTurnStart, onToolStart, onTurnStop, onPromptHook, captureStop }
}
