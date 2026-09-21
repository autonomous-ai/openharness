// TCP CablePort. Same bytes as SerialLink; discovery is mDNS `_harness-dial._tcp`.
// Connecting is not authorization — CableSession only welcomes a MAC this computer USB-paired.
import { isIP } from 'node:net'
import { Socket } from 'node:net'
import Bonjour from 'bonjour-service'

export const DIAL_TCP_PORT = 17420
export const DIAL_MDNS_TYPE = 'harness-dial'

export interface DialTcp {
  host: string
  port: number
  name: string
}

export async function findDialTcp(browseMs = 1500): Promise<DialTcp | null> {
  const found = await new Promise<DialTcp[]>((resolve) => {
    const out: DialTcp[] = []
    let done = false
    const bonjour = new Bonjour({}, () => finish())
    const browser = bonjour.find({ type: DIAL_MDNS_TYPE, protocol: 'tcp' }, (service) => {
      const host = service.addresses?.find((a) => isIP(a) === 4) ?? service.host
      const port = service.port || DIAL_TCP_PORT
      if (host && port > 0) out.push({ host, port, name: service.name || host })
    })
    const timer = setTimeout(() => finish(), browseMs)
    function finish() {
      if (done) return
      done = true
      clearTimeout(timer)
      try { browser.stop() } catch { /* ignore */ }
      try { bonjour.destroy() } catch { /* ignore */ }
      resolve(out)
    }
  })
  return found[0] ?? null
}

export class TcpLink {
  readonly path: string
  private sock: Socket
  private closed = false
  private closePromise: Promise<void> | null = null
  private tail: Promise<void> = Promise.resolve()

  private constructor(
    host: string,
    port: number,
    sock: Socket,
    private readonly onClosed: (why: string) => void,
  ) {
    this.path = `tcp:${host}:${port}`
    this.sock = sock
  }

  static open(
    host: string,
    port: number,
    onData: (chunk: Buffer) => void,
    onClosed: (why: string) => void,
  ): Promise<TcpLink> {
    return new Promise((resolve, reject) => {
      const sock = new Socket()
      const link = new TcpLink(host, port, sock, onClosed)
      sock.setNoDelay(true)
      sock.once('error', reject)
      sock.connect(port, host, () => {
        sock.removeListener('error', reject)
        sock.on('data', (chunk) => {
          if (!link.closed) onData(Buffer.from(chunk))
        })
        sock.on('error', (err) => { void link.close(err.message) })
        sock.on('close', () => { if (!link.closed) void link.close('end of stream') })
        resolve(link)
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('port closed')
    const next = this.tail.then(() => this.writeFrame(bytes))
    this.tail = next.catch(() => {})
    return next
  }

  private writeFrame(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('port closed'))
        return
      }
      this.sock.write(Buffer.from(bytes), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  close(why = 'closed'): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = new Promise((resolve) => {
      this.sock.end(() => resolve())
      this.sock.destroy()
      resolve()
    }).then(() => this.onClosed(why))
    return this.closePromise
  }
}
