/**
 * Who each backend socket belongs to, how it ended and how long it lived, for the four sockets the apps and
 * daemons dial: web-ws, adapter-ws, observer-ws and agent-messages-ws (WebSocket roadmap, Phase 0).
 *
 * Prod, 2026-10-28: 8,760 web-ws connects in 45 minutes, 81% never selecting a machine, and the logs said only
 * who: not which client, how the socket closed, or how long it lived. Every tracked socket now logs a connect line
 * and a disconnect line with the same connId, and each pod logs its counts once a minute, with refusals (a socket
 * turned away before or right at its upgrade) apart from real connects.
 *
 * `pod` is the process, not the Kubernetes pod: the host name plus the cluster worker's index (`INSTANCE_ID`,
 * lib/instance.ts). Every worker logs its own counter line, so a pod's totals are the sum of its workers' lines,
 * and no line is counted twice.
 */
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { INSTANCE_ID } from './instance.js'
import { logger } from '../utils/logger.js'

export type WsEndpoint = 'web' | 'adapter' | 'observer' | 'agentMessages'
const ENDPOINTS: readonly WsEndpoint[] = ['web', 'adapter', 'observer', 'agentMessages']

/** What a client says it is (`?client=`): the browser, the phone, the desktop app dialling itself, a daemon's relay,
 *  the apps' one-shot trust-group and link sockets; `daemon` is the adapter's own socket. */
export const WS_CLIENT_KINDS = ['web', 'mobile', 'desktop', 'relay', 'group-sync', 'link', 'daemon'] as const
export type WsClientKind = typeof WS_CLIENT_KINDS[number] | 'unknown'

/** A socket that lived less than this counts as short: a refusal, a crash loop, or a dial nobody needed. */
const SHORT_MS = 2_000
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/
const REASON_MAX = 80

/** A close reason is the peer's own text (up to 123 bytes): plain characters only, one line, at most REASON_MAX. */
function plainReason(reason: string | undefined): string | undefined {
  const plain = reason
    ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^0-9A-Za-z .,:;_()'/+-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX)
  return plain || undefined
}

/** The client a socket's query declares, and its version (`?v=`; the phone's `?release=`, which it sent first). */
export function declaredKind(query: URLSearchParams): { client: WsClientKind; version: string | null } {
  const declared = query.get('client')
  const client = (WS_CLIENT_KINDS as readonly string[]).includes(declared ?? '') ? declared as WsClientKind : 'unknown'
  const version = query.get('v') ?? query.get('release')
  return { client, version: version && VERSION.test(version) ? version : null }
}

interface Counts { connects: Partial<Record<WsClientKind, number>>; short: number; refused: number }
const fresh = (): Counts => ({ connects: {}, short: 0, refused: 0 })
let open = Object.fromEntries(ENDPOINTS.map(e => [e, 0])) as Record<WsEndpoint, number>
let counts = Object.fromEntries(ENDPOINTS.map(e => [e, fresh()])) as Record<WsEndpoint, Counts>

/** Set on the raw socket once its `ws` socket is tracked: one that closes without it was refused. */
const TRACKED = Symbol('wsTracked')
type RawSocket = { [TRACKED]?: true; once(event: 'close', listener: () => void): unknown }
const rawOf = (ws: WebSocket): RawSocket | undefined => (ws as unknown as { _socket?: RawSocket })._socket

export interface TrackedSocket {
  readonly connId: string
  /** What a select was answered: `accepted`, or the refusal's code. The disconnect line reports the last. */
  selected(outcome: string): void
  /** The socket ended. Logs its disconnect line once, with what the endpoint adds. */
  closed(code: number | undefined, reason: string | undefined, extra?: Record<string, unknown>): void
}

/**
 * Starts tracking an accepted socket: logs `<label> connected` and counts it. `fields` are the client and version it
 * declared plus what the endpoint names it by (user, machine); they are repeated on the disconnect line.
 */
export function trackSocket(
  endpoint: WsEndpoint, label: string, ws: WebSocket,
  fields: { client: WsClientKind; version: string | null } & Record<string, unknown>,
  now: () => number = Date.now,
): TrackedSocket {
  const raw = rawOf(ws)
  if (raw) raw[TRACKED] = true
  const connId = randomUUID()
  const openedAt = now()
  const common = { endpoint, client: fields.client, version: fields.version, pod: INSTANCE_ID, connId }
  const { client: _client, version: _version, ...ids } = fields
  logger.info(`${label} connected`, { ...common, ...ids })
  open[endpoint]++
  const byClient = counts[endpoint].connects
  byClient[fields.client] = (byClient[fields.client] ?? 0) + 1
  let selects = 0
  let outcome = 'none'
  let ended = false
  return {
    connId,
    selected(result) { selects++; outcome = result },
    closed(code, reason, extra = {}) {
      if (ended) return
      ended = true
      const aliveMs = now() - openedAt
      open[endpoint]--
      if (aliveMs < SHORT_MS) counts[endpoint].short++
      const defined = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined))
      reason = plainReason(reason)
      logger.info(`${label} disconnected`, {
        ...common, ...ids, ...defined, ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}),
        aliveMs, selects, select: outcome,
      })
    },
  }
}

/** Watches a raw upgrade socket for `endpoint`: if it closes before its `ws` socket was tracked, it was refused. */
export function watchUpgrade(endpoint: WsEndpoint, socket: RawSocket): void {
  socket.once('close', () => { if (!socket[TRACKED]) counts[endpoint].refused++ })
}

/** A socket refused before anything could watch it (the server's handshake limit). */
export function refusedUpgrade(endpoint: WsEndpoint): void {
  counts[endpoint].refused++
}

/** The endpoint an upgrade's path names, or null for a socket these counters do not cover. */
export function endpointOf(path: string): WsEndpoint | null {
  switch (path) {
    case '/api/web-ws': return 'web'
    case '/api/adapter-ws': return 'adapter'
    case '/api/observer-ws': return 'observer'
    case '/api/agent-messages-ws': return 'agentMessages'
    default: return null
  }
}

/** This pod's counts since the last line, and its open sockets now. */
export function wsCounterLine(): Record<string, unknown> {
  const line: Record<string, unknown> = { pod: INSTANCE_ID }
  for (const endpoint of ENDPOINTS) {
    const c = counts[endpoint]
    const connects = Object.values(c.connects).reduce((sum, n) => sum + (n ?? 0), 0)
    line[endpoint] = { open: open[endpoint], connects, clients: c.connects, short: c.short, refused: c.refused }
    counts[endpoint] = fresh()
  }
  return line
}

/** Logs `ws counters` every `intervalMs`; returns its stop. */
export function startWsCounterLog(intervalMs = 60_000): () => void {
  const timer = setInterval(() => logger.info('ws counters', wsCounterLine()), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

export function resetWsCountersForTest(): void {
  open = Object.fromEntries(ENDPOINTS.map(e => [e, 0])) as Record<WsEndpoint, number>
  counts = Object.fromEntries(ENDPOINTS.map(e => [e, fresh()])) as Record<WsEndpoint, Counts>
}
