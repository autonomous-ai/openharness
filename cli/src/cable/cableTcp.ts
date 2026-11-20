/**
 * A device over TCP, for development alone (`HARNESS_CABLE_TCP`): a board on the desk's network, or a fake device on
 * this computer, carrying the frames a dial carries over USB (devices/harness-pro/docs/cable.md). Nothing on the
 * socket proves who listens at the address, so its session answers no permission prompt (cableSession.ts
 * `allowPermissions`), and the fleet keeps it out of everything that is about USB ports (cableFleet.ts `tcp`).
 * Only the devices' process reads the variable (services/devicesProcess.ts): it dials once that process runs for any of
 * its own reasons (core/devicesWake.ts: a dial's port, a Devices request, a paired Wi-Fi device). Nothing in the core
 * starts it for a device over TCP, as an experiment never touches the core.
 */
import type { CablePort, PortOpener } from './cableSession.js'
import { SerialLink } from './serial.js'

export interface CableTcpAddress {
  /** A name, an IPv4 address, or an IPv6 one without its brackets. */
  host: string
  port: number
}

/** `host:port`, or `[v6]:port`: a host is a name with no colon, and only brackets let an IPv6 one name its port. */
const ADDRESS = /^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]]+)):(\d{1,5})$/

/**
 * `HARNESS_CABLE_TCP`: `host:port` pairs, comma-separated, each kept once. What is not one is handed back as written,
 * for the log: a typo must be said, not dialed and not dropped unseen.
 */
export function parseCableTcp(value: string | undefined): { addresses: CableTcpAddress[]; rejected: string[] } {
  const addresses: CableTcpAddress[] = []
  const rejected: string[] = []
  const kept = new Set<string>()
  for (const entry of (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = ADDRESS.exec(entry)
    const port = Number(match?.[3])
    if (!match || port < 1 || port > 65_535) { rejected.push(entry); continue }
    const address = { host: match[1] ?? match[2], port }
    const path = tcpPortPath(address)
    if (kept.has(path)) continue
    kept.add(path)
    addresses.push(address)
  }
  return { addresses, rejected }
}

/**
 * TEMP (owner, 20 Nov): dev-only, remove before merging to main.
 * `HARNESS_CABLE_TCP_PERMISSIONS`: exactly `1` lets the devices over TCP answer permission prompts too, to try a bar's
 * approve on the desk's network. Nothing proves who listens at the address, so anyone who reaches it could approve.
 */
export function cableTcpPermissions(value: string | undefined): boolean {
  return value === '1'
}

/** The device's name as a port path, in the logs and as the fleet's key: no USB port is named `tcp:`. */
export function tcpPortPath(address: CableTcpAddress): string {
  return `tcp:${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`
}

export interface TcpOpenerOptions {
  log: (line: string) => void
  /** Opens the socket: `SerialLink.connect` unless a test gives its own. */
  connect?: (address: CableTcpAddress, onData: (chunk: Buffer) => void, onClosed: (why: string) => void) => Promise<CablePort>
  /** A monotonic clock in ms. */
  now?: () => number
  /** The wait after the first failure, doubled after each next one up to `maxMs`. */
  minMs?: number
  maxMs?: number
}

/**
 * The session's opener for one address. A closed session tries to open every two seconds (cableSession.ts `tryOpen`),
 * and logs each throw: a device that is off would be dialed, and logged, that often all day. So a failed connect is
 * no throw but no port (`null`), a wait that doubles up to `maxMs` and starts over once the device answers, and one
 * line per streak of failures.
 */
export function tcpOpener(address: CableTcpAddress, options: TcpOpenerOptions): PortOpener {
  const path = tcpPortPath(address)
  const connect = options.connect ?? ((at, onData, onClosed) => SerialLink.connect(path, at.host, at.port, onData, onClosed))
  const now = options.now ?? (() => performance.now())
  const minMs = options.minMs ?? 1_000
  const maxMs = options.maxMs ?? 30_000
  let waitMs = 0
  let notBefore = 0
  return async (onData, onClosed) => {
    if (waitMs > 0 && now() < notBefore) return null
    try {
      const port = await connect(address, onData, onClosed)
      if (waitMs > 0) options.log(`cable: ${path} is reachable again`)
      waitMs = 0
      return port
    } catch (error) {
      if (waitMs === 0) {
        const why = (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error))
        options.log(`cable: ${path} not reachable (${why}) — trying again, waiting up to ${maxMs / 1000} s`)
      }
      waitMs = waitMs === 0 ? minMs : Math.min(waitMs * 2, maxMs)
      notBefore = now() + waitMs
      return null
    }
  }
}
