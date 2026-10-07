/**
 * The core handing the machine to a newer build harnessd's updater has just staged (the master asks:
 * `harnessd:update`, harnessd/coreLink.ts), once start-up has finished: release what the next core needs
 * (the fixed ports, the backend's one-machine claim, the watchers and timers), then exit 75. The master
 * starts the new bundle the moment this core exits, and judges it.
 *
 * A teardown step that threw used to end the handoff where it stood: the core stayed on the old build with
 * its servers half closed and the new bundle staged but never judged (e2e/updateHostile.e2e.ts, round 40).
 * Now every step is tried, one that fails is said and passed, and the core exits 75 whatever happened; one
 * that hangs is given up on after `TEARDOWN_DEADLINE_MS`.
 *
 * A core with no master gets no update: the updater is the master's (services/updaterProcess.ts), and the
 * core never downloads a build. One an older release's own handoff started (it spawned `cli.js __run`,
 * e2e/migration.e2e.ts) would run this build until its next start, so once that release has gone it hands
 * the machine to a master (`handOver`, `handOverOnceReleased`): its master answers its probe first, as a
 * master asks before it re-executes on a bundle (harnessd/reexec.ts), then the same teardown, then
 * `handOff` starts `__harnessd`, names it in the pid file and exits. One `HARNESS_NO_MASTER=1` asked for
 * runs without updates, as asked.
 *
 * Staged means restart now. The restart once waited for the computer to go idle, and "idle" is a set of
 * latches (an open turn, a settling composer, an awaited submit, the control lock, a recap in flight):
 * one stuck latch deferred it for ever (0.0.26 on 2026-07-31, eight minutes of "deferring restart"), and
 * a daemon that quietly never updates is the failure the updater exists to prevent. A turn streaming at
 * that moment goes on in its pane, and the new core picks it up at attach and reads how it ends.
 *
 * Moved out of `runForeground` (src/architecture.spec.ts).
 */

import { patientDeadline } from '../lib/patientExec.js'
import { PROBE_ANSWER, PROBE_TIMEOUT_MS } from '../harnessd/protocol.js'

/** One thing the next core needs released, named for the log. */
export type TeardownStep = readonly [name: string, release: () => unknown]

/** How long the teardown may take before the core hands over all the same: it takes about a second. */
export const TEARDOWN_DEADLINE_MS = 15_000

export interface UpdateHandoffDeps {
  /** This core's version, for the log. */
  version: string
  /** A harnessd master runs this core. */
  supervised: boolean
  /** Exit for the update (`CORE_EXIT_UPDATE`), to the master that starts the new bundle. */
  exitForUpdate(): void
  /** Without a master: whether the master of the bundle on disk answers its probe (`probeStagedMaster`); null
   *  when it does, why not otherwise. */
  probeMaster(): Promise<string | null>
  /** Without a master: start harnessd's master on the bundle now on disk, name it in the pid file, exit. */
  handOff(): void
  log(line: string): void
  error(line: string): void
  teardownDeadlineMs?: number
}

export function createUpdateHandoff(deps: UpdateHandoffDeps) {
  let started = false
  let restarting = false
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
    /** Between the teardown starting and this core leaving (`/api/status`, and a signal mid-handoff). */
    restarting: (): boolean => restarting,
    /** Hand over to `newVersion`, releasing `teardown` first, and exit for the update. Once: a second call
     *  while one is under way does nothing. */
    async restartForUpdate(newVersion: string, teardown: readonly TeardownStep[]): Promise<void> {
      if (started) return
      started = true
      restarting = true
      deps.log(`[update] applying ${deps.version} → ${newVersion} — restarting daemon`)
      await releaseAll(teardown)
      // Everything above is released, or said not to be; the master starts the new bundle as soon as this
      // exits and rolls back to the .prev bytes if it does not come up and stay up.
      deps.log(`[update] handing ${newVersion} to harnessd`)
      deps.exitForUpdate()
    },
    /** Without a master: give the machine to one on this build, once its master answers; otherwise carry on.
     *  Resolves whether it handed over. */
    async handOver(teardown: readonly TeardownStep[]): Promise<boolean> {
      if (started) return false
      started = true
      // Asked before anything is let go: the core serves on while it answers, and on if it does not.
      const refused = await deps.probeMaster()
      if (refused !== null) {
        deps.error(`[update] this build's master did not answer its probe (${refused}) — carrying on without one`)
        started = false
        return false
      }
      restarting = true
      deps.log(`[update] handing ${deps.version} to a harnessd master, which runs the updater — this core is leaving`)
      await releaseAll(teardown)
      deps.handOff()
      return true
    },
  }
}

export type UpdateHandoff = ReturnType<typeof createUpdateHandoff>

/** Run the staged bundle's master probe (`node cli.js __harnessd-probe`); `done` gets how it ended. */
export type ProbeRun = (done: (error: Error | null, stdout: string) => void) => { kill(): void }

/**
 * Whether the staged bundle's master answers its probe: null when it does, why not otherwise. Its deadline
 * counts only time this process ran (`patientDeadline`), as the canary's does: a lid closed mid-probe must
 * not reject a good build.
 */
export function probeStagedMaster(run: ProbeRun, timeoutMs = PROBE_TIMEOUT_MS, deadline = patientDeadline): Promise<string | null> {
  return new Promise((resolve) => {
    let probe: { kill(): void } | null = null
    const cancel = deadline(timeoutMs, () => {
      probe?.kill()
      resolve(`no answer within ${timeoutMs} ms`)
    })
    probe = run((error, stdout) => {
      cancel()
      resolve(probeVerdict(error, stdout))
    })
  })
}

/** What a master probe's end says: null when it answered as a master, why not otherwise. */
export function probeVerdict(error: Error | null | undefined, stdout: string): string | null {
  if (!error && stdout.includes(PROBE_ANSWER)) return null
  return stdout.trim().split('\n').pop()?.trim() || error?.message || 'no answer'
}

/** How often a core an older release started looks for it to have gone. */
export const RELEASED_POLL_MS = 2_000

/**
 * Hand the machine to a master once the older release that started this core has gone: it spawned this
 * core detached, judged it by its bind and its connection (up to a minute and a half) and leaves; a core
 * that left first would be read as the new build failing, and rolled back. Gone is its process ended, or
 * this core reparented away from it. Returns a stop.
 */
export function handOverOnceReleased(deps: {
  startedBy: number
  parent(): number
  alive(pid: number): boolean
  handOver(): void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}): () => void {
  const setTimer = deps.setTimer ?? ((run, ms) => { const timer = setInterval(run, ms); timer.unref?.(); return timer })
  const clearTimer = deps.clearTimer ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>))
  const timer = setTimer(() => {
    if (deps.parent() === deps.startedBy && deps.alive(deps.startedBy)) return
    clearTimer(timer)
    deps.handOver()
  }, RELEASED_POLL_MS)
  return () => clearTimer(timer)
}
