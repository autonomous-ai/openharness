/**
 * When the devices' process starts (harnessd/services.ts `devices`, on demand since protocol 4): once there is
 * a device, so a computer with none never pays for it (about 72 MiB at idle, measured for step 9).
 *
 * What asks for it:
 * - **a dial's port**: a USB modem's callout node in /dev (`cu.usbmodem*` on macOS, `ttyACM*` or `ttyUSB*` on
 *   Linux), looked for every two seconds, the dial's own scan's cadence (#909). A listing of /dev and nothing
 *   more: no `ioreg`, no open, no read of a port. The devices' own scan then decides whether it is a dial.
 * - **a paired Wi-Fi device**, as the core starts: one the gateway's pairings name as a device, or one its direct
 *   links connect out to, which start only once the device's service serves (gateway/start.ts `wifiService`).
 *   Read once, bounded; the pairings' file holds public keys and labels.
 * - **a Wi-Fi device's session through the relay, its pairing, a request for the devices** (the Devices tab,
 *   ⌘K): core/wifi.ts and the service links (`onDemand`) ask for it as they come.
 *
 * Once asked for, it is the master's to keep running, as every service is.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The services in the devices' process, which a request or a notice for wakes. */
export const DEVICES_ON_DEMAND = ['devices', 'wifi'] as const
/** How often /dev is looked at for a dial's port while there is none: the dial's own scan's cadence. */
export const DIAL_LOOK_MS = 2_000
/** The Wi-Fi device's direct links (lib/autonomous-device/direct.ts) and the gateway's pairings (lib/e2ee/store.ts),
 *  read no further than this. */
export const DIRECT_LINKS = 'autonomous-device-connections.json'
export const PAIRINGS = join('e2e', 'paired.json')
const SAVED_MAX = 1_048_576

/** Whether a dial's port may be there: a USB modem's node, or one of the end-to-end suite's dials (a
 *  pseudo-terminal, or a `.json` list of them, as cable/cableFleet.ts `testDialDiscovery` reads it). */
export function dialPortThere(deps: { platform: NodeJS.Platform; listDev: () => string[]; testDialPort?: string; read: (file: string) => string; exists: (path: string) => boolean }): boolean {
  try {
    if (deps.testDialPort) {
      if (!deps.testDialPort.endsWith('.json')) return deps.exists(deps.testDialPort)
      const listed: unknown = JSON.parse(deps.read(deps.testDialPort))
      return Array.isArray(listed) && listed.some((row) => typeof row?.path === 'string')
    }
    const names = deps.platform === 'darwin' ? ['cu.usbmodem'] : deps.platform === 'linux' ? ['ttyACM', 'ttyUSB'] : []
    return names.length > 0 && deps.listDev().some((name) => names.some((prefix) => name.startsWith(prefix)))
  } catch {
    return false
  }
}

/** The rows of one of the gateway's saved lists in the data folder, read no further than a bound; none when it is
 *  not there, too big or not a list. */
export function savedRows(dataDir: string, name: string, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): unknown[] {
  const file = join(dataDir, name)
  try {
    if (statSync(file).size > SAVED_MAX) return []
    const listed: unknown = JSON.parse(read(file))
    return Array.isArray(listed) ? listed : []
  } catch {
    return []
  }
}

/** Whether a Wi-Fi device is paired here: the gateway's pairings name one as a device, or its direct links
 *  connect out to one. */
export function wifiDeviceSaved(dataDir: string, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): boolean {
  return savedRows(dataDir, DIRECT_LINKS, read).length > 0
    || savedRows(dataDir, PAIRINGS, read).some((pair) => (pair as { role?: unknown } | null)?.role === 'device')
}

export interface DevicesWakeDeps {
  /** Ask the master for the process that runs this service (harnessd/coreLink.ts `want`). */
  want(service: string): void
  dataDir: string
  /** `CABLE_DISABLE`: the serial ports are left alone, so no port asks for them. */
  cableDisabled?: boolean
  /** `HARNESSD_TEST_DIAL_PORT`: the end-to-end suite's dials. */
  testDialPort?: string
  platform?: NodeJS.Platform
  listDev?: () => string[]
  read?: (file: string) => string
  exists?: (path: string) => boolean
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  log?: (line: string) => void
}

export function createDevicesWake(deps: DevicesWakeDeps) {
  const read = deps.read ?? ((file: string) => readFileSync(file, 'utf8'))
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms).unref())
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const log = deps.log ?? ((line: string) => console.log(line))
  const look = (): boolean => dialPortThere({
    platform: deps.platform ?? process.platform,
    listDev: deps.listDev ?? (() => readdirSync('/dev')),
    testDialPort: deps.testDialPort,
    read,
    exists: deps.exists ?? existsSync,
  })
  /** The services asked for; which run in their own process, once the core is bound (null before). */
  const asked = new Set<string>()
  let out: ReadonlySet<string> | null = null
  let timer: unknown = null
  const stopLooking = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  const want = (service: string, why: string): void => {
    log(`[devices] ${why}: asking for the devices' process`)
    deps.want(service)
  }
  /** Asked before the master could hear it (the core not yet bound): asked again at `start`. */
  const early: Array<[string, string]> = []
  /** True when the service's process is asked for, or will be once the core is bound; false when the service
   *  runs in the core's process, with nothing to ask for. */
  const ask = (service: string, why: string): boolean => {
    if (out && !out.has(service)) return false
    if (asked.has(service)) return true
    asked.add(service)
    if (service === 'devices') stopLooking()
    if (out) want(service, why)
    else early.push([service, why])
    return true
  }
  const lookAgain = (): void => {
    timer = setTimer(() => {
      timer = null
      if (look()) ask('devices', 'a dial\'s port is there')
      else lookAgain()
    }, DIAL_LOOK_MS)
  }

  return {
    /** The core is bound and its master hears it: what was asked meanwhile is asked now, and, with the dials
     *  in their own process, a device already here asks for it, or /dev is looked at until one is. */
    start(outOfProcess: ReadonlySet<string>): void {
      out = outOfProcess
      for (const [service, why] of early.splice(0)) if (outOfProcess.has(service)) want(service, why)
      if (wifiDeviceSaved(deps.dataDir, read)) ask('wifi', 'a paired Wi-Fi device')
      if (!outOfProcess.has('devices') || asked.has('devices') || deps.cableDisabled) return
      if (look()) ask('devices', 'a dial\'s port is there')
      else lookAgain()
    },
    /** A device, a pairing or a request needs this service (core/wifi.ts). */
    ask,
    /** The process connected: the master runs it, whoever asked (or it was named to start with the others). */
    connected(service: string): void {
      asked.add(service)
      if (service === 'devices') stopLooking()
    },
    stop: stopLooking,
  }
}

export type DevicesWake = ReturnType<typeof createDevicesWake>
