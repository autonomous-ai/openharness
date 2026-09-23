import Bonjour from 'bonjour-service'
import { isIP } from 'node:net'
export interface DiscoveredDevice { id: string; name: string; host: string; port: number }
interface Mdns {
  query(query: unknown, callback: (error?: NodeJS.ErrnoException | null) => void): void
  on(event: 'error' | 'warning', listener: (error: NodeJS.ErrnoException) => void): void
}
/** The seam tests replace: a browser plus the multicast socket underneath it. */
export interface DiscoveryTransport {
  find(onService: (service: { fqdn?: string; name: string; host?: string; port: number; addresses?: string[] }) => void): void
  mdns: Mdns | null
  destroy(): void
}
/** macOS answers a multicast send with these when Local Network access is denied to the app that
 *  launched the daemon. The browser's own queries drop send errors, so without a probe of our own
 *  a refused network is indistinguishable from an empty one. */
const BLOCKED = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EPERM', 'EACCES'])
function bonjourTransport(onError: (error: Error) => void): DiscoveryTransport {
  const bonjour = new Bonjour({}, onError)
  let browser: { stop(): void } | undefined
  // `server.mdns` is private in the typings; a future version without it just loses the probe.
  const mdns = (bonjour as unknown as { server?: { mdns?: Mdns } }).server?.mdns ?? null
  return {
    find: onService => { browser = bonjour.find({ type: 'autonomous', protocol: 'tcp' }, onService) },
    mdns,
    destroy: () => { browser?.stop(); bonjour.destroy() },
  }
}
/** Reuse the OS's existing Avahi _autonomous._tcp advertisement. Discovery grants no trust. */
export function discoverDevices(durationMs = 3000, transport = bonjourTransport): Promise<DiscoveredDevice[]> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, DiscoveredDevice>()
    let done = false, blocked: string | undefined
    const noteBlocked = (error?: NodeJS.ErrnoException | null) => { if (error?.code && BLOCKED.has(error.code)) blocked ??= error.code }
    const t = transport(finish)
    // An unhandled 'error' on the socket (bind refused) would otherwise throw inside the daemon.
    t.mdns?.on('error', finish)
    t.mdns?.on('warning', noteBlocked)
    t.find(service => {
      const host = service.addresses?.find(a => isIP(a) === 4) ?? service.host
      if (service.fqdn && host && service.port > 0 && service.port <= 65535) found.set(service.fqdn, { id: service.fqdn, name: service.name, host, port: service.port })
    })
    t.mdns?.query({ questions: [{ name: '_autonomous._tcp.local', type: 'PTR' }] }, noteBlocked)
    const timer = setTimeout(() => finish(), durationMs)
    function finish(error?: NodeJS.ErrnoException) {
      if (done) return; done = true; clearTimeout(timer); t.destroy()
      noteBlocked(error)
      // Devices that answered prove the network works, whatever the probe said.
      if (found.size) resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)))
      else if (blocked) reject(Object.assign(new Error('Harness is not allowed to use the local network. Allow it in System Settings › Privacy & Security › Local Network.'), { code: 'LOCAL_NETWORK_BLOCKED' }))
      else if (error) reject(error)
      else resolve([])
    }
  })
}
