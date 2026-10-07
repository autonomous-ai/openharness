/**
 * The fleet's lane's sessions, held by the gateway (docs/design/2026-10-06-core-boundary-next.md, step 10,
 * R3). The lane (device/deviceLink.ts) is the daemon's socket to its owner's other machines on the dial's
 * behalf; it used to hold this machine's E2EE identity to seal what it sent them, and a service holds no
 * credential. The identity stays here with every other key: the lane asks for a session per machine,
 * and for each frame to be sealed or opened under it (`core.account.lane`, `LaneSeal`).
 *
 * The same sessions the lane ran itself (lib/e2ee/relayClient.ts), one per machine, keyed by its id: a
 * new hello replaces the machine's session, as the lane's own map did. No session, or one not yet up,
 * seals nothing: `lost`, never the frame as it came, so a frame for a linked machine is never sent in
 * the clear because the gateway restarted under the lane.
 */
import type { LaneOpened, LaneSeal, LaneSealed } from '../core/api.js'
import { b64d, type Identity } from '../lib/e2ee/core.js'
import { RelaySessionCrypto } from '../lib/e2ee/relayClient.js'

type Frame = Record<string, unknown>

export class LaneSessions implements LaneSeal {
  private readonly sessions = new Map<string, RelaySessionCrypto>()

  /** `identity` is read when a session starts: the one on disk, as the gateway's own store holds it. */
  constructor(private readonly identity: () => Identity) {}

  async hello(machineId: string, peerPub: string): Promise<Frame> {
    const session = new RelaySessionCrypto({ machineId, selfIdentity: this.identity(), peerPub: b64d(peerPub) })
    this.sessions.set(machineId, session)
    return session.helloFrame()
  }

  async welcome(machineId: string, payload: Frame): Promise<boolean> {
    return this.sessions.get(machineId)?.handleWelcome(payload) ?? false
  }

  async rekey(machineId: string, payload: Frame): Promise<void> {
    this.sessions.get(machineId)?.handleRekey(payload)
  }

  async seal(machineId: string, frame: Frame): Promise<LaneSealed> {
    const session = this.sessions.get(machineId)
    if (!session?.ready) return { lost: true }
    return { frame: session.wrapOutgoing(frame) }
  }

  async open(machineId: string, frame: Frame): Promise<LaneOpened> {
    const session = this.sessions.get(machineId)
    if (!session?.ready) return { lost: true }
    const plain = session.unwrapIncoming(frame)
    return plain ? { frame: plain } : { unreadable: true }
  }

  drop(machineId: string): void {
    this.sessions.delete(machineId)
  }

  /** The gateway is stopping: every session goes with it. */
  clear(): void {
    this.sessions.clear()
  }
}
