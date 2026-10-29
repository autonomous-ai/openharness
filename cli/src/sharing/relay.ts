import { WebSocket } from 'ws'
import { b64e, newEphemeral } from '../lib/e2ee/core.js'
import type { AuthSessionManager } from '../lib/authSession.js'
import type { Frame, LocalClientSink } from '../backendSocket.js'
import type { RelaySession } from '../lib/remoteRelay.js'
import { DAEMON_LOCAL_ONLY_TYPES } from '../lib/relayFrames.js'
import { recipientHandshake, type ObserverCipher } from './crypto.js'
import { BACKEND_IDLE_DEADLINE_MS, watchSocketLiveness } from '../lib/wsLiveness.js'
import { declaredClientQuery } from '../lib/declaredClient.js'

export interface SharedHarnessReference {
  id: string; agentId: string; name: string; engine: string | null; ownerPublicKey: string; expiresAt: string
}
export interface SharedMachineReference {
  machineId: string; name: string | null; ownerName: string; status: string; shares: SharedHarnessReference[]
}

export class SharingEndedError extends Error {}

/** How long the account's list of shares answers which windows may open before it is read again. Every window opened
 *  on a shared harness read the whole list first (WebSocket roadmap Phase 1 item 5). A share the list does not hold,
 *  or holds expired, is read again at once, and so is the list after any window failed to open: a new invitation
 *  opens at once, and the backend checks the share on every connect whatever the list said. */
const SHARES_LIST_MS = 60_000

