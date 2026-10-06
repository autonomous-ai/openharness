/**
 * The Wi-Fi device's pieces, as the core starts them: each one, or none.
 *
 * The Wi-Fi device is experimental, and its service and its direct link read their state files when
 * they are built. One that did not parse threw out of the core's start, and a core whose start throws
 * sits in safe mode: every terminal on the computer down, for a feature most never use. A piece that
 * cannot be built is now left out, and said so; the core starts without it, and the requests that
 * need it answer UNAVAILABLE. The files are left as they are, for whoever looks into them.
 */
export function startDevicePart<T>(what: string, build: () => T): T | undefined {
  try {
    return build()
  } catch (error) {
    console.warn(`[device] the ${what} could not be started, and this daemon runs without it: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** [part], or an UNAVAILABLE refusal for a request that needs the piece that could not be started. */
export function runningDevicePart<T>(part: T | undefined, what: string): T {
  if (part === undefined) throw Object.assign(new Error(`The ${what} is not running on this computer: its state could not be read. See the daemon's log.`), { code: 'UNAVAILABLE' })
  return part
}
