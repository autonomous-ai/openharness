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
 * Without a master (a core an older release's own handoff started, e2e/migration.e2e.ts, or
 * `HARNESS_NO_MASTER=1`) the core gives the machine to one, which judges the build as every update: the
 * staged bundle's master must answer its probe first, as before a re-execution (harnessd/reexec.ts), or the
 * build before goes back, rejected; then the same teardown, and `handOff` starts `__harnessd` and exits.
 * The master finds the pending note and puts its first core on probation (harnessd/supervisor.ts,
 * `unjudgedUpdate`). The core once spawned a core like itself and judged it, which then had no master.
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
  /** Without a master: whether the staged bundle's master answers its probe (`probeStagedMaster`); null when
   *  it does, why not otherwise. */
  probeMaster(): Promise<string | null>
  /** Without a master: put the build before back (`selfUpdate.restore`), remembering this one as rejected. */
  rollBack(): void
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
    /** Hand over to `newVersion`, releasing `teardown` first. Once: a second call while one is under way does nothing. */
    async restartForUpdate(newVersion: string, teardown: readonly TeardownStep[]): Promise<void> {
      if (started) return
      started = true
      deps.log(`[update] applying ${deps.version} → ${newVersion} — restarting daemon`)
      // Asked before anything is let go: the core serves on while it answers.
      const refused = deps.supervised ? null : await deps.probeMaster()
      if (refused !== null) {
        deps.error(`[update] ${newVersion}'s master did not answer its probe (${refused}) — rolled back; this build goes on under a master of its own`)
        deps.rollBack()
      }
      restarting = true
      await releaseAll(teardown)
      if (deps.supervised) {
        // Everything above is released, or said not to be; the master starts the new bundle as soon as
        // this exits and rolls back to the .prev bytes if it does not come up and stay up.
        deps.log(`[update] handing ${newVersion} to harnessd`)
        deps.exitForUpdate()
        return
      }
      deps.log(`[update] handing ${refused === null ? newVersion : deps.version} to a harnessd master, which judges it — this core is leaving`)
      deps.handOff()
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

/** What a master probe's end says: null when it answered as a master, why not otherwise. Shared by the
 *  boot handoff's synchronous probe (lib/daemonSafeMode.ts `runBootHandoff`). */
export function probeVerdict(error: Error | null | undefined, stdout: string): string | null {
  if (!error && stdout.includes(PROBE_ANSWER)) return null
  return stdout.trim().split('\n').pop()?.trim() || error?.message || 'no answer'
}
