/**
 * The blind relay between daemons of different accounts in a shared tab
 * (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Messages across accounts").
 * It routes by shared tab and machine, stamps who sent each frame itself, and reads nothing else: frames are sealed
 * between machine keys the owner's roster lists, which this server never sees. Admission is coarse on purpose
 * (the account owns the machine and is the tab's owner or an accepted member); the roster is the authority.
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, type RawData } from 'ws'
import { createWss, WS_LIMITS } from './wsServer.js'
import { authenticateAccessToken, SsoAuthError } from './ssoAuth.js'
import { parseAutonomousEnvironment } from './autonomousEnvironment.js'
import { extractKey } from '../utils/crypto.js'
import { admits } from './agentMessageShares.js'
import { publishTabRelay, subscribeTabRelay, subscribeAgentMessageShareChanged } from './bus.js'
import { guardedSendJson } from './wsSend.js'
import { trackSocketLiveness } from './hub.js'
import { createOrderedInbox } from './orderedInbox.js'

const wss = createWss(WS_LIMITS.agentMessages, { echoFirstProtocol: true })
/** The daemons' one ceiling for a shared tab's frame (cli lib/e2ee/tabSession.ts `SHARED_TAB_FRAME_MAX`). */
const MAX_FRAME = 128 * 1024
const PER_SECOND = 20
const live = new Map<string, WebSocket>()

export function handleAgentMessagesUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  void (async () => {
    const token = extractKey(req)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const share = url.searchParams.get('share') ?? '', machine = url.searchParams.get('machine') ?? ''
    if (!token || !/^[a-f0-9]{24}$/.test(share) || !machine || machine.length > 128) { socket.destroy(); return }
    const env = parseAutonomousEnvironment(url.searchParams.get('autonomousEnv'))
    // A token that does not authenticate is answered as an HTTP status before the upgrade, never as 4403: the daemon
    // refreshes its token on a 401 and dials again, while 4403 tells it this machine is not in the tab and it stops
    // for good (cli/src/gateway/tabRelay.ts). Read as 4403, an expired token would
    // drop a member's machine from the tab until the daemon restarts.
    // Same answers as the adapter's socket (adapterWs.ts): 401 for the token, 403 for the wrong environment. An auth
    // service that is down drops the socket, which the daemon retries.
    let user: Awaited<ReturnType<typeof authenticateAccessToken>>
    try {
      user = await authenticateAccessToken(token, env, { allowHarnessSession: 'computer' })
    } catch (error) {
      if (!(error instanceof SsoAuthError) || error.code === 'AUTH_SERVICE_UNAVAILABLE') throw error
      if (!socket.destroyed) refuse(socket, error.code === 'INVALID_TOKEN' ? '401 Unauthorized' : '403 Forbidden')
      return
    }
    const allowed = await admits(user.sub, machine, share, env)
    if (socket.destroyed) return
    wss.handleUpgrade(req, socket, head, ws => {
      // 4403 is admission's answer alone: the account is not the tab's owner or an accepted member.
      if (!allowed) { ws.close(4403, 'Not in this shared tab'); return }
      void attach(ws, user.sub, share, machine, env).catch(() => ws.close(1013, 'Shared tab temporarily unavailable'))
    })
  })().catch(() => { if (!socket.destroyed) socket.destroy() })
}

/** An upgrade refused with an HTTP status, which the daemon's `ws` client reads as `unexpected-response`. */
function refuse(socket: Duplex, status: string): void {
  try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) } catch { /* ignore */ }
  socket.destroy()
}

async function attach(ws: WebSocket, userId: string, share: string, machine: string, env: ReturnType<typeof parseAutonomousEnvironment>) {
  const key = `${share}:${machine}`
  live.get(key)?.close(4409, 'Replaced by a newer connection')
  live.set(key, ws)
  const send = (frame: unknown) => guardedSendJson(ws, frame, 'must')
  const disposers: Array<() => void> = [trackSocketLiveness(ws, 'agentMessages')]
  let closed = false
  ws.once('close', () => { closed = true; if (live.get(key) === ws) live.delete(key); for (const d of disposers.splice(0)) d() })
  const keep = (dispose: () => void) => { if (closed) dispose(); else disposers.push(dispose) }
  const check = async () => {
    try { if (!await admits(userId, machine, share, env)) ws.close(4403, 'Not in this shared tab') }
    catch { ws.close(1013, 'Shared tab temporarily unavailable') }
  }
  // Every change to the tab is told (routes/agentMessages.ts `tell`); the minute's re-check covers the rest.
  const timer = setInterval(() => { void check() }, 60_000); timer.unref(); disposers.push(() => clearInterval(timer))
  keep(await subscribeAgentMessageShareChanged(share, () => { void check() }))
  keep(await subscribeTabRelay(share, machine, message => { if (!closed) send({ type: 'amsg_frame', ...(message as object) }) }))
  if (closed) return
  send({ type: 'amsg_ready' })
  let windowStart = Date.now(), count = 0
  const inbox = createOrderedInbox<RawData>(async (raw) => {
    if (closed) return
    let frame: { type?: string; to?: unknown; payload?: unknown }
    try { frame = JSON.parse(raw.toString()) } catch { ws.close(1008, 'Invalid shared tab message'); return }
    if (frame.type !== 'amsg_frame' || typeof frame.to !== 'string' || !frame.to || frame.to.length > 128
      || !frame.payload || typeof frame.payload !== 'object') { ws.close(1008, 'Invalid shared tab message'); return }
    const delivered = await publishTabRelay(share, frame.to, { from: { machineId: machine, userId }, payload: frame.payload })
    if (!delivered) send({ type: 'amsg_undeliverable', to: frame.to })
  }, () => ws.close(1013, 'Shared tab temporarily unavailable'), () => ws.close(1008, 'Too many shared tab messages'))
  // Counted as frames arrive, not as the queue reaches them: behind a slow publish, a count taken when each is handled
  // let a burst of up to the queue's 256 frames in before the rate saw any (review of Task 7, 2026-10-15).
  ws.on('message', (raw, binary) => {
    if (closed) return
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); count = 0 }
    const size = Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : (raw as Buffer).byteLength
    if (binary || size > MAX_FRAME || ++count > PER_SECOND) { ws.close(1008, 'Invalid shared tab message'); return }
    inbox.enqueue(raw)
  })
}
