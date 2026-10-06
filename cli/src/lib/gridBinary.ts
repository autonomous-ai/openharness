/**
 * Which `grid` this daemon runs, and the environment it runs it in: the resolution behind every grid
 * call (`gridExec.ts`) and behind every pane the core launches on a grid (`engineLaunch.ts`).
 *
 * Its own module so the core can launch an agent on a grid without loading the code that runs `grid`
 * itself: that is the models service's (services/models.ts), which runs in a process of its own
 * (docs/design/2026-10-06-core-boundary-next.md, step 7). It reads files and never spawns.
 */
import { accessSync, constants, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { env } from '../config/env.js'
import { binaryOnPath } from './binaryOnPath.js'

/** The command, as it is named on PATH — the last resort of [gridBinaryPath], and the word the
 *  sign-out's own "nothing to run" sentence uses (`gridLogout.ts`). */
export const GRID_BINARY = 'grid'

/**
 * grid's own update check, and the one switch that turns it off.
 *
 * A `grid` with a terminal on stderr looks for a newer release and, finding one, prints "run
 * `grid update`" — and `grid update` replaces the binary IN PLACE, wherever `which grid` found it
 * (autonomous-grid `cli/update.py`). Under a managed runtime that file is the pin, and the process
 * most likely to read that line and obey it is an agent in a pane. So the check is off for every
 * child this daemon spawns ([gridChildEnv]) and in every pane it launches (`engineLaunch.ts`), by
 * the variable grid honours for it. The daemon's own spawns pipe stderr and would be spared anyway;
 * saying it explicitly is what makes the pane and the daemon one rule.
 */
export const GRID_NO_UPDATE_CHECK_VAR = 'GRID_NO_UPDATE_CHECK'

/** The environment a `grid` child gets: the caller's own, with the update check off. */
export function gridChildEnv(processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...processEnv, [GRID_NO_UPDATE_CHECK_VAR]: '1' }
}

/**
 * The managed grid — the runtime `current-grid` names — or null when there is none this daemon
 * would trust.
 *
 * Containment-checked exactly like `nodeRuntime.managedNodePath`: a pointer file is only trusted
 * when it names something INSIDE the runtime directory we own, so a corrupted or hostile pointer
 * cannot turn this into "run any executable on the box". `runtimeInstall.ts` writes the pointer and
 * asks this to learn what is already laid down.
 */
export function managedGridPath(): string | null {
  try {
    const recorded = readFileSync(join(env.ADAPTER_RUNTIME_DIR, 'current-grid'), 'utf-8').trim()
    if (recorded && recorded.startsWith(env.ADAPTER_RUNTIME_DIR + sep)) {
      accessSync(recorded, constants.X_OK)
      return recorded
    }
  } catch {
    // absent, unreadable, or not executable → there is no managed grid
  }
  return null
}

/**
 * The `grid` this daemon should run: the override, the managed runtime, the name on PATH, or —
 * last — the directory grid's own public installer uses (`lib/gridInstall.ts`), which a daemon
 * started from a launcher with launchd's bare PATH does not have. Named absolutely rather than by
 * extending PATH, so the fallback reaches exactly one known file and never whatever else that
 * directory holds. The managed runtime outranks it: once the pin is published the installer's
 * copy is only ever a fallback for a machine the pin could not reach.
 */
export function gridBinaryPath(processEnv: NodeJS.ProcessEnv = process.env): string {
  const override = processEnv.HARNESS_GRID_BIN?.trim()
  if (override) return override
  const managed = managedGridPath()
  if (managed) return managed
  if (binaryOnPath(GRID_BINARY, processEnv)) return GRID_BINARY
  // Keyed on the environment's HOME rather than `os.homedir()`, so a caller that hands in an
  // environment (the tests, a deliberately bare one) gets exactly what that environment can see.
  const home = processEnv.HOME?.trim()
  if (home) {
    const installed = join(home, '.local', 'bin', GRID_BINARY)
    try { accessSync(installed, constants.X_OK); return installed } catch { /* not there either */ }
  }
  return GRID_BINARY
}

/** Is there a `grid` to run at all? Asked by reading rather than by spawning, so a missing binary is
 *  a sentence rather than a spawn error every caller has to recognise — and so a present-but-not-
 *  executable one (EACCES, never ENOENT) is caught too. */
export function gridAvailable(processEnv: NodeJS.ProcessEnv = process.env): boolean {
  return binaryOnPath(gridBinaryPath(processEnv), processEnv)
}

/**
 * Which `grid` this machine would run, for a desktop that has to say so.
 *
 * `managed` is the runtime this daemon owns — the pin. `path` is one the user installed themselves,
 * or a developer's override: runnable, but not the pin, and not ours to keep current. `missing` is
 * nothing to run at all, which the picker and the Local model dialog need to know BEFORE they offer
 * to start an agent whose second step is `grid`.
 */
export type GridCliPresence = 'managed' | 'path' | 'missing'

export function gridCliPresence(processEnv: NodeJS.ProcessEnv = process.env): GridCliPresence {
  const binary = gridBinaryPath(processEnv)
  if (!binaryOnPath(binary, processEnv)) return 'missing'
  // An override is the developer's wherever it lives — under the runtime dir included. Only what the
  // pointer names is the pin.
  if (processEnv.HARNESS_GRID_BIN?.trim()) return 'path'
  return binary.startsWith(env.ADAPTER_RUNTIME_DIR + sep) ? 'managed' : 'path'
}
