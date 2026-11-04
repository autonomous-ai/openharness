import tls, { type TLSSocket } from 'node:tls'

/**
 * A TURN-over-TLS failure must not take down the gateway.
 *
 * werift 0.24.4 dials `turns:` with `tls.connect` and then, in `StreamTransport.connect`
 * (`werift/lib/common/src/transport.js`), does `client.on("end", () => this.connect())`.
 * A peer that accepts TCP and drops it before the handshake emits `end` and then
 * `error`: Node's `ECONNRESET`, "Client network socket disconnected before secure TLS
 * connection was established", with `host` and `port`. The `end` handler replaces
 * `this.connecting` and dials again. The gatherer is awaiting the first promise, and
 * werift's `ice.ts` catches that rejection (`query TURN server`). Nothing awaits the
 * replacement, so the rejection is unhandled. Node reports it through
 * `node:internal/process/promises` `triggerUncaughtException` and the gateway process
 * exits. harnessd restarts it and, after repeated crashes, parks it. The encrypted
 * relay was never what failed.
 *
 * `pickTurnUrl` selects this dial when UDP did not answer. On the public list that
 * url is `turns:` port 443.
 *
 * The guard wraps `end` on that socket until `secureConnect`. The handshake error
 * stays on the promise werift already catches, gathering finishes with no relay
 * candidate, and the session stays on a direct pair when one exists. Otherwise the
 * negotiation fails and the terminal stays on the encrypted WebSocket relay. An
 * `end` after the handshake still reconnects.
 *
 * Wrapping the socket, rather than replacing `tls.connect`, is what reaches the
 * listener: werift calls whichever `tls.connect` it closed over. Patching werift is
 * not required. The library already catches the failed dial. The crash is only the
 * reconnect that this premature `end` starts.
 */
const endpoints = new Set<string>()
let installed = false

export function armTurnTls(turn: { url: string } | undefined): void {
  if (!turn) return
  const endpoint = turnsEndpoint(turn.url)
  if (!endpoint) return
  endpoints.add(endpointKey(endpoint.host, endpoint.port))
  install()
}

type SocketOn = (this: TLSSocket, event: string | symbol, listener: (...args: unknown[]) => void, ...rest: unknown[]) => TLSSocket

function install(): void {
  if (installed) return
  installed = true
  const originalOn = tls.TLSSocket.prototype.on as unknown as SocketOn
  const guardedOn: SocketOn = function guardedTurnTlsOn(event, listener, ...rest) {
    // Node's own onConnectEnd is registered before the connect options are visible.
    // Leaving it in place is what turns the close into the error werift already
    // catches. The listener added after that is the reconnect. `encrypted` cannot
    // tell these apart: it is true on every TLSSocket from the moment it exists.
    // getCipher() stays empty until the handshake finishes.
    if (event === 'end' && listener.name !== 'onConnectEnd' && isGuardedDial(this)) {
      let secure = this.getCipher() != null
      if (!secure) this.once('secureConnect', () => { secure = true })
      const afterHandshake = (...args: unknown[]): void => {
        if (!secure) return
        listener.apply(this, args)
      }
      return originalOn.call(this, event, afterHandshake, ...rest)
    }
    return originalOn.call(this, event, listener, ...rest)
  }
  tls.TLSSocket.prototype.on = guardedOn as typeof tls.TLSSocket.prototype.on
  tls.TLSSocket.prototype.addListener = guardedOn as typeof tls.TLSSocket.prototype.addListener
}

function isGuardedDial(socket: TLSSocket): boolean {
  const target = dialTarget(socket)
  return !!target && endpoints.has(endpointKey(target.host, target.port))
}

/** Node stores the `tls.connect` options on the socket under a symbol. That is the dial werift made. */
function dialTarget(socket: TLSSocket): { host: string; port: number } | null {
  for (const key of Object.getOwnPropertySymbols(socket)) {
    const value = (socket as unknown as Record<symbol, unknown>)[key]
    if (!value || typeof value !== 'object') continue
    const host = (value as { host?: unknown }).host
    const port = (value as { port?: unknown }).port
    if (typeof host === 'string' && host && typeof port === 'number' && Number.isInteger(port)) {
      return { host, port }
    }
  }
  return null
}

function endpointKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`
}

/**
 * Host and port werift passes to `tls.connect`. A `turns:` url with no port is 5349
 * (RFC 7065), which is werift's fallback too, so the guard matches the dial.
 */
function turnsEndpoint(url: string): { host: string; port: number } | null {
  const match = /^turns:(?:\/\/)?([^?]+)/i.exec(url.trim())
  if (!match) return null
  const authority = match[1]!
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end < 0) return null
    const host = authority.slice(1, end)
    return host ? { host, port: portAfter(authority.slice(end + 1)) } : null
  }
  const firstColon = authority.indexOf(':')
  const lastColon = authority.lastIndexOf(':')
  if (firstColon === -1 || firstColon !== lastColon) return authority ? { host: authority, port: 5349 } : null
  const host = authority.slice(0, firstColon)
  if (!host) return null
  return { host, port: portAfter(authority.slice(firstColon)) }
}

function portAfter(rest: string): number {
  const text = rest.startsWith(':') ? rest.slice(1) : rest
  if (!text) return 5349
  const port = Number.parseInt(text, 10)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 5349
}
