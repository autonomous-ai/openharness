/**
 * Which experiments are on as the core starts (core/api.ts `EXPERIMENTS`): one whose saved state is in the
 * data folder is asked for at once, so that what it does on its own (a saved project's queued work) goes on
 * after a restart, as it did when it ran in the core's process. One with none waits for its first request:
 * off, it has no process. Read once, at start, and bounded: a name or a folder listing, never a file's
 * contents.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BackendNotice } from './api.js'

/** Whether any of `state` is in `dataDir`: a path under it, or `dir/*.ext` for a file of that kind in that folder. */
export function stateIsThere(dataDir: string, state: readonly string[]): boolean {
  return state.some((entry) => {
    const star = entry.lastIndexOf('/*')
    if (star < 0) return existsSync(join(dataDir, entry))
    const suffix = entry.slice(star + 2)
    try {
      return readdirSync(join(dataDir, entry.slice(0, star))).some((name) => name.endsWith(suffix))
    } catch {
      return false
    }
  })
}

/** Ask for each experiment that runs in its own process and has saved state here. */
export function wakeExperiments(options: {
  dataDir: string
  experiments: Readonly<Record<string, { state: readonly string[] }>>
  outOfProcess: ReadonlySet<string>
  want: (service: string) => void
}): string[] {
  const woken = Object.entries(options.experiments)
    .filter(([name, experiment]) => options.outOfProcess.has(name) && stateIsThere(options.dataDir, experiment.state))
    .map(([name]) => name)
  for (const name of woken) options.want(name)
  return woken
}

/**
 * The account's notices the backend announces (`desk_changed`, …), for the experiments that hear them: each
 * listener in this process (`core.account.onNotice`), guarded, and each experiment's process (`tell`). Tab
 * collaboration reads its tab channels again at `desk_changed`, as the socket did before it left.
 */
export function createAccountNotices(tell: (notice: BackendNotice) => void, log: (line: string) => void = (line) => console.warn(line)) {
  const listeners = new Set<(notice: BackendNotice) => void>()
  return {
    onNotice(listener: (notice: BackendNotice) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notice(notice: BackendNotice): void {
      for (const listener of listeners) {
        try { listener(notice) } catch (error) { log(`[experiments] a notice's listener failed · ${error instanceof Error ? error.message : String(error)}`) }
      }
      tell(notice)
    },
  }
}

/**
 * What the core does for the experiments as a whole: ask the master for one (`want`), first doing what that
 * experiment must not miss from then on (`onWant`: the teams' scopes kept from the moment teams is on), and
 * hand the account's notices to the listeners here and to each experiment in its own process.
 */
export function createExperimentHooks(deps: {
  want: (service: string) => void
  notify: (service: string, frame: { type: string; payload: Record<string, unknown> }) => boolean
  outOfProcess: ReadonlySet<string>
  experiments: Iterable<string>
  onWant?: Readonly<Record<string, () => void>>
  log?: (line: string) => void
}) {
  const notices = createAccountNotices((notice) => {
    for (const name of deps.experiments) if (deps.outOfProcess.has(name)) deps.notify(name, { type: 'service_event', payload: { kind: 'notice', notice } })
  }, deps.log)
  return {
    want(service: string): void {
      if (deps.onWant && Object.hasOwn(deps.onWant, service)) deps.onWant[service]()
      deps.want(service)
    },
    onNotice: notices.onNotice,
    notice: notices.notice,
  }
}
