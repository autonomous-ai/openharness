/**
 * Which Hermes keeps a record of its terminal's session (`hermes_cli/terminal_breadcrumbs.py`), to be followed from
 * it rather than from a hook: v0.21.6 and later do; an older one does not, nor does a home set to the TUI, whose
 * interface writes none. Nothing here writes anything.
 */
import { HERMES_HOOKS_SAID, HERMES_RECORD_SINCE, HERMES_VERSION } from './hermes/contract.js'
import { captureLaunchExecutable } from './kit/launchExecutable.js'
import { nativeProcessEnvironment } from './kit/nativeLocations.js'
import { nativeVersionProbe, parseRelease, probedVersion, releaseAtLeast, type Release } from './kit/nativeVersion.js'

export interface HermesVersionDeps { capture: typeof captureLaunchExecutable; probe: typeof nativeVersionProbe }

const releases = new Map<string, Release | null>()
// The installed files whose version could not be read, each said once; '' stands for no file at all.
const unreadable = new Set<string>()

/**
 * Whether the Hermes at [executable], else the one a launch would run, keeps a terminal record: null when its version
 * cannot be told. Asked once per installed file and kept for the daemon's life.
 */
export async function hermesKeepsRecord(executable?: { command: string }, environment?: Readonly<Record<string, string>>,
  deps: HermesVersionDeps = { capture: captureLaunchExecutable, probe: nativeVersionProbe }): Promise<boolean | null> {
  let locations: Readonly<NodeJS.ProcessEnv> | undefined = environment
  if (!executable) {
    const captured = await deps.capture('hermes')
    if (captured.state !== 'ready') return unknown('')
    executable = captured.executable
    locations = captured.environment
  }
  const { command } = executable
  // With no locations of its own the probe runs in the daemon's environment.
  const probe = deps.probe(HERMES_VERSION, () => command, locations && nativeProcessEnvironment(locations))
  const release = await probedVersion(output => parseRelease(HERMES_VERSION, output), probe, releases)
  return release ? releaseAtLeast(release, HERMES_RECORD_SINCE) : unknown(probe.identity() ?? '')
}

function unknown(file: string): null {
  if (!unreadable.has(file)) {
    unreadable.add(file)
    console.log(HERMES_HOOKS_SAID.unknown)
  }
  return null
}

export { hermesHomeIsTui, rememberRecordHome, isRecordHome } from './kit/hermesRecordHomes.js'
import { forgetRecordHomes } from './kit/hermesRecordHomes.js'

/** Test seam. */
export function forgetHermesRecord(): void {
  releases.clear()
  unreadable.clear()
  forgetRecordHomes()
}
