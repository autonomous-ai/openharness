/**
 * Which file a service's process is started from: the lean bundle (./leanBundle.ts), only while it is
 * purely an optimisation, and cli.js otherwise.
 *
 * The lean bundle is code the master wrote into the data folder as it started, and a master lives for
 * weeks. Started from it unconditionally, a service failed on every restart once the folder went (a
 * cleaner, a person tidying up): MODULE_NOT_FOUND until the master itself restarted. And once an update
 * installed a new cli.js that this master did not re-execute on (a Node without `process.execve`, or a
 * re-execution it kept back), every service ran the old lean code against the new core for the rest of
 * the master's life. So before each start: the lean bundle's files must still be the ones this master
 * was started with, and cli.js must still be the bundle they came from; and a service that dies twice
 * running from it before it ever beats starts from cli.js from then on. cli.js is always there to fall
 * back on: it is what the core runs.
 */
import { dirname } from 'node:path'
import { isCoreMessage } from './protocol.js'
import type { CoreHandle } from './supervisor.js'

/** This many deaths in a row before a first heartbeat, started from the lean bundle, and a service is
 *  started from cli.js for the rest of this master's life. */
export const LEAN_EARLY_DEATHS = 2

export interface LeanServicesDeps {
  /** cli.js (or the sources): what the core runs. */
  scriptPath: string
  /** The lean bundle's entry, when this master has one. */
  leanPath?: string
  /** What the lean bundle's folder should fingerprint to (./leanBundle.ts `leanFingerprint`); without
   *  it, only that the entry is there is checked. */
  leanFingerprint?: string
  /** The fingerprint of the lean bundle in a folder, null when it holds none (./leanBundle.ts). */
  folderFingerprint(folder: string): string | null
  exists(path: string): boolean
  /** Whether the bundle on disk is still the one this master runs: the one its lean bundle came from. */
  sameBundle(): boolean
  log(line: string): void
}

export interface LeanServices {
  /** The file to start service [name] from now. */
  scriptFor(name: string): string
  /** Watch a process started from [script] for a death before its first heartbeat. */
  started(name: string, script: string, handle: CoreHandle): void
}

export function leanServices(deps: LeanServicesDeps): LeanServices {
  const { leanPath, scriptPath } = deps
  const earlyDeaths = new Map<string, number>()
  let said: string | null = null
  /** Why the lean bundle cannot be used now; null when it can. */
  const unusable = (lean: string): string | null => {
    if (!deps.sameBundle()) return `${scriptPath} is no longer the bundle it came from`
    if (deps.leanFingerprint === undefined) return deps.exists(lean) ? null : 'it is gone'
    const found = deps.folderFingerprint(dirname(lean))
    return found === deps.leanFingerprint ? null : found === null ? 'it is gone' : 'its files changed'
  }
  return {
    scriptFor: (name) => {
      if (!leanPath || leanPath === scriptPath) return scriptPath
      if ((earlyDeaths.get(name) ?? 0) >= LEAN_EARLY_DEATHS) return scriptPath
      const why = unusable(leanPath)
      if (why === null) { said = null; return leanPath }
      // Said once per reason, not on every restart.
      if (said !== why) deps.log(`[harnessd] the lean bundle ${leanPath} cannot be used (${why}): services start from ${scriptPath}`)
      said = why
      return scriptPath
    },
    started: (name, script, handle) => {
      if (script === scriptPath) return
      let beat = false
      handle.onMessage((message) => {
        if (beat || !isCoreMessage(message) || message.type !== 'harnessd:heartbeat') return
        beat = true
        earlyDeaths.delete(name)
      })
      handle.onExit((_code, signal) => {
        // SIGTERM is the master's own stop (the daemon stopping, a memory restart): not the bundle's fault.
        if (beat || signal === 'SIGTERM') return
        const deaths = (earlyDeaths.get(name) ?? 0) + 1
        earlyDeaths.set(name, deaths)
        if (deaths === LEAN_EARLY_DEATHS) {
          deps.log(`[harnessd] service ${name} died ${deaths} times from the lean bundle before it beat: it starts from ${scriptPath} from now on`)
        }
      })
    },
  }
}
