/**
 * The updater beside a core whose master is too old to run it: one released before the updater left the
 * core (services/updaterProcess.ts), that could not re-execute on this build (it predates re-execution, or
 * this build's master did not answer its probe). Such a master tells its core nothing about updates
 * (`HARNESSD_UPDATES`), and until something restarts it, a core that ran none would leave the machine on
 * this build for good, a broken one included. So this core starts the same updater, in a process of its
 * own (`cli.js __service updater`) and never in the core's: the core downloads no build. When it stages
 * one, the core hands over to its master (exit 75), as it did when the updater ran inside it, and that
 * master judges the new build as it always has. A new master re-executes on it and runs the updater itself.
 */

/** The updater's process, as the core watches it. */
export interface UpdaterChild {
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: () => void): void
  kill(): void
}

/** How long after the updater's process ends it is started again: its checks are a minute apart anyway. */
export const UPDATER_RESTART_MS = 30_000

export interface UpdaterBesideDeps {
  /** Start `__service updater`, with what it must know of this core's master (`HARNESSD_JUDGES_SUPERSEDED`). */
  spawn(): UpdaterChild
  /** The updater staged `version`: hand over for it. */
  staged(version: string): void
  log(line: string): void
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** Whether this core must run the updater beside itself: supervised by a master that does not say it runs one. */
export function needsUpdaterBeside(env: NodeJS.ProcessEnv, supervised: boolean, installedCopy: boolean, updatesOff: boolean): boolean {
  return supervised && env.HARNESSD_UPDATES !== 'master' && installedCopy && !updatesOff
}

const isStaged = (message: unknown): message is { type: 'harnessd:staged'; version: string } =>
  !!message && typeof message === 'object' && (message as { type?: unknown }).type === 'harnessd:staged'
  && typeof (message as { version?: unknown }).version === 'string'

/** Run the updater beside this core until it stages a build; returns a stop. */
export function startUpdaterBeside(deps: UpdaterBesideDeps): () => void {
  const setTimer = deps.setTimer ?? ((run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer })
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let child: UpdaterChild | null = null
  let timer: unknown = null
  let done = false
  const start = (): void => {
    timer = null
    const started = deps.spawn()
    child = started
    started.onMessage((message) => {
      if (!isStaged(message) || done) return
      done = true
      deps.log(`[update] the updater staged ${message.version} — handing over to this core's master`)
      deps.staged(message.version)
    })
    started.onExit(() => {
      if (child !== started) return
      child = null
      if (done) return
      deps.log(`[update] the updater ended — starting it again in ${UPDATER_RESTART_MS / 1000} s`)
      timer = setTimer(start, UPDATER_RESTART_MS)
    })
  }
  deps.log('[update] this core\'s master runs no updater — running it beside this core')
  start()
  return () => {
    done = true
    if (timer !== null) clearTimer(timer)
    child?.kill()
    child = null
  }
}
