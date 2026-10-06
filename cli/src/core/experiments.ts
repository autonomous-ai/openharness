/**
 * Which experiments are on as the core starts (core/api.ts `EXPERIMENTS`): one whose saved state is in the
 * data folder is asked for at once, so that what it does on its own (a saved project's queued work) goes on
 * after a restart, as it did when it ran in the core's process. One with none waits for its first request:
 * off, it has no process. Read once, at start, and bounded: a name or a folder listing, never a file's
 * contents.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