/** One invitation per connection. Never promoted into a full machine link or a shared connection pool. */
export class HarnessShareRelay {
  private sessions = new Set<() => void>()
  private listed: { at: number; account: string; machines: SharedMachineReference[] } | null = null
  private reading: { account: string; machines: Promise<SharedMachineReference[]> } | null = null
  /** `account` names the sign-in the list is read for: a list read for another one answers nothing. */
  constructor(private readonly auth: Pick<AuthSessionManager, 'accessToken'>, private readonly backendWsBase: string,
    private readonly environment: string, private readonly discover: () => Promise<SharedMachineReference[]>,
    private readonly account: () => string) {}
  async acquire(machineId: string, shareId: string, sink: LocalClientSink,
    onClosed: (code: number, reason: string) => void): Promise<RelaySession> {
    const listed = this.listed && this.listed.account === this.account() && Date.now() - this.listed.at < SHARES_LIST_MS
      ? this.listed.machines : null
    const kept = this.find(listed, machineId, shareId)
    const share = kept && Date.parse(kept.expiresAt) > Date.now() ? kept : this.find(await this.read(), machineId, shareId)
    if (!share) throw new SharingEndedError('Sharing ended or invitation expired')
    const token = await this.auth.accessToken()
    const url = `${this.backendWsBase.replace(/\/$/, '')}/api/observer-ws?share=${encodeURIComponent(shareId)}&autonomousEnv=${encodeURIComponent(this.environment)}`
      + `&${declaredClientQuery('relay')}`
    const ws = new WebSocket(url, [token], { handshakeTimeout: 10_000, maxPayload: 3 * 1024 * 1024 })
    const ephemeral = newEphemeral()
    let cipher: ObserverCipher | null = null, detached = false, settled = false
    let heartbeat: ReturnType<typeof watchSocketLiveness> | null = null
    const detach = () => { detached = true; heartbeat?.stop(); this.sessions.delete(detach); ws.terminate() }
    const failed = () => { this.listed = null }
    this.sessions.add(detach)
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error('The owner’s machine is not responding.')); detach() }, 15_000)
        const ready = () => {
          settled = true; clearTimeout(timeout)
          sink.sendFrame({ type: 'connected', payload: { machineId, e2ee: false, readOnly: true } })
          resolve()
        }
        ws.on('error', () => { if (!settled) { clearTimeout(timeout); reject(new Error('Could not connect to the shared harness.')) } })
        ws.on('close', (code, reason) => {
          clearTimeout(timeout); heartbeat?.stop(); this.sessions.delete(detach)
          // Not opened, or no longer shared: whatever the list said of this share is in doubt.
          if (!settled || code === 4403) failed()
          if (!settled) reject(new Error(reason.toString() || 'The owner’s machine is offline.'))
          if (!detached) onClosed(code === 4403 ? 4403 : 1012, reason.toString() || 'Owner disconnected')
        })
        // Without onIdle this closed the shared harness as a bare `1012 Owner disconnected` with
        // nothing in the log to say the watcher was the one that gave up.
        ws.on('open', () => { heartbeat = watchSocketLiveness(ws, {
          onIdle: (idleMs) => console.log(`[sharing] ${machineId.slice(0, 8)} no traffic for ${Math.round(idleMs / 1000)}s — terminating`),
          onWake: (sleptMs, givingUp) => console.log(`[sharing] ${machineId.slice(0, 8)} woke after ${Math.round(sleptMs / 1000)}s asleep — ${givingUp ? 'giving up on the link' : 're-probing'}`),
          peerGivesUpAfterMs: BACKEND_IDLE_DEADLINE_MS,
        }) })
        ws.on('message', raw => {
          try {
            const frame = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> }
            if (frame.type === 'observer_connected') {
              ws.send(JSON.stringify({ type: 'observer_hello', payload: { ephemeral: b64e(ephemeral.pub) } }))
            } else if (frame.type === 'observer_welcome' && !cipher) {
              cipher = recipientHandshake(ephemeral, machineId, shareId, share.ownerPublicKey, frame.payload)
              ready()
            } else if (frame.type === 'observer_closed') {
              failed()
              onClosed(frame.payload?.retry === true ? 1012 : 4403, String(frame.payload?.reason || 'Sharing ended'))
              if (!settled) { clearTimeout(timeout); reject(new Error('Sharing ended')) }
              detach()
            } else if (frame.type === 'observer_frame' && cipher) {
              const clear = cipher.open(frame.payload)
              if (!clear) { onClosed(1011, 'Shared harness verification failed'); detach(); return }
              if (clear.type === 'observer_binary') {
                const bytes = (clear.payload as { bytes?: unknown })?.bytes
                if (typeof bytes === 'string') sink.sendBinary(Buffer.from(bytes, 'base64'))
              } else if (!(typeof clear.type === 'string' && DAEMON_LOCAL_ONLY_TYPES.has(clear.type))) sink.sendFrame(clear)
            }
          } catch {
            clearTimeout(timeout); failed()
            if (settled) onClosed(1011, 'The shared harness identity could not be verified.')
            reject(new Error('The shared harness identity could not be verified.')); detach()
          }
        })
      })
    } catch (error) { detach(); throw error }
    return {
      send: async (frame: Frame) => {
        if (!cipher || detached || ws.readyState !== WebSocket.OPEN) return
        // The owner repeats this check after decrypting. Restrict here too so a local client cannot
        // accidentally send terminal responses, resize events or pasted data into an observer stream.
        if (!['terminal_capabilities', 'terminal_open', 'terminal_alive', 'terminal_ack', 'terminal_resync',
          'terminal_close', 'observer_viewer', 'observer_comments', 'observer_comment_post', 'observer_comment_remove'].includes(String(frame.type))) {
          sink.sendFrame({ type: `${String(frame.type)}_result`, payload: {
            requestId: (frame.payload as { requestId?: unknown })?.requestId, error: 'VIEW_ONLY',
          } }); return
        }
        ws.send(JSON.stringify({ type: 'observer_frame', payload: cipher.seal(frame) }))
      },
      sendBinary: async () => { /* Observers never send terminal bytes. */ },
      detach,
    }
  }
  close(): void { for (const stop of [...this.sessions]) stop() }

  /** The share in `machines`, if it holds it. A kept list's share past its expiry is read again; a list just read is
   *  the backend's word, whatever this computer's clock says. */
  private find(machines: SharedMachineReference[] | null, machineId: string, shareId: string): SharedHarnessReference | undefined {
    return machines?.find(m => m.machineId === machineId)?.shares.find(s => s.id === shareId)
  }

  /** The list read now, once for every window of the same sign-in asking at the same time. A failed read is not
   *  kept, nor one that ends after the sign-in changed. */
  private read(): Promise<SharedMachineReference[]> {
    const account = this.account()
    if (this.reading?.account === account) return this.reading.machines
    const machines = this.discover().then((list) => {
      if (this.account() === account) this.listed = { at: Date.now(), account, machines: list }
      return list
    }).finally(() => { if (this.reading?.machines === machines) this.reading = null })
    this.reading = { account, machines }
    return machines
  }
}
