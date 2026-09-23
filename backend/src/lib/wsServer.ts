/**
 * One place to construct every `WebSocketServer` in the backend, so the edge limits live together:
 *
 *  - `maxPayload`: `ws` defaults to 100 MiB per message. Everything here parses the message with
 *    `JSON.parse(raw.toString())` on the event loop, so an authenticated client could stall a whole
 *    cluster worker (and allocate ~3× the frame in heap) with one oversized frame. Each endpoint gets
 *    the ceiling its real traffic needs (see WS_LIMITS); `ws` closes 1009 before we ever see the bytes.
 *  - `perMessageDeflate: false`: no zlib context per socket and no inflate amplification.
 *
 * Every server is registered so shutdown can drain them (`drainAllSockets`) — `noServer` sockets are
 * invisible to `http.Server#close`, which is why the old shutdown just let `process.exit` cut them.
 */
import { WebSocketServer } from 'ws'
import type { Socket } from 'net'

// A raw upgrade socket carries its pre-auth-slot release fn under this symbol (set in server.ts). createWss
// calls it on a successful upgrade so a completed handshake frees its slot immediately, rather than being
// held for the connection's lifetime or a fixed timeout.
export const RELEASE_UPGRADE_SLOT = Symbol('releaseUpgradeSlot')
export type SlotSocket = Socket & { [RELEASE_UPGRADE_SLOT]?: () => void }

export const WS_LIMITS = {
  /** Terminal envelopes are capped at 512 KiB (terminalRelay); chat/RPC frames are far smaller. */
  web: 1024 * 1024,
  /** PCM chunks are ~640 B (20 ms @ 16 kHz); device JSON RPCs are tiny. */
  device: 256 * 1024,
  /** App-proxy frames ride these sockets: 8 MiB of body → ~11.2 MiB once base64'd into JSON. */
  manager: 16 * 1024 * 1024,
  adapter: 16 * 1024 * 1024,
} as const

const servers = new Set<WebSocketServer>()

export interface CreateWssOptions {
  /** Echo the first offered subprotocol (the credential) so browsers / the ESP client accept the handshake. */
  echoFirstProtocol?: boolean
}

export function createWss(maxPayload: number, opts: CreateWssOptions = {}): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload,
    perMessageDeflate: false,
    ...(opts.echoFirstProtocol
      ? { handleProtocols: (protocols: Set<string>) => [...protocols][0] ?? false }
      : {}),
  })
  // A successful upgrade means the pre-auth phase is over (the 101 was sent) → free its slot now. Sockets
  // not created through server.ts's upgrade cap (e.g. the app-proxy) simply carry no release fn.
  wss.on('connection', (ws) => {
    const raw = (ws as unknown as { _socket?: SlotSocket })._socket
    raw?.[RELEASE_UPGRADE_SLOT]?.()
  })
  servers.add(wss)
  return wss
}

/** Number of open sockets across every server — for shutdown logging / diagnostics. */
export function openSocketCount(): number {
  let n = 0
  for (const wss of servers) n += wss.clients.size
  return n
}

/**
 * Politely close every socket (1012 = "service restart": clients reconnect with backoff instead of
 * treating it as an error), give the close handshake `graceMs`, then terminate whatever is left so a
 * half-open peer cannot hold the process past PM2's kill_timeout. Per-socket 'close' handlers run as
 * usual, which is what clears presence / owner keys before exit.
 */
export async function drainAllSockets(graceMs = 4_000): Promise<void> {
  for (const wss of servers) {
    for (const client of wss.clients) {
      try { client.close(1012, 'server restart') } catch { /* ignore */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs))
  for (const wss of servers) {
    for (const client of wss.clients) {
      try { client.terminate() } catch { /* ignore */ }
    }
  }
}

const UPGRADE_STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  429: 'Too Many Requests', 503: 'Service Unavailable',
}

/** Reason phrase for a refused upgrade. Clients key off the number; this is for whoever reads a capture. */
export function upgradeStatusText(status: number): string {
  return UPGRADE_STATUS_TEXT[status] ?? 'Service Unavailable'
}
