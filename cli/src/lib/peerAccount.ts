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
    if (fields[1]?.endsWith(`:${hex(peerPort)}`) && fields[2]?.endsWith(`:${hex(ownPort)}`)) {
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
  if (platform === 'linux') {
    try { return procNetOwner(await readFile('/proc/net/tcp', 'utf8'), peerPort, ownPort) === uid } catch { return false }
  }
  return lsof(peerPort, ownPort, uid)
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
