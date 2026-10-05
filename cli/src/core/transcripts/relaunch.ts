/**
 * Where an engine's writing becomes live again after a relaunch — of the engine, by a resume, or of the
 * daemon, by a restart.
 *
 * Either way the engine can take a turn before the daemon has attached its transcript: a resume waits
 * on the process to be confirmed, a restart opens its request gate before the restored agents' attaches
 * have run, and every attach waits its turn in the attach queue. The attach folds what is on disk as
 * history, so a turn the engine began and finished in that window reached no window as a turn — no
 * `turn_started`, no `turn_ended`, the answer only in history. Found end to end, both ways: a message
 * typed into an agent's terminal the moment it reopened after a resume, and after a daemon restart, was
 * answered and never seen (e2e/terminal.e2e.ts).
 *
 * So the transcript's size is noted where the engine's own writing begins: by a resume just before it
 * launches the engine, and by the daemon at start for every conversation it restores. The attach that
 * follows folds the conversation only up to that byte and tails from there, so what was written after
 * it is live. A mark is used once, by the next attach of that conversation; one older than a resume can
 * wait for (`RESUME_READINESS_BUDGET_MS`) belongs to an operation that is over and is not used.
 */
import { statSync } from 'node:fs'
import { RESUME_READINESS_BUDGET_MS } from '../../lib/resumeStoppedAgent.js'

/** A transcript's size now, or null when there is no file to tail. One stat: nothing for a launch to wait on. */
export function transcriptSize(path: string): number | null {
  try { return statSync(path).size } catch { return null }
}

export interface RelaunchMarkOptions {
  now?: () => number
  maxAgeMs?: number
}

/**
 * Where a relaunched conversation's live writing begins, and whether a new engine was started on it. A
 * daemon's start marks every conversation it restores, including those whose engine kept running in
 * tmux; only a resume, or a restore that rebuilt the pane, starts a new engine. A turn left open before
 * a new engine started died with the engine before it: announced again at the attach, it showed the
 * interrupted message starting anew in every window (e2e/machine.e2e.ts, Codex after the tmux server
 * died mid-turn).
 */
export interface RelaunchMark {
  offset: number
  engineStarted: boolean
}

export function createRelaunchMarks({ now = Date.now, maxAgeMs = RESUME_READINESS_BUDGET_MS }: RelaunchMarkOptions = {}) {
  const marks = new Map<string, RelaunchMark & { at: number }>()
  return {
    /** Before the engine is launched: its own writing starts at `offset`. */
    note(sessionId: string, offset: number, engineStarted = false): void {
      marks.set(sessionId, { offset, engineStarted, at: now() })
    },
    /** A restore rebuilt this conversation's pane, so its engine is a new one. */
    engineStarted(sessionId: string): void {
      const mark = marks.get(sessionId)
      if (mark) mark.engineStarted = true
    },
    /** At the attach: where the fold stops, and whether the engine is new, once. */
    take(sessionId: string): RelaunchMark | undefined {
      const mark = marks.get(sessionId)
      if (!mark) return undefined
      marks.delete(sessionId)
      return now() - mark.at <= maxAgeMs ? { offset: mark.offset, engineStarted: mark.engineStarted } : undefined
    },
    /** How many marks are waiting for an attach — for tests and diagnostics. */
    get size(): number {
      return marks.size
    },
  }
}

export type RelaunchMarks = ReturnType<typeof createRelaunchMarks>
