/**
 * Whether the process at the other end of a loopback TCP connection runs as this OS account.
 *
 * Any account can bind a free loopback port, so while the daemon or the bridge restarts another account (a Team
 * agent) can sit on its port and hear what clients send (audit H1, docs/security/2026-11-02-team-account-boundary.md).
 * A client that can only speak HTTP to a fixed address cannot avoid that: an MCP client's address carries its key, and
 * older clients send the local credential. So a secret heard must open nothing: the listeners also ask who is calling.
 *
 * Asked only after the secret matched, so a stranger cannot make the daemon spawn anything, and once per connection.
 * A lookup that fails answers no: this guards a credential, and a client refused can say so and retry.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'

export type PeerAccount = (socket: Socket) => Promise<boolean>

const LSOF_MS = 3_000

/** Linux: the row of /proc/net/tcp whose local end is the peer's and whose remote end is ours, and that row's uid. */
export function procNetOwner(table: string, peerPort: number, ownPort: number): number | null {
  const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0')
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields[1] === `0100007F:${hex(peerPort)}` && fields[2] === `0100007F:${hex(ownPort)}`) {
      const uid = Number(fields[7])
      return Number.isInteger(uid) ? uid : null
    }
  }
  return null
}

/**
 * macOS: whether `lsof -Fn` shows the client's end of the connection among this account's sockets. The daemon's own
 * end names the same two ports the other way round (`own->peer`), so only a line starting at the peer's port counts.
 */
export function lsofShowsPeer(output: string, peerPort: number, ownPort: number): boolean {
  return output.split('\n').some(line => /^n127\.0\.0\.1:(\d+)->127\.0\.0\.1:(\d+)$/.exec(line)?.slice(1).join() === `${peerPort},${ownPort}`)
}

function lsof(peerPort: number, ownPort: number, uid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', '-a', '-u', String(uid), `-iTCP@127.0.0.1:${peerPort}`, '-Fn'], { timeout: LSOF_MS }, (error, stdout) => {
      // lsof exits 1 when it found nothing: that is an answer, and its empty output says no.
      if (error && typeof error.code !== 'number') console.warn(`[peer] could not ask lsof who is calling: ${error.message}`)
      resolve(lsofShowsPeer(stdout ?? '', peerPort, ownPort))
    })
  })
}

async function ask(socket: Socket, platform: NodeJS.Platform): Promise<boolean> {
  const peerPort = socket.remotePort, ownPort = socket.localPort
  const uid = process.getuid?.()
  if (uid === undefined || !peerPort || !ownPort) return false
  // Both lookups below name 127.0.0.1 at both ends, which is what a client dialling this listener uses. All of 127/8 is
  // loopback, so another account can call from 127.0.0.2 on the same port number as a connection of this account's, and
  // would be read as that connection. Only an exact pair of addresses makes the pair of ports name one connection.
  if (socket.remoteAddress !== '127.0.0.1' || socket.localAddress !== '127.0.0.1') return false
  if (platform === 'linux') {
    try { return procNetOwner(await readFile('/proc/net/tcp', 'utf8'), peerPort, ownPort) === uid } catch { return false }
  }
  return lsof(peerPort, ownPort, uid)
}

/**
 * The addresses of a listener that keeps 127.0.0.1's port from being bound: 127.0.0.1 and any address, and for IPv6 the
 * same mapped, `::` and `::1`. Node's plain `listen(port)` is on `::`, dual-stack, and shows only in /proc/net/tcp6.
 */
const LISTENER_ADDRESSES = ['0100007F', '00000000', '00000000000000000000000000000000', '00000000000000000000000001000000',
  '0000000000000000FFFF00000100007F', '0000000000000000FFFF000000000000']

/** Linux: the owner of the listener on loopback [port] in /proc/net/tcp and tcp6's text, or null when none is listening. */
export function procNetListener(table: string, port: number): number | null {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  const holds = new Set(LISTENER_ADDRESSES.map(address => `${address}:${hex}`))
  for (const line of table.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] === '0A' && holds.has(fields[1] ?? '')) {
      const uid = Number(fields[7])
      return Number.isInteger(uid) ? uid : null
    }
  }
  return null
}

/**
 * Whether the process listening on loopback [port] runs as this account: null when that cannot be said (a listener gone
 * by now, a lookup that failed, Windows). macOS shows an account only its own sockets, so a port that is taken but not
 * among them is another account's.
 */
export async function portHolderIsThisAccount(port: number, platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  const uid = process.getuid?.()
  if (platform === 'win32' || uid === undefined) return null
  if (platform === 'linux') {
    // A kernel with no IPv6 has no tcp6, and /proc/net/tcp alone says who holds the port then.
    const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(file => readFile(file, 'utf8').catch(() => '')))
    const owner = procNetListener(tables.join('\n'), port)
    return owner === null ? null : owner === uid
  }
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', '-a', '-u', String(uid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], { timeout: LSOF_MS }, (error, stdout) => {
      if (error && typeof error.code !== 'number') { resolve(null); return }
      resolve(/^n/m.test(stdout ?? ''))
    })
  })
}

const answers = new WeakMap<Socket, Promise<boolean>>()

/** Windows reaches the daemon over its proven pipe and has neither lookup: its TCP rules are unchanged. */
export function peerIsThisAccount(socket: Socket, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'win32') return Promise.resolve(true)
  let answer = answers.get(socket)
  if (!answer) {
    answer = ask(socket, platform).then((yes) => {
      if (!yes) console.warn(`[peer] refused a valid secret on 127.0.0.1:${socket.localPort}: the caller is not this account`)
      return yes
    })
    answers.set(socket, answer)
  }
  return answer
}
