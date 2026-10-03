/**
 * Whether an HTTP request to one of the daemon's loopback servers was really addressed to it.
 *
 * Binding 127.0.0.1 keeps other machines out, not other ORIGINS: a web page that re-points its own
 * hostname at 127.0.0.1 reaches these ports as a same-origin page and reads whatever answers. What it
 * cannot do is change the Host its browser sends — that stays the page's own name — so a request is
 * served only when Host names this server, and a browser request only when its Origin is that name too.
 *
 * Every native caller (the desktop app, the CLI, engine hooks, store agents) sends a loopback Host and
 * no Origin; the dashboard sends its own loopback origin. Nothing legitimate is refused.
 */
import type { IncomingMessage } from 'http'

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]']

/** The `host:port` values that name a loopback server on `port` — the port it actually bound. */
export function loopbackHosts(port: number): Set<string> {
  return new Set(LOOPBACK_NAMES.map((name) => `${name}:${port}`))
}

export function isLoopbackRequest(req: IncomingMessage, hosts: ReadonlySet<string>): boolean {
  const host = req.headers.host?.toLowerCase()
  if (!host || !hosts.has(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://${host}`) return false
  // Defence in depth for browsers that omit Origin on a GET: they still say where the request began.
  return req.headers['sec-fetch-site'] !== 'cross-site'
}
