/**
 * The core handing the machine to a newer build its updater has just staged (`selfUpdate.ts`
 * `startSelfUpdater`'s `onStaged`), once start-up has finished: release what the next core needs (the
 * fixed ports, the backend's one-machine claim, the watchers and timers), then go.
 *
 * Under harnessd the master starts the new bundle the moment this core exits 75, and judges it. A
 * teardown step that threw used to end the handoff where it stood: the core stayed on the old build with
 * its servers half closed, its updater stopped and the new bundle staged but never judged
 * (e2e/updateHostile.e2e.ts, round 40). Now every step is tried, one that fails is said and passed, and
 * the core exits 75 whatever happened; one that hangs is given up on after `TEARDOWN_DEADLINE_MS`.
 *
 * Without a master (a core run on its own) the old way stands: the first step that fails ends the
 * handoff, and `handOff` spawns the successor and judges it itself.
 *
 * Staged means restart now. The restart once waited for the computer to go idle, and "idle" is a set of
 * latches (an open turn, a settling composer, an awaited submit, the control lock, a recap in flight):
 * one stuck latch deferred it for ever (0.0.26 on 2026-07-31, eight minutes of "deferring restart"), and
 * a daemon that quietly never updates is the failure the updater exists to prevent. A turn streaming at
 * that moment goes on in its pane, and the new core picks it up at attach and reads how it ends.
 *
 * Moved out of `runForeground` (src/architecture.spec.ts).
 */

/** One thing the next core needs released, named for the log. */
export type TeardownStep = readonly [name: string, release: () => unknown]

/** The successor a handoff without a master spawned, which a signal must take down with this core. */
export interface HandoffChild { pid?: number }

/** How long the teardown may take before the core hands over all the same: it takes about a second. */
export const TEARDOWN_DEADLINE_MS = 15_000

export interface UpdateHandoffDeps {
  /** This core's version, for the log. */
  version: string
  /** A harnessd master runs this core. */
  supervised: boolean
  /** Exit for the update (`CORE_EXIT_UPDATE`), to the master that starts the new bundle. */
  exitForUpdate(): void
  /**
   * The handoff without a master: spawn the successor on the staged bundle, keep it or roll back.
   * `track` names the successor a signal must take down with this core, and null once it is the daemon.
   */
  handOff(newVersion: string, track: (child: HandoffChild | null) => void): Promise<void>
  log(line: string): void
  error(line: string): void
  teardownDeadlineMs?: number
}

export function createUpdateHandoff(deps: UpdateHandoffDeps) {
  let restarting = false
  let child: HandoffChild | null = null
  const deadlineMs = deps.teardownDeadlineMs ?? TEARDOWN_DEADLINE_MS
  const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

  /** Every step, in order, each failure said and passed; given up on, all the same, after the deadline. */
  const releaseAll = async (teardown: readonly TeardownStep[]): Promise<void> => {
    let at = ''
    const steps = (async () => {
      for (const [name, release] of teardown) {
        at = name
        try { await release() } catch (error) { deps.error(`[update] ${name} did not let go (${message(error)}) — handing over all the same`) }
      }
      at = ''
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        deps.error(`[update] the teardown did not finish within ${deadlineMs} ms (at ${at}) — handing over all the same`)
        resolve()
      }, deadlineMs)
    })
    await Promise.race([steps, late])
    clearTimeout(timer)
  }

  return {
    /** Between an update being staged and this core leaving (`/api/status`, and a signal mid-handoff). */
    restarting: (): boolean => restarting,
    /** The successor a handoff without a master is judging, until it is the daemon. */
    child: (): HandoffChild | null => child,
    /**
     * Hand over to `newVersion`, releasing `teardown` first. Once: a second call while one is under way
     * does nothing. Rejects only without a master, when a step failed or the successor could not be
     * started; then `abandon` lets this core carry on.
     */
    async restartForUpdate(newVersion: string, teardown: readonly TeardownStep[]): Promise<void> {
      if (restarting) return
      restarting = true
      deps.log(`[update] applying ${deps.version} → ${newVersion} — restarting daemon`)
      if (deps.supervised) {
        await releaseAll(teardown)
        // Everything above is released, or said not to be; the master starts the new bundle as soon as
        // this exits and rolls back to the .prev bytes if it does not come up and stay up.
        deps.log(`[update] handing ${newVersion} to harnessd`)
        deps.exitForUpdate()
        return
      }
      for (const [, release] of teardown) await release()
      await deps.handOff(newVersion, (successor) => { child = successor })
    },
    /** A handoff without a master that failed before it handed anything over: this core stays. */
    abandon(): void {
      restarting = false
      child = null
    },
  }
}

export type UpdateHandoff = ReturnType<typeof createUpdateHandoff>
