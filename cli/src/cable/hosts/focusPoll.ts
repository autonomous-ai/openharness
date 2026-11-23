/**
 * The poll of WezTerm's or kitty's focus that the dial follows while that app is in front
 * (docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md, "The poll, in the devices process").
 *
 * A poll, as no command of either app subscribes to or waits for a focus change, and their own focus events need the
 * person's config (`wezterm.lua`'s `window-focus-changed`, `kitty.conf`'s `watcher`), which Harness never edits
 * (recorded 2026-11-23, the spec's "What the apps offer").
 *
 * One read at a time, FOCUS_POLL_MS after the last one ended, so a slow app is never asked twice at once. It stops
 * itself after FOCUS_FAILS_MAX failed reads in a row: a WezTerm whose GUI is gone would otherwise be asked twice a
 * second for as long as it is in front, and the app's next settle starts a poll again. A kitty that refuses is kept by
 * its adapter instead (kitty.ts), so its reads do not fail.
 *
 * Its lines are fixed words and counts only.
 */

/** 500 ms after each read ends: the Terminal and iTerm2 tab poll's interval (#4331). */
export const FOCUS_POLL_MS = 500
/** How long one read of an app's focus may take, all its calls together (wezterm.ts focusedPane, kitty.ts focusedWindows). */
export const FOCUS_READ_MS = 2_000
/** Failed reads in a row after which the poll stops itself. */
export const FOCUS_FAILS_MAX = 3

export interface FocusPollDeps<T> {
  /** One read: its answer, or undefined for one that failed. A rejection is a failed read. */
  read(): Promise<T | undefined>
  /** Each answer of a read that ended before the stop, in order. */
  answered(answer: T): void
  /** Told once, when the poll stopped itself after FOCUS_FAILS_MAX failed reads in a row. */
  failing(): void
  /** A timer and its cancel, as devices.ts timerIn gives one. */
  after(ms: number, run: () => void): () => void
  log(line: string): void
}

export interface FocusPoll {
  stop(): void
}

/** Reads at once, then FOCUS_POLL_MS after each read ends, until stopped or failing. */
export function startFocusPoll<T>(deps: FocusPollDeps<T>): FocusPoll {
  let stopped = false
  let reads = 0
  let failed = 0
  let failedInARow = 0
  let cancelWait: (() => void) | undefined

  const end = (failing: boolean): void => {
    stopped = true
    cancelWait?.()
    deps.log(`[device] focus poll · stopped · ${reads} reads, ${failed} failed${failing ? ' · failing' : ''}`)
  }

  const read = async (): Promise<void> => {
    let answer: T | undefined
    try {
      answer = await deps.read()
    } catch {
      answer = undefined
    }
    // The read under way at a stop is of a front no longer followed: its answer is dropped and not counted.
    if (stopped) return
    reads++
    if (answer === undefined) {
      failed++
      failedInARow++
      if (failedInARow < FOCUS_FAILS_MAX) cancelWait = deps.after(FOCUS_POLL_MS, read)
      else {
        end(true)
        deps.failing()
      }
      return
    }
    failedInARow = 0
    // Waiting before the answer is told: a stop it makes cancels the wait, and a throw costs the poll no read.
    cancelWait = deps.after(FOCUS_POLL_MS, read)
    try {
      deps.answered(answer)
    } catch {
      // The answer's throw is its listener's to say (devices.ts runs each in a part of its own), as cmuxSource.ts's.
    }
  }

  deps.log('[device] focus poll · started')
  void read()
  return {
    stop() {
      if (!stopped) end(false)
    },
  }
}
